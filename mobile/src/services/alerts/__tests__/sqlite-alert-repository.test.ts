import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openWasmSqliteDriver } from './wasm-sqlite-driver';
import { AlertNotFoundError, AlertValidationError } from '../alert-errors';
import { SqliteAlertRepository } from '../sqlite-alert-repository';
import type { AlertLocation } from '@/types/alert';

/**
 * Repository integration tests against real SQLite (compiled to
 * WebAssembly). Each test uses a private on-disk database file so persistence
 * across reopen can be verified for real.
 */

const SENSITIVE_LOCATION: AlertLocation = {
  state: 'available',
  latitude: -1.292066,
  longitude: 36.821945,
  accuracyMeters: 8,
};

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okoa-alerts-test-'));
  return path.join(dir, 'alerts.db');
}

function openRepo(dbPath: string): SqliteAlertRepository {
  return new SqliteAlertRepository(openWasmSqliteDriver(dbPath));
}

test('initialize creates the schema and is safe to repeat (incl. concurrently)', async () => {
  const dbPath = tempDbPath();
  const repo = openRepo(dbPath);
  try {
    await Promise.all([repo.initialize(), repo.initialize(), repo.initialize()]);
    await repo.initialize();
    const driver = openWasmSqliteDriver(dbPath);
    const table = await driver.getFirstAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alerts'",
    );
    const version = await driver.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    const indexes = await driver.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_alerts%'",
    );
    await driver.closeAsync();
    assert.ok(table, 'alerts table exists');
    assert.equal(version?.user_version, 1);
    assert.equal(indexes.length, 2);
  } finally {
    await repo.close();
  }
});

test('alerts persist and are retrievable after reopening the database', async () => {
  const dbPath = tempDbPath();
  const first = openRepo(dbPath);
  const created = await first.createAlert({ category: 'security', location: SENSITIVE_LOCATION });
  await first.close();

  const second = openRepo(dbPath);
  const loaded = await second.getAlertById(created.id);
  await second.close();
  assert.ok(loaded);
  assert.equal(loaded.status, 'pending');
  assert.deepEqual(loaded.location, SENSITIVE_LOCATION);
});

test('invalid ids, coordinates, timestamps and receipts are rejected', async () => {
  const repo = openRepo(tempDbPath());
  try {
    await assert.rejects(repo.getAlertById(''), AlertValidationError);
    await assert.rejects(repo.deleteAlert('bad\u0000id'), AlertValidationError);
    await assert.rejects(
      repo.createAlert({
        category: 'flood',
        location: { state: 'available', latitude: 12345, longitude: 0, accuracyMeters: null },
      }),
      AlertValidationError,
    );
    await assert.rejects(
      repo.createAlert({
        category: 'fire',
        location: { state: 'unavailable', reason: 'permission-denied' },
        createdAtUtc: 'yesterday',
      }),
      AlertValidationError,
    );

    const alert = await repo.createAlert({ category: 'other', location: SENSITIVE_LOCATION });
    await assert.rejects(
      repo.updateStatus(alert.id, 'sent', { serverReceipt: null }),
      AlertValidationError,
    );
    // Failed validation must not change stored state.
    const unchanged = await repo.getAlertById(alert.id);
    assert.equal(unchanged?.status, 'pending');
    assert.equal(unchanged?.serverReceipt, null);
  } finally {
    await repo.close();
  }
});

test('pending query returns only pending alerts, oldest first', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const t0 = '2026-10-14T10:00:00.000Z';
    const t1 = '2026-10-14T11:00:00.000Z';
    const t2 = '2026-10-14T12:00:00.000Z';
    const a = await repo.createAlert({ category: 'fire', location: { state: 'unavailable', reason: 'timeout' }, createdAtUtc: t2 });
    const b = await repo.createAlert({ category: 'medical', location: { state: 'unavailable', reason: 'timeout' }, createdAtUtc: t0 });
    const c = await repo.createAlert({ category: 'security', location: { state: 'unavailable', reason: 'timeout' }, createdAtUtc: t1 });
    await repo.updateStatus(c.id, 'failed');

    const pending = await repo.listPendingAlerts();
    assert.deepEqual(
      pending.map((p) => p.id),
      [b.id, a.id],
    );

    const all = await repo.listAlerts();
    assert.deepEqual(
      all.map((p) => p.id),
      [a.id, c.id, b.id],
    );
  } finally {
    await repo.close();
  }
});

