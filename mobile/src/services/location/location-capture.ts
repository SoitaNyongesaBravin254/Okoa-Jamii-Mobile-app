/**
 * Pure helpers behind `device-location`: error-code → reason mapping,
 * device-fix normalisation and a one-shot timeout race.
 *
 * Deliberately free of expo/react imports so the exact logic that decides
 * whether coordinates get attached to an alert is unit-testable in Node
 * without native modules. Nothing here logs values.
 */

// Relative (not `@/`) import: this module also compiles into the Node test
// build, which does not rewrite path aliases at runtime.
import { isValidCoordinates } from '../alerts/alert-model';
import type { AlertLocation, LocationUnavailableReason } from '@/types/alert';

/** Upper bound for a single one-shot location fix. */
export const DEFAULT_LOCATION_TIMEOUT_MS = 15_000;

/** Coded error used when a location fix outruns the timeout budget. */
export const LOCATION_TIMEOUT_CODE = 'E_LOCATION_TIMEOUT';

/**
 * Maps a location error code to a model unavailable reason.
 *
 * Codes handled:
 * - `ERR_*` codes inferred by expo-modules-core from exception class names —
 *   these are what the native Android/iOS modules actually reject with in
 *   Expo SDK 57 (e.g. `ERR_LOCATION_UNAUTHORIZED`);
 * - legacy `E_LOCATION_*` codes still emitted on some platforms/web;
 * - numeric browser `PositionError` codes (1 = permission denied,
 *   3 = timeout).
 *
 * Anything unrecognised maps to `unknown`: an uncertain failure is reported
 * as "could not be determined" rather than guessed into a specific reason.
 */
export function mapLocationErrorCode(
  code: string | number | undefined | null,
): LocationUnavailableReason {
  switch (String(code)) {
    case 'ERR_LOCATION_UNAUTHORIZED':
    case 'ERR_LOCATION_BACKGROUND_UNAUTHORIZED':
    case 'E_LOCATION_PERMISSION_DENIED':
    case '1': // GeolocationPositionError.PERMISSION_DENIED
      return 'permission-denied';
    case 'ERR_LOCATION_SETTINGS_UNSATISFIED':
    case 'E_LOCATION_SERVICES_DISABLED':
      return 'service-disabled';
    case LOCATION_TIMEOUT_CODE:
    case '3': // GeolocationPositionError.TIMEOUT
      return 'timeout';
    default:
      return 'unknown';
  }
}

/**
 * Normalises a device fix into an AlertLocation. Non-finite or out-of-range
 * values become an explicit `unavailable` record — coordinates are never
 * fabricated, rounded into range or substituted. A missing/invalid accuracy
 * is stored as null rather than a guessed number.
 */
export function toAlertLocation(
  latitude: unknown,
  longitude: unknown,
  accuracy: unknown,
): AlertLocation {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return { state: 'unavailable', reason: 'unknown' };
  }
  if (!isValidCoordinates(latitude, longitude)) {
    return { state: 'unavailable', reason: 'unknown' };
  }
  const accuracyMeters =
    typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0
      ? accuracy
      : null;
  return { state: 'available', latitude, longitude, accuracyMeters };
}

/**
 * Runs a one-shot operation with a hard deadline. On timeout the returned
 * promise rejects with `LOCATION_TIMEOUT_CODE` (so the caller records a real
 * `timeout` reason) and the timer is always cleared once the race settles.
 *
 * The underlying native request is not cancelled — there is no subscription
 * to clean up for a one-shot fix, and nothing keeps collecting afterwards.
 * A non-positive/non-finite budget falls back to the default deadline.
 */
export function raceWithTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  const budget =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_LOCATION_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('location request timed out'), { code: LOCATION_TIMEOUT_CODE }));
    }, budget);
  });

  // Async wrapper turns a synchronous throw into a normal rejection.
  const started = (async () => operation())();

  return Promise.race([started, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
