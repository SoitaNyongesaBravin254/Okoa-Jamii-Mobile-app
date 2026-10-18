/**
 * Server-side alert domain.
 *
 * Mirrors `mobile/src/types/alert.ts` and the invariants of
 * `mobile/src/services/alerts/alert-model.ts`, because this API is the
 * receiving end of that client. Divergence here would let the server accept
 * something the phone can never legitimately produce — for example
 * fabricated coordinates.
 *
 * Deliberate difference: `serverReceipt` is SERVER-OWNED. The client sends
 * `id`, `category`, `location` and optionally `createdAtUtc`; the server
 * assigns status, receipt and timestamps. Ingestion status is `received`,
 * which is not the device's `pending | sent | failed` delivery state.
 */

import { z } from 'zod';

export const ALERT_CATEGORIES = [
  'security',
  'medical',
  'fire',
  'flood',
  'other',
] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export const LOCATION_UNAVAILABLE_REASONS = [
  'permission-denied',
  'service-disabled',
  'timeout',
  'unknown',
] as const;
export type LocationUnavailableReason = (typeof LOCATION_UNAVAILABLE_REASONS)[number];

export type AlertLocation =
  | Readonly<{
      state: 'available';
      latitude: number;
      longitude: number;
      accuracyMeters: number | null;
    }>
  | Readonly<{ state: 'unavailable'; reason: LocationUnavailableReason }>;

/** Server-side ingestion state. Distinct from the device's delivery status. */
export const INGESTION_STATUSES = ['received'] as const;
export type IngestionStatus = (typeof INGESTION_STATUSES)[number];

export const MAX_ALERT_ID_LENGTH = 128;
export const MAX_SERVER_RECEIPT_LENGTH = 256;
export const MAX_DISPLAY_NAME_LENGTH = 120;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isAlertCategory(value: unknown): value is AlertCategory {
  return (
    typeof value === 'string' && (ALERT_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isLocationUnavailableReason(
  value: unknown,
): value is LocationUnavailableReason {
  return (
    typeof value === 'string' &&
    (LOCATION_UNAVAILABLE_REASONS as readonly string[]).includes(value)
  );
}

/** Same rule as the mobile model: non-empty, bounded, no control characters. */
export function isValidAlertId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_ALERT_ID_LENGTH &&
    !hasControlCharacters(id)
  );
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

/** True only for canonical `toISOString()` output, e.g. `2026-10-14T09:15:00.000Z`. */
export function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

export function validateAlertLocation(location: AlertLocation): void {
  // Runtime-defensive: JS callers may pass null/undefined despite the type.
  const candidate: unknown = location;
  if (candidate === null || candidate === undefined || typeof candidate !== 'object') {
    throw new Error('alert location is missing');
  }
  if (location.state === 'available') {
    if (!isValidCoordinates(location.latitude, location.longitude)) {
      throw new Error('alert location coordinates are out of range');
    }
    if (
      location.accuracyMeters !== null &&
      (!Number.isFinite(location.accuracyMeters) || location.accuracyMeters < 0)
    ) {
      throw new Error('alert location accuracy is invalid');
    }
    return;
  }
  if (location.state === 'unavailable') {
    if (!isLocationUnavailableReason(location.reason)) {
      throw new Error('alert location unavailable-reason is invalid');
    }
    return;
  }
  throw new Error('alert location state is invalid');
}

/** Build a runtime/Zod description of an `AlertLocation`. */
const availableLocationSchema = z.strictObject({
  state: z.literal('available'),
  latitude: z.number().refine((value) => Number.isFinite(value) && value >= -90 && value <= 90, {
    error: 'out_of_range',
  }),
  longitude: z.number().refine((value) => Number.isFinite(value) && value >= -180 && value <= 180, {
    error: 'out_of_range',
  }),
  accuracyMeters: z
    .number()
    .refine((value) => Number.isFinite(value) && value >= 0, { error: 'invalid' })
    .nullable(),
});

const unavailableLocationSchema = z.strictObject({
  state: z.literal('unavailable'),
  reason: z.enum(LOCATION_UNAVAILABLE_REASONS),
});

export const alertLocationSchema = z.discriminatedUnion('state', [
  availableLocationSchema,
  unavailableLocationSchema,
]);

/**
 * Ingestion payload exactly as a synced mobile client sends it.
 *
 * `.strict()` rejects unknown keys, so a client cannot smuggle in
 * `serverReceipt`, `status`, `retryCount` or another user's `receivedBy`.
 */
export const ingestAlertInputSchema = z.strictObject({
  id: z
    .string()
    .min(1, { error: 'required' })
    .max(MAX_ALERT_ID_LENGTH, { error: 'too_long' })
    .refine((value) => !hasControlCharacters(value), { error: 'control_characters' }),
  category: z.enum(ALERT_CATEGORIES),
  location: alertLocationSchema,
  createdAtUtc: z
    .string()
    .refine(isCanonicalUtcTimestamp, { error: 'not_canonical_utc' })
    .optional(),
});

export type IngestAlertInput = z.infer<typeof ingestAlertInputSchema>;

/** A validated alert ready to be handed to a repository. */
export type AlertCandidate = Readonly<{
  id: string;
  category: AlertCategory;
  location: AlertLocation;
  createdAtUtc: string;
}>;

/** Receipt issued by this server. Opaque to the client. */
export function generateServerReceipt(): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 12);
  return `rcpt_${time}_${random}`;
}
