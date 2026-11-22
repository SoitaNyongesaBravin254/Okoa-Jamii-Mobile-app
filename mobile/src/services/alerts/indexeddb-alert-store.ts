/**
 * IndexedDB-backed alert store for Expo Web.
 *
 * Why this exists: `expo-sqlite`'s web build loads a WebAssembly SQLite
 * worker that Metro cannot resolve without extra configuration, and that path
 * also expects `SharedArrayBuffer` with cross-origin isolation (COOP/COEP).
 * Web therefore uses IndexedDB instead, behind the same repository contract.
 *
 * Guarantees:
 *  - Alerts are written/read as whole records; writes fail loudly, never
 *    silently, and there is no in-memory fallback.
 *  - `update` performs read + validate + write inside a single `readwrite`
 *    transaction, so a status change cannot race with another one.
 *  - Stored records are validated on read; a malformed record raises
 *    `AlertStorageError` instead of being returned as a wrong alert.
 *  - Only alert fields are stored. No tokens, sessions or credentials.
 */

import { AlertStorageError } from './alert-errors';
import {
  isAlertCategory,
  isAlertDeliveryStatus,
  isCanonicalUtcTimestamp,
  isLocationUnavailableReason,
  isValidAlertId,
  isValidCoordinates,
} from './alert-model';
import type { AlertStore } from './web-alert-store';
import type { AlertLocation, AlertRecord } from '@/types/alert';

export const WEB_DATABASE_NAME = 'okoa-jamii';
const STORE_NAME = 'alerts';
const DATABASE_VERSION = 1;

function invalidRecord(): AlertStorageError {
  return new AlertStorageError('stored alert record failed validation');
}

function toStorageError(message: string, cause: unknown): AlertStorageError {
  return cause instanceof AlertStorageError
    ? cause
    : new AlertStorageError(message, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStoredLocation(value: unknown): AlertLocation {
  if (!isRecord(value)) {
    throw invalidRecord();
  }

  if (value.state === 'available') {
    const { latitude, longitude, accuracyMeters } = value;
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      !isValidCoordinates(latitude, longitude) ||
      (accuracyMeters !== null &&
        (typeof accuracyMeters !== 'number' ||
          !Number.isFinite(accuracyMeters) ||
          accuracyMeters < 0))
    ) {
      throw invalidRecord();
    }
    return {
      state: 'available',
      latitude,
      longitude,
      accuracyMeters: accuracyMeters as number | null,
    };
  }

  if (value.state === 'unavailable') {
    const { reason, latitude, longitude } = value;
    if (
      !isLocationUnavailableReason(reason) ||
      (latitude !== null && latitude !== undefined) ||
      (longitude !== null && longitude !== undefined)
    ) {
      throw invalidRecord();
    }
    return { state: 'unavailable', reason };
  }

  throw invalidRecord();
}

/** Strictly validates a stored record; unknown/extra fields are discarded. */
export function parseStoredAlert(value: unknown): AlertRecord {
  if (!isRecord(value)) {
    throw invalidRecord();
  }

  const {
    id,
    createdAtUtc,
    category,
    status,
    location,
    serverReceipt,
    retryCount,
    updatedAtUtc,
  } = value;

  if (
    typeof id !== 'string' ||
    !isValidAlertId(id) ||
    typeof createdAtUtc !== 'string' ||
    !isCanonicalUtcTimestamp(createdAtUtc) ||
    !isAlertCategory(category) ||
    !isAlertDeliveryStatus(status) ||
    (serverReceipt !== null && typeof serverReceipt !== 'string') ||
    typeof retryCount !== 'number' ||
    !Number.isInteger(retryCount) ||
    retryCount < 0 ||
    typeof updatedAtUtc !== 'string' ||
    !isCanonicalUtcTimestamp(updatedAtUtc)
  ) {
    throw invalidRecord();
  }

  // Mirrors the SQLite trigger: a `sent` alert always carries a receipt.
  if (status === 'sent' && (serverReceipt === null || serverReceipt.trim().length === 0)) {
    throw invalidRecord();
  }

  return {
    id,
    createdAtUtc,
    category,
    status,
    location: parseStoredLocation(location),
    serverReceipt,
    retryCount,
    updatedAtUtc,
  };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new AlertStorageError('browser alert storage request failed', {
          cause: request.error,
        }),
      );
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new AlertStorageError('browser alert storage is unavailable on this platform'),
    );
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(WEB_DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        // A later success after an onblocked rejection: do not leak the handle.
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => db.close();
      resolve(db);
    };

    request.onerror = () => {
      settled = true;
      reject(
        new AlertStorageError('failed to open browser alert storage', {
          cause: request.error,
        }),
      );
    };

    request.onblocked = () => {
      settled = true;
      reject(new AlertStorageError('browser alert storage is blocked by another tab'));
    };
  });
}

