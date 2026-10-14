/**
 * Pure alert-domain logic: id generation, validation and status rules.
 * No I/O here — everything is unit-testable without SQLite.
 */

import { AlertValidationError } from './alert-errors';
import type {
  AlertCategory,
  AlertDeliveryStatus,
  AlertLocation,
  AlertRecord,
  LocationUnavailableReason,
  NewAlertInput,
} from '@/types/alert';

export const ALERT_CATEGORIES: readonly AlertCategory[] = [
  'security',
  'medical',
  'fire',
  'flood',
  'other',
];

export const ALERT_DELIVERY_STATUSES: readonly AlertDeliveryStatus[] = [
  'pending',
  'sent',
  'failed',
];

export const LOCATION_UNAVAILABLE_REASONS: readonly LocationUnavailableReason[] = [
  'permission-denied',
  'service-disabled',
  'timeout',
  'unknown',
];

const MAX_ALERT_ID_LENGTH = 128;
const MAX_SERVER_RECEIPT_LENGTH = 256;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

let alertIdCounter = 0;

/**
 * Generates a locally unique alert id. Uniqueness comes from the millisecond
 * timestamp, a monotonic counter and randomness combined — no native crypto
 * dependency is required for local-only ids.
 */
export function generateAlertId(): string {
  alertIdCounter = (alertIdCounter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const counter = alertIdCounter.toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `alert_${time}_${counter}_${random}`;
}

export function isAlertCategory(value: unknown): value is AlertCategory {
  return typeof value === 'string' && (ALERT_CATEGORIES as readonly string[]).includes(value);
}

export function isAlertDeliveryStatus(value: unknown): value is AlertDeliveryStatus {
  return typeof value === 'string' && (ALERT_DELIVERY_STATUSES as readonly string[]).includes(value);
}

export function isLocationUnavailableReason(value: unknown): value is LocationUnavailableReason {
  return (
    typeof value === 'string' && (LOCATION_UNAVAILABLE_REASONS as readonly string[]).includes(value)
  );
}

export function isValidAlertId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ALERT_ID_LENGTH && !hasControlCharacters(id);
}

export function isValidCoordinates(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/** True for canonical ISO-8601 UTC strings, e.g. `2026-10-14T09:15:00.000Z`. */
export function isCanonicalUtcTimestamp(value: string): boolean {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

export function validateAlertLocation(location: AlertLocation): void {
  if (location == null || typeof location !== 'object') {
    throw new AlertValidationError('alert location is missing');
  }
  if (location.state === 'available') {
    if (!isValidCoordinates(location.latitude, location.longitude)) {
      throw new AlertValidationError('alert location coordinates are out of range');
    }
    if (
      location.accuracyMeters !== null &&
      (!Number.isFinite(location.accuracyMeters) || location.accuracyMeters < 0)
    ) {
      throw new AlertValidationError('alert location accuracy is invalid');
    }
    return;
  }
  if (location.state === 'unavailable') {
    if (!isLocationUnavailableReason(location.reason)) {
      throw new AlertValidationError('alert location unavailable-reason is invalid');
    }
    return;
  }
  throw new AlertValidationError('alert location state is invalid');
}

/**
 * Builds a new alert record. Always starts as `pending` with no server
 * receipt — a local insert must never imply delivery.
 */
export function createAlertRecord(input: NewAlertInput): AlertRecord {
  if (!isAlertCategory(input.category)) {
    throw new AlertValidationError('alert category is invalid');
  }
  validateAlertLocation(input.location);

  const createdAtUtc = input.createdAtUtc ?? new Date().toISOString();
  if (!isCanonicalUtcTimestamp(createdAtUtc)) {
    throw new AlertValidationError('alert creation timestamp must be canonical ISO-8601 UTC');
  }

  return {
    id: generateAlertId(),
    createdAtUtc,
    category: input.category,
    location: input.location,
    status: 'pending',
    serverReceipt: null,
    retryCount: 0,
    updatedAtUtc: createdAtUtc,
  };
}

const ALLOWED_TRANSITIONS: Record<AlertDeliveryStatus, readonly AlertDeliveryStatus[]> = {
  pending: ['sent', 'failed'],
  failed: ['pending', 'sent'],
  sent: [], // terminal: a delivered alert never reverts locally
};

export function canTransitionStatus(
  from: AlertDeliveryStatus,
  to: AlertDeliveryStatus,
): boolean {
  if (!isAlertDeliveryStatus(from) || !isAlertDeliveryStatus(to)) return false;
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertStatusTransition(
  from: AlertDeliveryStatus,
  to: AlertDeliveryStatus,
): void {
  if (!canTransitionStatus(from, to)) {
    throw new AlertValidationError(`disallowed alert status transition '${from}' -> '${to}'`);
  }
}

/**
 * A server receipt is mandatory before an alert may be marked `sent`;
 * retry metadata can never substitute for it.
 */
export function requireServerReceipt(receipt: string | null | undefined): string {
  if (typeof receipt !== 'string' || receipt.trim().length === 0) {
    throw new AlertValidationError(
      'a server receipt is required before an alert can be marked sent',
    );
  }
  if (receipt.length > MAX_SERVER_RECEIPT_LENGTH) {
    throw new AlertValidationError('server receipt is too long');
  }
  return receipt.trim();
}
