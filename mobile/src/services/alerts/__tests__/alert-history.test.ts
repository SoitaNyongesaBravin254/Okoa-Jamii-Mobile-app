import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openWasmSqliteDriver } from './wasm-sqlite-driver';
import { presentAlertHistoryItem } from '../alert-presenter';
import { SqliteAlertRepository } from '../sqlite-alert-repository';
import type { AlertLocation } from '@/types/alert';

/**
 * Alert history behaviour: the screen maps `repository.listAlerts()` through
 * `presentAlertHistoryItem`, so these tests assert the real ordering the
 * repository returns plus the rendered status/location fields — and that no
 * coordinate ever reaches the list.
 */

const SENSITIVE_LOCATION: AlertLocation = {
  state: 'available',
  latitude: -1.292066,
  longitude: 36.821945,
  accuracyMeters: 5,
};

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okoa-history-test-'));
  return path.join(dir, 'alerts.db');
}

function openRepo(dbPath: string): SqliteAlertRepository {
  return new SqliteAlertRepository(openWasmSqliteDriver(dbPath));
}

test('history renders newest first with honest status and location labels', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const t0 = '2026-10-14T10:00:00.000Z';
    const t1 = '2026-10-14T11:00:00.000Z';
    const t2 = '2026-10-14T12:00:00.000Z';

    await repo.createAlert({
      category: 'fire',
      location: { state: 'unavailable', reason: 'timeout' },
      createdAtUtc: t0,
    });
    await repo.createAlert({
      category: 'medical',
      location: SENSITIVE_LOCATION,
      createdAtUtc: t1,
    });
    const newest = await repo.createAlert({
      category: 'security',
      location: { state: 'unavailable', reason: 'permission-denied' },
      createdAtUtc: t2,
    });

    const alerts = await repo.listAlerts();
    const items = alerts.map(presentAlertHistoryItem);

    // Newest first, as the history screen displays them.
    assert.equal(items.length, 3);
    assert.equal(alerts[0].id, newest.id);
    assert.deepEqual(
      items.map((item) => item.categoryLabel),
      ['Security', 'Medical', 'Fire'],
    );

    // Every row carries a readable creation time.
    for (const item of items) {
      assert.ok(item.createdLabel.length > 0);
    }

    // Location availability is shown without inventing a location.
    assert.equal(items[0].locationLabel, 'Location permission denied');
    assert.equal(items[1].locationLabel, 'Location attached');
    assert.equal(items[2].locationLabel, 'Location timed out');

    // Local saves are never presented as delivered.
    for (const item of items) {
      assert.equal(item.status.isServerConfirmed, false);
      assert.equal(item.status.tone, 'info');
      assert.ok(item.status.label.toLowerCase().includes('this device'));
    }

    // No coordinates in anything the screen would render.
    const rendered = JSON.stringify(items);
    for (const marker of ['-1.292066', '36.821945']) {
      assert.ok(!rendered.includes(marker), `history must not contain ${marker}`);
    }
  } finally {
    await repo.close();
  }
});

test('history distinguishes a failed delivery from a pending local save', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const saved = await repo.createAlert({
      category: 'flood',
      location: { state: 'unavailable', reason: 'service-disabled' },
      createdAtUtc: '2026-10-14T10:00:00.000Z',
    });
    await repo.createAlert({
      category: 'other',
      location: SENSITIVE_LOCATION,
      createdAtUtc: '2026-10-14T11:00:00.000Z',
    });
    await repo.updateStatus(saved.id, 'failed');

    const items = (await repo.listAlerts()).map(presentAlertHistoryItem);
    const failed = items.find((item) => item.categoryLabel === 'Flood');
    const pending = items.find((item) => item.categoryLabel === 'Other');

    assert.ok(failed && pending);
    // Still local in both cases, but the tone/label differs honestly.
    assert.equal(failed.status.tone, 'warning');
    assert.ok(failed.status.label.toLowerCase().includes('this device'));
    assert.equal(pending.status.tone, 'info');
    assert.ok(pending.status.label.toLowerCase().includes('not yet sent'));

    for (const item of [failed, pending]) {
      assert.equal(item.status.isServerConfirmed, false);
    }

    // Location-unavailable reason survives the round trip into the list.
    assert.equal(failed.locationLabel, 'Location services off');
  } finally {
    await repo.close();
  }
});

test('an empty database renders an empty history, not an error', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const alerts = await repo.listAlerts();
    assert.deepEqual(alerts, []);
    assert.deepEqual(alerts.map(presentAlertHistoryItem), []);
  } finally {
    await repo.close();
  }
});
