import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  presentAlertCategory,
  presentAlertHistoryItem,
  presentAlertLocation,
  presentAlertStatus,
} from '../alert-presenter';
import type { AlertRecord } from '@/types/alert';

/**
 * Presenter tests: the UI layer must clearly separate "saved on this device"
 * from server-confirmed delivery, and must never expose coordinates.
 */

const SENSITIVE_COORDS = ['-1.292066', '36.821945'];

const baseAlert: AlertRecord = {
  id: 'alert_test_1',
  createdAtUtc: '2026-10-14T10:00:00.000Z',
  category: 'medical',
  location: { state: 'available', latitude: -1.292066, longitude: 36.821945, accuracyMeters: 8 },
  status: 'pending',
  serverReceipt: 'srv_receipt_secret_42',
  retryCount: 2,
  updatedAtUtc: '2026-10-14T10:00:00.000Z',
};

test('pending and failed statuses are never presented as server-confirmed', () => {
  const pending = presentAlertStatus('pending');
  const failed = presentAlertStatus('failed');
  const sent = presentAlertStatus('sent');

  assert.equal(pending.isServerConfirmed, false);
  assert.equal(failed.isServerConfirmed, false);
  assert.equal(sent.isServerConfirmed, true);
  assert.ok(pending.label.toLowerCase().includes('this device'));
  assert.ok(failed.label.toLowerCase().includes('this device'));
});

test('location presentation never contains coordinates', () => {
  const withCoords = presentAlertLocation(baseAlert.location);
  const denied = presentAlertLocation({ state: 'unavailable', reason: 'permission-denied' });
  const timeout = presentAlertLocation({ state: 'unavailable', reason: 'timeout' });
  const servicesOff = presentAlertLocation({ state: 'unavailable', reason: 'service-disabled' });
  const unknown = presentAlertLocation({ state: 'unavailable', reason: 'unknown' });

  for (const label of [withCoords, denied, timeout, servicesOff, unknown]) {
    for (const marker of SENSITIVE_COORDS) {
      assert.ok(!label.includes(marker), `label must not contain ${marker}`);
    }
  }
  assert.equal(withCoords, 'Location attached');
  assert.ok(denied.toLowerCase().includes('permission'));
  assert.ok(timeout.toLowerCase().includes('timed out'));
  assert.ok(servicesOff.toLowerCase().includes('services off'));
});

test('history item rendering carries status, category, time and location label — no coordinates', () => {
  const item = presentAlertHistoryItem(baseAlert);

  assert.equal(item.categoryLabel, 'Medical');
  assert.equal(item.retryCount, 2);
  assert.equal(item.status.isServerConfirmed, false);
  assert.ok(item.createdLabel.length > 0);

  const serialized = JSON.stringify(item);
  for (const marker of [...SENSITIVE_COORDS, 'srv_receipt_secret_42']) {
    assert.ok(!serialized.includes(marker), `history item must not contain ${marker}`);
  }
});

test('category labels cover every category', () => {
  for (const category of ['security', 'medical', 'fire', 'flood', 'other'] as const) {
    const label = presentAlertCategory(category);
    assert.ok(label.length > 0);
  }
});

test('an invalid stored timestamp falls back to the raw string, never an invented date', () => {
  const broken: AlertRecord = { ...baseAlert, createdAtUtc: 'not-a-date' };
  const item = presentAlertHistoryItem(broken);
  assert.equal(item.createdLabel, 'not-a-date');
});
