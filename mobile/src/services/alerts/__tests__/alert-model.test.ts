import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AlertValidationError } from '../alert-errors';
import {
  assertStatusTransition,
  canTransitionStatus,
  createAlertRecord,
  generateAlertId,
  isCanonicalUtcTimestamp,
  isValidAlertId,
  isValidCoordinates,
  requireServerReceipt,
  validateAlertLocation,
} from '../alert-model';
import type { AlertLocation } from '@/types/alert';

const availableLocation: AlertLocation = {
  state: 'available',
  latitude: -1.292066,
  longitude: 36.821945,
  accuracyMeters: 12,
};

const unavailableLocation: AlertLocation = {
  state: 'unavailable',
  reason: 'permission-denied',
};

test('createAlertRecord produces a pending alert with no receipt and no fabricated data', () => {
  const alert = createAlertRecord({ category: 'security', location: availableLocation });
  assert.equal(alert.status, 'pending');
  assert.equal(alert.serverReceipt, null);
  assert.equal(alert.retryCount, 0);
  assert.ok(isCanonicalUtcTimestamp(alert.createdAtUtc));
  assert.equal(alert.updatedAtUtc, alert.createdAtUtc);
  assert.equal(alert.location.state, 'available');
});

test('createAlertRecord keeps an explicit unavailable location without coordinates', () => {
  const alert = createAlertRecord({ category: 'medical', location: unavailableLocation });
  assert.deepEqual(alert.location, { state: 'unavailable', reason: 'permission-denied' });
});

test('createAlertRecord rejects an invalid category', () => {
  assert.throws(
    () =>
      createAlertRecord({
        category: 'nope' as never,
        location: availableLocation,
      }),
    AlertValidationError,
  );
});

test('coordinates outside valid ranges are rejected', () => {
  assert.equal(isValidCoordinates(0, 0), true);
  assert.equal(isValidCoordinates(-90, 180), true);
  assert.equal(isValidCoordinates(91, 0), false);
  assert.equal(isValidCoordinates(0, -181), false);
  assert.equal(isValidCoordinates(Number.NaN, 0), false);
});

test('available location with invalid coordinates is rejected', () => {
  assert.throws(
    () => validateAlertLocation({ state: 'available', latitude: 999, longitude: 0, accuracyMeters: null }),
    AlertValidationError,
  );
  assert.throws(
    () =>
      validateAlertLocation({
        state: 'available',
        latitude: 0,
        longitude: 0,
        accuracyMeters: -5,
      }),
    AlertValidationError,
  );
});

test('unavailable location with a bogus reason is rejected', () => {
  assert.throws(
    () => validateAlertLocation({ state: 'unavailable', reason: 'made-up' as never }),
    AlertValidationError,
  );
});

test('timestamps must be canonical ISO-8601 UTC', () => {
  assert.equal(isCanonicalUtcTimestamp('2026-10-14T09:15:00.000Z'), true);
  assert.equal(isCanonicalUtcTimestamp('2026-10-14'), false);
  assert.equal(isCanonicalUtcTimestamp('not a date'), false);
  assert.equal(isCanonicalUtcTimestamp('2026-10-14T09:15:00+02:00'), false);
  assert.throws(
    () =>
      createAlertRecord({
        category: 'fire',
        location: availableLocation,
        createdAtUtc: '2026-10-14',
      }),
    AlertValidationError,
  );
});

test('alert ids are valid, bounded and unique', () => {
  assert.equal(isValidAlertId('alert_x_1_abc'), true);
  assert.equal(isValidAlertId(''), false);
  assert.equal(isValidAlertId('a'.repeat(200)), false);
  assert.equal(isValidAlertId('bad\u0000id'), false);

  const ids = new Set<string>();
  for (let i = 0; i < 5000; i += 1) {
    ids.add(generateAlertId());
  }
  assert.equal(ids.size, 5000);
});

test('status transition rules match the documented state machine', () => {
  assert.equal(canTransitionStatus('pending', 'sent'), true);
  assert.equal(canTransitionStatus('pending', 'failed'), true);
  assert.equal(canTransitionStatus('failed', 'pending'), true);
  assert.equal(canTransitionStatus('failed', 'sent'), true);

  assert.equal(canTransitionStatus('sent', 'pending'), false);
  assert.equal(canTransitionStatus('sent', 'failed'), false);
  assert.equal(canTransitionStatus('pending', 'pending'), false);
  assert.equal(canTransitionStatus('failed', 'failed'), false);
  assert.equal(canTransitionStatus('bogus' as never, 'sent'), false);

  assert.doesNotThrow(() => assertStatusTransition('pending', 'failed'));
  assert.throws(() => assertStatusTransition('sent', 'pending'), AlertValidationError);
});

test('a server receipt is required (and cleaned) before an alert can be sent', () => {
  assert.throws(() => requireServerReceipt(null), AlertValidationError);
  assert.throws(() => requireServerReceipt(undefined), AlertValidationError);
  assert.throws(() => requireServerReceipt('   '), AlertValidationError);
  assert.throws(() => requireServerReceipt('r'.repeat(300)), AlertValidationError);
  assert.equal(requireServerReceipt('  receipt-1  '), 'receipt-1');
});