export class IndexedDbAlertStore implements AlertStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  ensureOpen(): Promise<void> {
    return this.getDatabase().then(() => undefined);
  }

  private getDatabase(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDatabase().catch((error: unknown) => {
        // A failed open must not poison every later attempt.
        this.dbPromise = null;
        throw toStorageError('failed to open browser alert storage', error);
      });
    }
    return this.dbPromise;
  }

  /**
   * Runs `task` inside one transaction. The task must not await anything
   * outside IndexedDB (that would let the transaction auto-commit early).
   */
  private async transact<T>(
    mode: IDBTransactionMode,
    task: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await this.getDatabase();

    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(STORE_NAME, mode);
      } catch (error) {
        // The connection was closed by the browser (e.g. version change).
        this.dbPromise = null;
        reject(toStorageError('browser alert storage is unavailable', error));
        return;
      }

      const objectStore = transaction.objectStore(STORE_NAME);
      let result: T;
      let failure: unknown;
      let failed = false;
      let settled = false;

      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        action();
      };

      transaction.oncomplete = () =>
        settle(() => {
          if (failed) {
            reject(toStorageError('browser alert storage write failed', failure));
          } else {
            resolve(result);
          }
        });

      transaction.onerror = () =>
        settle(() =>
          reject(
            toStorageError(
              'browser alert storage write failed',
              failed ? failure : transaction.error,
            ),
          ),
        );

      transaction.onabort = () =>
        settle(() =>
          reject(
            toStorageError(
              'browser alert storage transaction was aborted',
              failed ? failure : transaction.error,
            ),
          ),
        );

      Promise.resolve()
        .then(() => task(objectStore))
        .then(
          (value) => {
            result = value;
          },
          (error: unknown) => {
            failed = true;
            failure = error;
            try {
              transaction.abort();
            } catch {
              // The transaction already finished; surface the task error now.
              settle(() => reject(toStorageError('browser alert storage write failed', error)));
            }
          },
        );
    });
  }

  async list(): Promise<AlertRecord[]> {
    const rows = await this.transact('readonly', (store) =>
      requestToPromise<unknown[]>(store.getAll()),
    );
    return rows.map(parseStoredAlert);
  }

  async get(id: string): Promise<AlertRecord | null> {
    const row = await this.transact('readonly', (store) =>
      requestToPromise<unknown>(store.get(id)),
    );
    return row === undefined ? null : parseStoredAlert(row);
  }

  async add(alert: AlertRecord): Promise<void> {
    // `add` (not `put`) refuses to overwrite an existing id, matching the
    // SQLite primary-key constraint.
    await this.transact('readwrite', (store) =>
      requestToPromise<IDBValidKey>(store.add(alert)),
    );
  }

  async update(
    id: string,
    apply: (current: AlertRecord | null) => AlertRecord,
  ): Promise<AlertRecord> {
    let updated: AlertRecord | null = null;

    await this.transact('readwrite', async (store) => {
      const row = await requestToPromise<unknown>(store.get(id));
      const current = row === undefined ? null : parseStoredAlert(row);
      const next = apply(current);
      // Re-validate so a corrupt mutation can never be persisted.
      const validated = parseStoredAlert(next);
      await requestToPromise<IDBValidKey>(store.put(validated));
      updated = validated;
    });

    if (updated === null) {
      throw new AlertStorageError('alert status update did not persist');
    }
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    let existed = false;

    await this.transact('readwrite', async (store) => {
      const row = await requestToPromise<unknown>(store.get(id));
      if (row === undefined) {
        return;
      }
      await requestToPromise<undefined>(store.delete(id));
      existed = true;
    });

    return existed;
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const pending = this.dbPromise;
    this.dbPromise = null;
    try {
      const db = await pending;
      db.close();
    } catch {
      // Closing an unusable connection is not an app-level failure.
    }
  }
}
