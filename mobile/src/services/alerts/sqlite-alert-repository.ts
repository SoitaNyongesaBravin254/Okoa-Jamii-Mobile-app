/**
 * SQLite repository for emergency alerts.
 *
 * Responsibilities: schema creation/migrations, validated CRUD, and status
 * transitions. All SQL is parameterized; persistence details never leak into
 * screens. Every failure surfaces as an AlertStorageError subclass — a failed
 * write is never reported as success, and an alert is only ever `pending`
 * when first stored (local persistence is NOT delivery).
 */

import { AlertNotFoundError, AlertStorageError, AlertValidationError } from './alert-errors';
import {
  ALERT_COLUMNS,
  INSERT_ALERT_SQL,
  insertAlertParams,
  rowToAlert,
  type AlertRow,
} from './alert-mapper';
import {
  assertStatusTransition,
  createAlertRecord,
  isAlertDeliveryStatus,
  isValidAlertId,
  requireServerReceipt,
} from './alert-model';
import type { AlertRepository, UpdateStatusOptions } from './alert-repository';
import type { SqlDriver, SqlValue } from './sql-driver';
import type { AlertDeliveryStatus, AlertRecord, NewAlertInput } from '@/types/alert';

export type { UpdateStatusOptions } from './alert-repository';

/** Schema migrations, applied in order under `PRAGMA user_version`. */
export const MIGRATIONS: readonly { version: number; statements: readonly string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY NOT NULL,
        created_at_utc TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        location_state TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        location_accuracy REAL,
        location_unavailable_reason TEXT,
        server_receipt TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        updated_at_utc TEXT NOT NULL
      )`,
      // Guards enforced by SQLite itself, independent of the TS layer.
      `CREATE TRIGGER IF NOT EXISTS alerts_valid_insert BEFORE INSERT ON alerts
       BEGIN
         SELECT CASE
           WHEN NEW.status NOT IN ('pending', 'sent', 'failed')
             THEN RAISE(ABORT, 'invalid status')
           WHEN NEW.location_state NOT IN ('available', 'unavailable')
             THEN RAISE(ABORT, 'invalid location_state')
           WHEN NEW.latitude IS NOT NULL AND (NEW.latitude < -90 OR NEW.latitude > 90)
             THEN RAISE(ABORT, 'latitude out of range')
           WHEN NEW.longitude IS NOT NULL AND (NEW.longitude < -180 OR NEW.longitude > 180)
             THEN RAISE(ABORT, 'longitude out of range')
           WHEN NEW.location_state = 'available' AND (NEW.latitude IS NULL OR NEW.longitude IS NULL)
             THEN RAISE(ABORT, 'available location requires coordinates')
           WHEN NEW.location_state = 'unavailable' AND (NEW.latitude IS NOT NULL OR NEW.longitude IS NOT NULL)
             THEN RAISE(ABORT, 'unavailable location must not carry coordinates')
           WHEN NEW.status = 'sent' AND (NEW.server_receipt IS NULL OR TRIM(NEW.server_receipt) = '')
             THEN RAISE(ABORT, 'sent requires server receipt')
         END;
       END`,
      `CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts (created_at_utc)`,
      `CREATE INDEX IF NOT EXISTS idx_alerts_status_created_at ON alerts (status, created_at_utc)`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export class SqliteAlertRepository implements AlertRepository {
  private initPromise: Promise<void> | null = null;

  constructor(private readonly db: SqlDriver) {}

  /**
   * Opens/migrates the schema. Safe to call repeatedly and concurrently:
   * concurrent callers await the same promise; a failed initialization can be
   * retried (the promise is cleared on failure).
   */
  initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.runMigrations().catch((error: unknown) => {
        this.initPromise = null;
        throw wrapStorageError('failed to initialize alert database', error);
      });
    }
    return this.initPromise;
  }

  private async runMigrations(): Promise<void> {
    const current = await this.readSchemaVersion();
    if (current > LATEST_SCHEMA_VERSION) {
      throw new AlertStorageError(
        `database schema version ${current} is newer than supported version ${LATEST_SCHEMA_VERSION}`,
      );
    }
    if (current === LATEST_SCHEMA_VERSION) {
      return;
    }

    await this.db.withTransactionAsync(async () => {
      // Re-read inside the transaction so concurrent initializers cannot
      // apply the same migration twice.
      let version = await this.readSchemaVersion();
      for (const migration of MIGRATIONS) {
        if (version >= migration.version) continue;
        for (const statement of migration.statements) {
          await this.db.execAsync(statement);
        }
        // PRAGMA cannot be parameterized; the value is a validated integer.
        await this.db.execAsync(`PRAGMA user_version = ${migration.version}`);
        version = migration.version;
      }
    });
  }

  private async readSchemaVersion(): Promise<number> {
    const row = await this.db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    const version = row?.user_version ?? 0;
    if (!Number.isInteger(version) || version < 0) {
      throw new AlertStorageError('database schema version is invalid');
    }
    return version;
  }

  /** Validates and persists a new alert. Always stored as `pending`. */
  async createAlert(input: NewAlertInput): Promise<AlertRecord> {
    await this.initialize();
    const alert = createAlertRecord(input);
    try {
      const result = await this.db.runAsync(INSERT_ALERT_SQL, insertAlertParams(alert));
      if (result.changes !== 1) {
        throw new AlertStorageError('alert insert did not persist');
      }
      return alert;
    } catch (error) {
      throw wrapStorageError('failed to persist alert', error);
    }
  }

  /** All alerts, newest first. */
  async listAlerts(): Promise<AlertRecord[]> {
    await this.initialize();
    try {
      const rows = await this.db.getAllAsync<AlertRow>(
        `SELECT ${ALERT_COLUMNS} FROM alerts ORDER BY created_at_utc DESC, id DESC`,
      );
      return rows.map(rowToAlert);
    } catch (error) {
      throw wrapStorageError('failed to list alerts', error);
    }
  }

  /** Returns null when the id is unknown or invalid. */
  async getAlertById(id: string): Promise<AlertRecord | null> {
    await this.initialize();
    if (!isValidAlertId(id)) {
      throw new AlertValidationError('alert id is invalid');
    }
    try {
      const row = await this.db.getFirstAsync<AlertRow>(
        `SELECT ${ALERT_COLUMNS} FROM alerts WHERE id = ?`,
        [id],
      );
      return row ? rowToAlert(row) : null;
    } catch (error) {
      throw wrapStorageError('failed to read alert', error);
    }
  }

  /** Sync-queue view: only `pending` alerts, oldest first. */
  async listPendingAlerts(): Promise<AlertRecord[]> {
    await this.initialize();
    try {
      const rows = await this.db.getAllAsync<AlertRow>(
        `SELECT ${ALERT_COLUMNS} FROM alerts WHERE status = 'pending' ORDER BY created_at_utc ASC, id ASC`,
      );
      return rows.map(rowToAlert);
    } catch (error) {
      throw wrapStorageError('failed to list pending alerts', error);
    }
  }

  /**
   * Applies a validated status transition atomically.
   * `sent` requires a server receipt (never faked); `failed -> pending`
   * re-queues the alert and increments its retry count.
   */
  async updateStatus(
    id: string,
    nextStatus: AlertDeliveryStatus,
    options?: UpdateStatusOptions,
  ): Promise<AlertRecord> {
    await this.initialize();
    if (!isValidAlertId(id)) {
      throw new AlertValidationError('alert id is invalid');
    }
    if (!isAlertDeliveryStatus(nextStatus)) {
      throw new AlertValidationError('alert status is invalid');
    }

    try {
      return await this.db.withTransactionAsync(async () => {
        const row = await this.db.getFirstAsync<AlertRow>(
          `SELECT ${ALERT_COLUMNS} FROM alerts WHERE id = ?`,
          [id],
        );
        if (!row) {
          throw new AlertNotFoundError('no stored alert matches that id');
        }
        const current = rowToAlert(row);
        assertStatusTransition(current.status, nextStatus);

        const serverReceipt =
          nextStatus === 'sent'
            ? requireServerReceipt(options?.serverReceipt)
            : current.serverReceipt;
        const retryCount =
          nextStatus === 'pending' && current.status === 'failed'
            ? current.retryCount + 1
            : current.retryCount;
        const updatedAtUtc = new Date().toISOString();

        const result = await this.db.runAsync(
          `UPDATE alerts SET status = ?, server_receipt = ?, retry_count = ?, updated_at_utc = ?
           WHERE id = ? AND status = ?`,
          [nextStatus, serverReceipt, retryCount, updatedAtUtc, id, current.status],
        );
        if (result.changes !== 1) {
          throw new AlertStorageError('alert status update did not apply');
        }
        return { ...current, status: nextStatus, serverReceipt, retryCount, updatedAtUtc };
      });
    } catch (error) {
      throw wrapStorageError('failed to update alert status', error);
    }
  }

  /** Explicit deletion of a single alert. Returns false when nothing matched. */
  async deleteAlert(id: string): Promise<boolean> {
    await this.initialize();
    if (!isValidAlertId(id)) {
      throw new AlertValidationError('alert id is invalid');
    }
    try {
      const result = await this.db.runAsync('DELETE FROM alerts WHERE id = ?', [id] satisfies SqlValue[]);
      return result.changes === 1;
    } catch (error) {
      throw wrapStorageError('failed to delete alert', error);
    }
  }

  /** Closes the underlying database connection. */
  close(): Promise<void> {
    return this.db.closeAsync();
  }
}

function wrapStorageError(message: string, error: unknown): AlertStorageError {
  // Preserve domain errors (validation/not-found) as-is.
  if (error instanceof AlertStorageError) {
    return error;
  }
  // The generic message avoids echoing SQL parameters or row content.
  return new AlertStorageError(message, { cause: error });
}