test('status updates persist, sent requires a receipt, sent is terminal, retries count', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const alert = await repo.createAlert({ category: 'security', location: SENSITIVE_LOCATION });

    const failed = await repo.updateStatus(alert.id, 'failed');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.retryCount, 0);

    const requeued = await repo.updateStatus(alert.id, 'pending');
    assert.equal(requeued.status, 'pending');
    assert.equal(requeued.retryCount, 1);

    const sent = await repo.updateStatus(alert.id, 'sent', { serverReceipt: 'srv_receipt_1' });
    assert.equal(sent.status, 'sent');
    assert.equal(sent.serverReceipt, 'srv_receipt_1');
    assert.equal(sent.retryCount, 1);

    const stored = await repo.getAlertById(alert.id);
    assert.equal(stored?.status, 'sent');
    assert.equal(stored?.serverReceipt, 'srv_receipt_1');

    await assert.rejects(repo.updateStatus(alert.id, 'pending'), AlertValidationError);
    await assert.rejects(repo.updateStatus(alert.id, 'failed'), AlertValidationError);
  } finally {
    await repo.close();
  }
});

test('failed inserts and updates surface as errors, never silent success', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const alert = await repo.createAlert({ category: 'other', location: SENSITIVE_LOCATION });

    // Unknown id: update and read paths must fail loudly or return null.
    await assert.rejects(
      repo.updateStatus('alert_does_not_exist', 'failed'),
      AlertNotFoundError,
    );
    assert.equal(await repo.getAlertById('alert_does_not_exist'), null);

    // Duplicate primary key insert must fail, not create a duplicate record.
    const driver = openWasmSqliteDriver(':memory:');
    await driver.closeAsync();
    await assert.rejects(
      (async () => {
        const anyRepo = repo as unknown as { db: { runAsync(sql: string, params: unknown[]): Promise<{ changes: number }> } };
        await anyRepo.db.runAsync(
          'INSERT INTO alerts (id, created_at_utc, category, status, location_state, latitude, longitude, location_accuracy, location_unavailable_reason, server_receipt, retry_count, updated_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [alert.id, alert.createdAtUtc, 'other', 'pending', 'unavailable', null, null, null, 'timeout', null, 0, alert.updatedAtUtc],
        );
      })(),
    );
    const all = await repo.listAlerts();
    assert.equal(all.length, 1);
  } finally {
    await repo.close();
  }
});

test('deleting one alert leaves unrelated alerts intact; double delete returns false', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const a = await repo.createAlert({ category: 'fire', location: { state: 'unavailable', reason: 'unknown' } });
    const b = await repo.createAlert({ category: 'flood', location: { state: 'unavailable', reason: 'unknown' } });
    const c = await repo.createAlert({ category: 'medical', location: { state: 'unavailable', reason: 'unknown' } });

    assert.equal(await repo.deleteAlert(b.id), true);
    assert.equal(await repo.deleteAlert(b.id), false);

    const remaining = (await repo.listAlerts()).map((alert) => alert.id).sort();
    assert.deepEqual(remaining, [a.id, c.id].sort());
  } finally {
    await repo.close();
  }
});

test('concurrent operations produce no duplicate or lost records', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        repo.createAlert({
          category: 'security',
          location: { state: 'unavailable', reason: 'service-disabled' },
          createdAtUtc: `2026-10-14T10:00:0${index}.000Z`,
        }),
      ),
    );
    const ids = new Set(created.map((alert) => alert.id));
    assert.equal(ids.size, 10);

    const stored = await repo.listAlerts();
    assert.equal(stored.length, 10);
  } finally {
    await repo.close();
  }
});

test('alert operations never print coordinates or receipts to the console', async () => {
  const repo = openRepo(tempDbPath());
  const captured: string[] = [];
  const consoleRef = console;
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((method) => consoleRef[method]);
  for (const method of methods) {
    consoleRef[method] = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(' '));
    };
  }
  try {
    const alert = await repo.createAlert({ category: 'security', location: SENSITIVE_LOCATION });
    await repo.listAlerts();
    await repo.listPendingAlerts();
    await repo.getAlertById(alert.id);
    await repo.updateStatus(alert.id, 'sent', { serverReceipt: 'srv_receipt_secret_42' });
    await repo.deleteAlert(alert.id);
  } finally {
    methods.forEach((method, index) => {
      consoleRef[method] = originals[index];
    });
    await repo.close();
  }

  const output = captured.join('\n');
  for (const marker of ['-1.292066', '36.821945', 'srv_receipt_secret_42']) {
    assert.ok(!output.includes(marker), `console output must not contain ${marker}`);
  }
});
