import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseStoredAlert } from '../indexeddb-alert-store';
import { AlertNotFoundError, AlertStorageError, AlertValidationError } from '../alert-errors';
import { WebAlertRepository } from '../web-alert-repository';
import type { AlertStore } from '../web-alert-store';
import type { AlertLocation, AlertRecord } from '@/types/alert';

/**
 * Tests for the browser alert repository. IndexedDB itself is a browser API,
 * so the repository is exercised through an in-memory store that honours the
 * same contract (add refuses duplicates, update applies atomically).
 */

const UNAVAILABLE_LOCATION: AlertLocation = { state: 'unavailable', reason: 'timeout' };

class MemoryAlertStore implements AlertStore {
  readonly records = new Map<string, AlertRecord>();
  failWrites = false;

  async ensureOpen(): Promise<void> {}

  async list(): Promise<AlertRecord[]> {
    return [...this.records.values()];
  }

  async get(id: string): Promise<AlertRecord | null> {
    return this.records.get(id) ?? null;
  }

  async add(alert: AlertRecord): Promise<void> {
    if (this.failWrites) throw new AlertStorageError('simulated write failure');
    if (this.records.has(alert.id)) throw new AlertStorageError('simulated duplicate id');
    this.records.set(alert.id, alert);
  }

  async update(
    id: string,
    apply: (current: AlertRecord | null) => AlertRecord,
  ): Promise<AlertRecord> {
    if (this.failWrites) throw new AlertStorageError('simulated write failure');
    const current = this.records.get(id) ?? null;
    // Apply before writing so a thrown validation error leaves storage intact.
    const next = apply(current);
    this.records.set(id, next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async close(): Promise<void> {}
}

function createRepo(): { repo: WebAlertRepository; store: MemoryAlertStore } {
  const store = new MemoryAlertStore();
  return { repo: new WebAlertRepository(store), store };
}

async function addAlert(
  repo: WebAlertRepository,
  createdAtUtc: string,
  category: 'security' | 'medical' | 'other' = 'other',
): Promise<AlertRecord> {
  return repo.createAlert({ category, location: UNAVAILABLE_LOCATION, createdAtUtc });
}

test('createAlert stores a pending alert with a stable id and no receipt', async () => {
  const { repo, store } = createRepo();
  const created = await addAlert(repo, '2026-10-14T09:00:00.000Z');

  assert.match(created.id, /^alert_/);
  assert.equal(created.status, 'pending');
  assert.equal(created.serverReceipt, null);
  assert.equal(created.retryCount, 0);
  assert.deepEqual(created.location, UNAVAILABLE_LOCATION);

  const stored = await repo.getAlertById(created.id);
  assert.deepEqual(stored, created);
  assert.equal(store.records.size, 1);
});

test('listAlerts is newest-first and listPendingAlerts is oldest-first', async () => {
  const { repo } = createRepo();
  const first = await addAlert(repo, '2026-10-14T09:00:00.000Z', 'security');
  const second = await addAlert(repo, '2026-10-14T10:00:00.000Z', 'medical');
  const third = await addAlert(repo, '2026-10-14T11:00:00.000Z', 'other');

  await repo.updateStatus(second.id, 'failed');

  assert.deepEqual(
    (await repo.listAlerts()).map((alert) => alert.id),
    [third.id, second.id, first.id],
  );
  assert.deepEqual(
    (await repo.listPendingAlerts()).map((alert) => alert.id),
    [first.id, third.id],
  );
});

test('sent requires a server receipt and keeps the receipt', async () => {
  const { repo } = createRepo();
  const alert = await addAlert(repo, '2026-10-14T09:00:00.000Z');

  await assert.rejects(
    () => repo.updateStatus(alert.id, 'sent'),
    (error: unknown) => error instanceof AlertValidationError,
  );
  assert.equal((await repo.getAlertById(alert.id))?.status, 'pending');

  const sent = await repo.updateStatus(alert.id, 'sent', { serverReceipt: '  receipt-123  ' });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.serverReceipt, 'receipt-123');
  assert.equal((await repo.getAlertById(alert.id))?.status, 'sent');
});

test('sent is terminal; failed can be re-queued and increments retryCount', async () => {
  const { repo } = createRepo();
  const alert = await addAlert(repo, '2026-10-14T09:00:00.000Z');

  const failed = await repo.updateStatus(alert.id, 'failed');
  assert.equal(failed.retryCount, 0);

  const requeued = await repo.updateStatus(alert.id, 'pending');
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.retryCount, 1);

  await repo.updateStatus(alert.id, 'sent', { serverReceipt: 'receipt-123' });
  await assert.rejects(
    () => repo.updateStatus(alert.id, 'pending'),
    (error: unknown) => error instanceof AlertValidationError,
  );
});

