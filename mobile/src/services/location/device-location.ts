/**
 * Foreground device-location capture for the SOS flow.
 *
 * Rules encoded here:
 * - Permission is requested only when this function runs (i.e. when the user
 *   activates the SOS flow), never on app start.
 * - Foreground permission only; no background/continuous location and no
 *   subscriptions — this is a single one-shot fix per activation.
 * - Coordinates are returned only when the device reports a real, valid fix;
 *   every failure maps to an explicit unavailable reason instead of fake data.
 * - A single fix must complete within the timeout budget or it is reported as
 *   a `timeout`.
 * - Nothing here logs coordinates, permission states or error payloads.
 *
 * This module is the only place (besides the driver) that touches a native
 * module, so the SOS orchestration above it stays pure and Node-testable; the
 * decision logic lives in `./location-capture` where it is unit-tested.
 */

import * as Location from 'expo-location';

import {
  DEFAULT_LOCATION_TIMEOUT_MS,
  mapLocationErrorCode,
  raceWithTimeout,
  toAlertLocation,
} from './location-capture';
import type { AlertLocation, LocationUnavailableReason } from '@/types/alert';

/**
 * Requests foreground permission (only now, because the user asked), then
 * reads the current position. Always resolves — never throws — with either
 * real, validated coordinates or an explicit unavailable reason.
 */
export async function captureDeviceLocation(
  timeoutMs: number = DEFAULT_LOCATION_TIMEOUT_MS,
): Promise<AlertLocation> {
  try {
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    if (!servicesEnabled) {
      return unavailable('service-disabled');
    }

    let permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) {
      // The SOS flow is the only trigger for this prompt in the app.
      permission = await Location.requestForegroundPermissionsAsync();
    }
    if (!permission.granted) {
      return unavailable('permission-denied');
    }

    const position = await raceWithTimeout(
      () => Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      timeoutMs,
    );

    const { latitude, longitude, accuracy } = position.coords;
    // An out-of-range fix from the OS is treated as "no location", never stored.
    return toAlertLocation(latitude, longitude, accuracy);
  } catch (error) {
    return unavailable(mapLocationErrorCode(readErrorCode(error)));
  }
}

function unavailable(reason: LocationUnavailableReason): AlertLocation {
  return { state: 'unavailable', reason };
}

/** Reads a coded error property without echoing or logging the error itself. */
function readErrorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}
