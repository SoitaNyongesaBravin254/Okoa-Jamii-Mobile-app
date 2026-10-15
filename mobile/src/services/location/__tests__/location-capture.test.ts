import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_LOCATION_TIMEOUT_MS,
  LOCATION_TIMEOUT_CODE,
  mapLocationErrorCode,
  raceWithTimeout,
  toAlertLocation,
} from '../location-capture';

/**
 * Tests for the pure decision logic behind `device-location`: which error
 * code becomes which unavailable reason, when a device fix is accepted or
 * refused, and the timeout deadline. The native expo-location call itself
 * needs a device/simulator and is not exercised here.
 */

test('permission failures map to permission-denied', () => {
  // expo-modules-core inferred codes (Expo SDK 57 native modules) plus the
  // legacy web/browser equivalents.
  for (const code of [
    'ERR_LOCATION_UNAUTHORIZED',
    'ERR_LOCATION_BACKGROUND_UNAUTHORIZED',
    'E_LOCATION_PERMISSION_DENIED',
    1, // browser GeolocationPositionError.PERMISSION_DENIED
  ]) {
    assert.equal(mapLocationErrorCode(code), 'permission-denied', `code ${String(code)}`);
  }
});

test('unsatisfied location settings map to service-disabled', () => {
  for (const code of ['ERR_LOCATION_SETTINGS_UNSATISFIED', 'E_LOCATION_SERVICES_DISABLED']) {
    assert.equal(mapLocationErrorCode(code), 'service-disabled', `code ${String(code)}`);
  }
});

test('timeout codes map to timeout', () => {
  for (const code of [LOCATION_TIMEOUT_CODE, 3]) {
    assert.equal(mapLocationErrorCode(code), 'timeout', `code ${String(code)}`);
  }
});

test('unknown, missing or unrelated codes fall back to unknown — never a guess', () => {
  for (const code of [
    undefined,
    null,
    '',
    'ERR_SOMETHING_ELSE',
    'ERR_LOCATION_UNAVAILABLE',
    'ERR_LOCATION_REQUEST_CANCELLED',
    2, // browser POSITION_UNAVAILABLE: services may well be on
    42,
  ]) {
    assert.equal(mapLocationErrorCode(code), 'unknown', `code ${String(code)}`);
  }
});

test('valid device fixes are stored as available with their accuracy', () => {
  const location = toAlertLocation(-1.292066, 36.821945, 8);
  assert.deepEqual(location, {
    state: 'available',
    latitude: -1.292066,
    longitude: 36.821945,
    accuracyMeters: 8,
  });
});

test('boundary coordinates are accepted', () => {
  assert.equal(toAlertLocation(90, 180, 1).state, 'available');
  assert.equal(toAlertLocation(-90, -180, 1).state, 'available');
  assert.equal(toAlertLocation(0, 0, 1).state, 'available');
});

test('invalid fixes are refused, never clamped or invented', () => {
  const bad: [unknown, unknown, unknown][] = [
    [999, -500, 5], // out of range
    [91, 0, 5],
    [0, 181, 5],
    [NaN, 0, 5],
    [Infinity, 0, 5],
    [0, -Infinity, 5],
    ['1.2', '3.4', 5], // strings from a malformed payload
    [undefined, undefined, undefined],
    [null, null, null],
  ];
  for (const [latitude, longitude, accuracy] of bad) {
    const location = toAlertLocation(latitude, longitude, accuracy);
    assert.equal(location.state, 'unavailable', `fix ${String(latitude)},${String(longitude)}`);
    if (location.state !== 'unavailable') continue;
    // A refused fix must not carry coordinates at all (model enforces this too).
    assert.equal('latitude' in location, false);
    assert.equal(location.reason, 'unknown');
  }
});

test('a missing or nonsensical accuracy becomes null instead of a guess', () => {
  const noAccuracy = toAlertLocation(-1.292066, 36.821945, undefined);
  assert.equal(noAccuracy.state, 'available');
  if (noAccuracy.state !== 'available') return;
  assert.equal(noAccuracy.accuracyMeters, null);

  for (const accuracy of [-5, NaN, Infinity, '8']) {
    const location = toAlertLocation(-1.292066, 36.821945, accuracy);
    assert.equal(location.state, 'available');
    if (location.state !== 'available') continue;
    assert.equal(location.accuracyMeters, null, `accuracy ${String(accuracy)}`);
  }
});

test('raceWithTimeout resolves when the operation finishes in time', async () => {
  const value = await raceWithTimeout(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 'fix';
  }, 2_000);
  assert.equal(value, 'fix');
});

test('raceWithTimeout rejects with the timeout code when the fix is too slow', async () => {
  const never = () => new Promise<never>(() => {});
  await assert.rejects(
    raceWithTimeout(never, 20),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === LOCATION_TIMEOUT_CODE,
  );
});

test('raceWithTimeout turns a synchronous throw into a rejection', async () => {
  await assert.rejects(
    raceWithTimeout(() => {
      throw new Error('native module exploded');
    }, 2_000),
    /native module exploded/,
  );
});

test('an invalid timeout budget falls back to the default deadline', async () => {
  assert.ok(DEFAULT_LOCATION_TIMEOUT_MS > 0);
  // A non-positive budget must not fire immediately: the operation still wins.
  const value = await raceWithTimeout(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 'ok';
  }, 0);
  assert.equal(value, 'ok');
});
