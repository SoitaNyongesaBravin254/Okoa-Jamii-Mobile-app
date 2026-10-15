/**
 * SOS submission orchestration (pure — no expo/react imports).
 *
 * Coordinates a single SOS activation: capture a real device location,
 * coerce anything invalid to an explicit unavailable reason, and persist the
 * alert through the existing SQLite repository.
 *
 * Invariants:
 * - A local insert is never delivery: every saved alert starts `pending`
 *   with no server receipt (enforced downstream by the repository too).
 * - One activation produces at most one alert: an in-flight guard rejects
 *   concurrent submissions instead of writing duplicates.
 * - Capture/persistence failures are returned as explicit failure results —
 *   never reported as success, never fabricated into data.
 * - No coordinates, receipts, or alert payloads are ever logged here.
 */

import { AlertStorageError } from './alert-errors';
import { isAlertCategory, validateAlertLocation } from './alert-model';
import type { SqliteAlertRepository } from './sqlite-alert-repository';
import type {
  AlertCategory,
  AlertLocation,
  LocationUnavailableReason,
  NewAlertInput,
} from '@/types/alert';

/** Injected location capture (device implementation lives in the location service). */
export type LocationCapture = () => Promise<AlertLocation>;

export type SosSubmissionResult =
  | Readonly<{
      outcome: 'saved';
      alertId: string;
      createdAtUtc: string;
      /** True when real device coordinates are attached to the stored alert. */
      locationAttached: boolean;
      /** Privacy-safe notice to show the user (e.g. why location is missing). */
      notice: string | null;
    }>
  | Readonly<{ outcome: 'duplicate-ignored' }>
  | Readonly<{ outcome: 'failed'; message: string; reason: LocationUnavailableReason | null }>;

export type SosSubmission = Readonly<{
  /** True while a submission is in flight (controls should be disabled). */
  isBusy(): boolean;
  /**
   * Captures location and persists one alert. Additional calls while a
   * submission is in flight resolve with `duplicate-ignored` and write
   * nothing.
   */
  submit(category: AlertCategory): Promise<SosSubmissionResult>;
}>;

const UNAVAILABLE_NOTICES: Record<LocationUnavailableReason, string> = {
  'permission-denied':
    'Location permission was denied. Your alert was saved on this device without coordinates.',
  'service-disabled':
    'Location services are turned off. Your alert was saved on this device without coordinates.',
  timeout:
    'Finding your location took too long. Your alert was saved on this device without coordinates.',
  unknown:
    'Your location could not be determined. Your alert was saved on this device without coordinates.',
};

/**
 * Creates one SOS submission controller bound to a repository and a location
 * capture function. The busy-guard state is per controller instance.
 */
export function createSosSubmission(
  repository: Pick<SqliteAlertRepository, 'createAlert'>,
  captureLocation: LocationCapture,
): SosSubmission {
  let inFlight = false;

  return {
    isBusy: () => inFlight,

    async submit(category: AlertCategory): Promise<SosSubmissionResult> {
      if (inFlight) {
        return { outcome: 'duplicate-ignored' };
      }
      inFlight = true;
      try {
        if (!isAlertCategory(category)) {
          return { outcome: 'failed', message: 'Choose an emergency type before sending an alert.', reason: null };
        }

        const location = await resolveCaptureLocation(captureLocation);
        const input: NewAlertInput = { category, location };
        const alert = await repository.createAlert(input);

        // The repository always stores new alerts as `pending`; a locally
        // saved alert must never be presented as delivered.
        const locationAttached = location.state === 'available';
        return {
          outcome: 'saved',
          alertId: alert.id,
          createdAtUtc: alert.createdAtUtc,
          locationAttached,
          notice: locationAttached ? null : UNAVAILABLE_NOTICES[location.reason],
        };
      } catch (error) {
        // Deliberately generic: never echo SQL parameters or alert content.
        const message =
          error instanceof AlertStorageError
            ? 'Your alert could NOT be saved on this device. Please try again.'
            : 'Something unexpected went wrong. Your alert was not saved.';
        return { outcome: 'failed', message, reason: null };
      } finally {
        inFlight = false;
      }
    },
  };
}

/**
 * Runs the injected capture and guarantees a valid AlertLocation:
 * thrown errors or invalid coordinates become an explicit `unavailable`
 * reason — fabricated coordinates are never persisted.
 */
async function resolveCaptureLocation(captureLocation: LocationCapture): Promise<AlertLocation> {
  let candidate: AlertLocation;
  try {
    candidate = await captureLocation();
  } catch {
    return { state: 'unavailable', reason: 'unknown' };
  }

  try {
    validateAlertLocation(candidate);
    return candidate;
  } catch {
    // Out-of-range coordinates or a bogus reason: treat as no location.
    return { state: 'unavailable', reason: 'unknown' };
  }
}
