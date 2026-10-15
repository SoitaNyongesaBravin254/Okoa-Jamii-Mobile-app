import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openWasmSqliteDriver } from './wasm-sqlite-driver';
import { SqliteAlertRepository } from '../sqlite-alert-repository';
import { createSosSubmission, type SosSubmission } from '../sos-submission';
import type { AlertLocation } from '@/types/alert';

/**
 * SOS orchestration tests. The location capture is faked per test (the real
 * device capture needs native expo-location and runs only on a device); the
 * persistence layer is the real SQLite repository backed by WASM SQLite.
 */

const REAL_LOCATION: AlertLocation = {
  state: 'available',
  latitude: -1.292066,
  longitude: 36.821945,
  accuracyMeters: 8,
};

const SENSITIVE_MARKERS = ['-1.292066', '36.821945', 'srv_receipt_secret_42'];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okoa-sos-test-'));
  return path.join(dir, 'alerts.db');
}

function openRepo(dbPath: string): SqliteAlertRepository {
  return new SqliteAlertRepository(openWasmSqliteDriver(dbPath));
}

function makeSubmission(
  repo: SqliteAlertRepository,
  capture: () => Promise<AlertLocation>,
): SosSubmission {
  return createSosSubmission(repo, capture);
}

test('successful location capture persists a pending alert with coordinates', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const submission = makeSubmission(repo, async () => REAL_LOCATION);
    const result = await submission.submit('medical');

    assert.equal(result.outcome, 'saved');
    if (result.outcome !== 'saved') return;
    assert.equal(result.locationAttached, true);
    assert.equal(result.notice, null);

    const stored = await repo.getAlertById(result.alertId);
    assert.ok(stored);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.serverReceipt, null);
    assert.equal(stored.retryCount, 0);
    assert.deepEqual(stored.location, REAL_LOCATION);
  } finally {
    await repo.close();
  }
});

test('permission denial still persists a location-less alert with the real reason', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const submission = makeSubmission(repo, async () => ({
      state: 'unavailable',
      reason: 'permission-denied',
    }));
    const result = await submission.submit('security');

    assert.equal(result.outcome, 'saved');
    if (result.outcome !== 'saved') return;
    assert.equal(result.locationAttached, false);
    assert.ok(result.notice?.includes('permission'), 'notice explains the denial');

    const stored = await repo.getAlertById(result.alertId);
    assert.ok(stored);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.location.state, 'unavailable');
  } finally {
    await repo.close();
  }
});

test('a timed-out location lookup is recorded as a timeout, never as a location', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const submission = makeSubmission(repo, async () => ({
      state: 'unavailable',
      reason: 'timeout',
    }));
    const result = await submission.submit('medical');

    assert.equal(result.outcome, 'saved');
    if (result.outcome !== 'saved') return;
    assert.equal(result.locationAttached, false);
    assert.ok(result.notice?.toLowerCase().includes('too long'), 'notice explains the timeout');

    const stored = await repo.getAlertById(result.alertId);
    assert.ok(stored);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.location.state, 'unavailable');
    if (stored.location.state !== 'unavailable') return;
    assert.equal(stored.location.reason, 'timeout');
  } finally {
    await repo.close();
  }
});

test('location services disabled or lookup failure are recorded, never fabricated', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const disabled = makeSubmission(repo, async () => ({
      state: 'unavailable',
      reason: 'service-disabled',
    }));
    const disabledResult = await disabled.submit('flood');
    assert.equal(disabledResult.outcome, 'saved');

    // Capture function throwing (unexpected native failure).
    const throwing = makeSubmission(repo, async () => {
      throw new Error('native location module exploded');
    });
    const throwingResult = await throwing.submit('fire');
    assert.equal(throwingResult.outcome, 'saved');
    if (throwingResult.outcome !== 'saved') return;
    assert.equal(throwingResult.locationAttached, false);

    const all = await repo.listAlerts();
    assert.equal(all.length, 2);
    for (const alert of all) {
      assert.equal(alert.location.state, 'unavailable');
    }
  } finally {
    await repo.close();
  }
});

