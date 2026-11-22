/**
 * Browser alert repository (IndexedDB) implementing the same contract as the
 * native SQLite repository.
 *
 * Domain rules are shared with native (`alert-model.ts`): new alerts are
 * always `pending` with no receipt, only validated transitions are allowed,
 * `sent` requires a real server receipt, and pending ordering is oldest
 * first. Storage failures surface as `AlertStorageError`; an alert is never
 * reported as saved unless the write completed.
 */

import { AlertNotFoundError, AlertStorageError, AlertValidationError } from './alert-errors';
import {
  assertStatusTransition,
  createAlertRecord,
  isAlertDeliveryStatus,
  isValidAlertId,
  requireServerReceipt,
} from './alert-model';
import type { AlertRepository, UpdateStatusOptions } from './alert-repository';
import type { AlertStore } from './web-alert-store';
import type { AlertDeliveryStatus, AlertRecord, NewAlertInput } from '@/types/alert';

/** Newest first, matching the native `ORDER BY created_at_utc DESC, id DESC`. */
function compareNewestFirst(a: AlertRecord, b: AlertRecord): number {
  if (a.createdAtUtc !== b.createdAtUtc) return a.createdAtUtc < b.createdAtUtc ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** Oldest first, matching the native `ORDER BY created_at_utc ASC, id ASC`. */
function compareOldestFirst(a: AlertRecord, b: AlertRecord): number {
  if (a.createdAtUtc !== b.createdAtUtc) return a.createdAtUtc < b.createdAtUtc ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function wrapStorageError(message: string, error: unknown): AlertStorageError {
  // Preserve domain errors (validation/not-found) as-is.
  if (error instanceof AlertStorageError) {
    return error;
  }
  // The generic message avoids echoing alert content.
  return new AlertStorageError(message, { cause: error });
}

export class WebAlertRepository implements AlertRepository {
  private initPromise: Promise<void> | null = null;

  constructor(private readonly db: AlertStore) {}

  initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.db.ensureOpen().catch((error: unknown) => {
        this.initPromise = null;
        throw wrapStorageError('failed to initialize browser alert storage', error);
      });
    }
    return this.initPromise;
  }

  /** Validates and persists a new alert. Always stored as `pending`. */
  async createAlert(input: NewAlertInput): Promise<AlertRecord> {
    await this.initialize();
    const alert = createAlertRecord(input);
    try {
      await this.db.add(alert);
      return alert;
    } catch (error) {
      throw wrapStorageError('failed to persist alert', error);
    }
  }

  /** All alerts, newest first. */
  async listAlerts(): Promise<AlertRecord[]> {
    await this.initialize();
    try {
      const alerts = await this.db.list();
      return [...alerts].sort(compareNewestFirst);
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
      return await this.db.get(id);
    } catch (error) {
      throw wrapStorageError('failed to read alert', error);
    }
  }

  /** Sync-queue view: only `pending` alerts, oldest first. */
  async listPendingAlerts(): Promise<AlertRecord[]> {
    await this.initialize();
    try {
      const alerts = await this.db.list();
      return alerts.filter((alert) => alert.status === 'pending').sort(compareOldestFirst);
    } catch (error) {
      throw wrapStorageError('failed to list pending alerts', error);
    }
  }

  /**
   * Applies a validated status transition atomically. `sent` requires a
   * server receipt (never faked); `failed -> pending` increments the retry
   * count. The read/validate/write runs inside one store transaction.
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
      return await this.db.update(id, (current) => {
        if (!current) {
          throw new AlertNotFoundError('no stored alert matches that id');
        }
        assertStatusTransition(current.status, nextStatus);

        const serverReceipt =
          nextStatus === 'sent'
            ? requireServerReceipt(options?.serverReceipt)
            : current.serverReceipt;
        const retryCount =
          nextStatus === 'pending' && current.status === 'failed'
            ? current.retryCount + 1
            : current.retryCount;

        return {
          ...current,
          status: nextStatus,
          serverReceipt,
          retryCount,
          updatedAtUtc: new Date().toISOString(),
        };
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
      return await this.db.remove(id);
    } catch (error) {
      throw wrapStorageError('failed to delete alert', error);
    }
  }

  /** Closes the underlying storage connection. */
  async close(): Promise<void> {
    await this.db.close();
  }
}