test('updating an unknown alert throws AlertNotFoundError and writes nothing', async () => {
  const { repo, store } = createRepo();
  const alert = await addAlert(repo, '2026-10-14T09:00:00.000Z');

  await assert.rejects(
    () => repo.updateStatus('alert_missing', 'failed'),
    (error: unknown) => error instanceof AlertNotFoundError,
  );
  assert.equal(store.records.get(alert.id)?.status, 'pending');
});

test('invalid ids are rejected before touching storage', async () => {
  const { repo } = createRepo();
  const alert = await addAlert(repo, '2026-10-14T09:00:00.000Z');

  await assert.rejects(
    () => repo.getAlertById('\u0000bad'),
    (error: unknown) => error instanceof AlertValidationError,
  );
  await assert.rejects(
    () => repo.deleteAlert(''),
    (error: unknown) => error instanceof AlertValidationError,
  );
  await assert.rejects(
    () => repo.updateStatus(alert.id, 'not-a-status' as never),
    (error: unknown) => error instanceof AlertValidationError,
  );
  assert.equal(await repo.getAlertById(alert.id) !== null, true);
});

test('deleteAlert reports whether a record was removed', async () => {
  const { repo } = createRepo();
  const alert = await addAlert(repo, '2026-10-14T09:00:00.000Z');

  assert.equal(await repo.deleteAlert(alert.id), true);
  assert.equal(await repo.deleteAlert(alert.id), false);
  assert.equal(await repo.getAlertById(alert.id), null);
});

test('a failed write surfaces as AlertStorageError, never as a saved alert', async () => {
  const { repo, store } = createRepo();
  store.failWrites = true;

  await assert.rejects(
    () => addAlert(repo, '2026-10-14T09:00:00.000Z'),
    (error: unknown) => error instanceof AlertStorageError && !(error instanceof AlertValidationError),
  );
  assert.equal(store.records.size, 0);
  assert.deepEqual(await repo.listAlerts(), []);
});

test('parseStoredAlert validates persisted records and drops extra fields', () => {
  const stored = {
    id: 'alert_1',
    createdAtUtc: '2026-10-14T09:00:00.000Z',
    category: 'fire',
    status: 'sent',
    location: { state: 'available', latitude: -1.29, longitude: 36.82, accuracyMeters: 5 },
    serverReceipt: 'receipt-1',
    retryCount: 1,
    updatedAtUtc: '2026-10-14T09:05:00.000Z',
    accessToken: 'must-not-survive',
  };

  const parsed = parseStoredAlert(stored);
  assert.equal(parsed.status, 'sent');
  assert.equal('accessToken' in parsed, false);

  assert.throws(
    () => parseStoredAlert({ ...stored, serverReceipt: null }),
    (error: unknown) => error instanceof AlertStorageError,
  );
  assert.throws(
    () => parseStoredAlert({ ...stored, status: 'unknown' }),
    (error: unknown) => error instanceof AlertStorageError,
  );
  assert.throws(
    () =>
      parseStoredAlert({
        ...stored,
        location: { state: 'available', latitude: 120, longitude: 36.82, accuracyMeters: null },
      }),
    (error: unknown) => error instanceof AlertStorageError,
  );
  assert.throws(
    () =>
      parseStoredAlert({
        ...stored,
        location: { state: 'unavailable', reason: 'unknown', latitude: -1.29 },
      }),
    (error: unknown) => error instanceof AlertStorageError,
  );
});