test('invalid coordinates are rejected safely, not stored', async () => {
  const repo = openRepo(tempDbPath());
  try {
    // A buggy capture returning out-of-range coordinates.
    const submission = makeSubmission(repo, async () => ({
      state: 'available',
      latitude: 999,
      longitude: -500,
      accuracyMeters: null,
    }));
    const result = await submission.submit('other');

    assert.equal(result.outcome, 'saved');
    if (result.outcome !== 'saved') return;
    assert.equal(result.locationAttached, false);

    const stored = await repo.getAlertById(result.alertId);
    assert.ok(stored);
    assert.equal(stored.location.state, 'unavailable');
    assert.equal(stored.location.reason, 'unknown');
  } finally {
    await repo.close();
  }
});

test('a SQLite failure is surfaced as failure, never as success', async () => {
  const failingRepo = {
    async createAlert(): Promise<never> {
      throw new Error('SQLITE_CANTOPEN: disk I/O error');
    },
  };
  const submission = createSosSubmission(failingRepo, async () => REAL_LOCATION);
  const result = await submission.submit('medical');

  assert.equal(result.outcome, 'failed');
  if (result.outcome !== 'failed') return;
  // Honest failure message, without leaking internal error details.
  assert.ok(result.message.includes('NOT be saved') || result.message.includes('not saved'));
  assert.ok(!result.message.includes('SQLITE_CANTOPEN'));
});

test('double submissions while in flight produce at most one alert', async () => {
  const repo = openRepo(tempDbPath());
  try {
    let captureCount = 0;
    let releaseCapture!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });

    const submission = makeSubmission(repo, async () => {
      captureCount += 1;
      await gate; // hold the first submission in flight
      return REAL_LOCATION;
    });

    const first = submission.submit('security');
    const second = submission.submit('security'); // double tap
    const third = submission.submit('medical'); // triple tap, different category
    releaseCapture();

    const [r1, r2, r3] = await Promise.all([first, second, third]);
    assert.equal(r1.outcome, 'saved');
    assert.equal(r2.outcome, 'duplicate-ignored');
    assert.equal(r3.outcome, 'duplicate-ignored');
    assert.equal(captureCount, 1);

    const stored = await repo.listAlerts();
    assert.equal(stored.length, 1);

    // After completion a new submission is allowed again.
    const later = makeSubmission(repo, async () => REAL_LOCATION);
    const laterResult = await later.submit('fire');
    assert.equal(laterResult.outcome, 'saved');
  } finally {
    await repo.close();
  }
});

test('saved alerts never carry a fabricated server receipt and start pending', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const submission = makeSubmission(repo, async () => REAL_LOCATION);
    const result = await submission.submit('fire');
    assert.equal(result.outcome, 'saved');

    const all = await repo.listAlerts();
    for (const alert of all) {
      assert.equal(alert.status, 'pending');
      assert.equal(alert.serverReceipt, null);
    }
  } finally {
    await repo.close();
  }
});

test('an invalid category fails without touching the database', async () => {
  const repo = openRepo(tempDbPath());
  try {
    const submission = makeSubmission(repo, async () => REAL_LOCATION);
    const result = await submission.submit('nope' as never);
    assert.equal(result.outcome, 'failed');
    assert.equal((await repo.listAlerts()).length, 0);
  } finally {
    await repo.close();
  }
});

test('the submission flow never prints coordinates or receipts to the console', async () => {
  const repo = openRepo(tempDbPath());
  const captured: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(' '));
    };
  }
  try {
    const submission = makeSubmission(repo, async () => REAL_LOCATION);
    const saved = await submission.submit('security');
    assert.equal(saved.outcome, 'saved');
    await repo.listAlerts();
    await repo.listPendingAlerts();

    // Also exercise the failure path with sensitive input.
    const failing = createSosSubmission(
      { async createAlert(): Promise<never> { throw new Error('boom'); } },
      async () => REAL_LOCATION,
    );
    await failing.submit('medical');
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index];
    });
    await repo.close();
  }

  const output = captured.join('\n');
  for (const marker of SENSITIVE_MARKERS) {
    assert.ok(!output.includes(marker), `console output must not contain ${marker}`);
  }
});
