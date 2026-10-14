/**
 * Emergency alert model types.
 *
 * Privacy rules encoded in this model:
 * - No passwords, tokens, or unnecessary personal data are stored on alerts.
 * - Coordinates exist only when real device coordinates were available
 *   (`state: 'available'`); otherwise an explicit unavailable reason is stored.
 *   Coordinates are never fabricated.
 * - `serverReceipt` stays null until a real backend confirms receipt; a local
 *   insert always starts as `pending`.
 * Keep this file free of runtime code.
 */

export type AlertCategory = 'security' | 'medical' | 'fire' | 'flood' | 'other';

export type AlertDeliveryStatus = 'pending' | 'sent' | 'failed';

export type LocationUnavailableReason =
  | 'permission-denied'
  | 'service-disabled'
  | 'timeout'
  | 'unknown';

export type AlertLocation =
  | Readonly<{
      state: 'available';
      latitude: number;
      longitude: number;
      /** Device-reported accuracy in meters, when the device provided one. */
      accuracyMeters: number | null;
    }>
  | Readonly<{
      state: 'unavailable';
      reason: LocationUnavailableReason;
    }>;

export type AlertRecord = Readonly<{
  /** Locally generated unique id. */
  id: string;
  /** Canonical ISO-8601 UTC timestamp. */
  createdAtUtc: string;
  category: AlertCategory;
  location: AlertLocation;
  /** Local delivery status — NOT proof of responder delivery. */
  status: AlertDeliveryStatus;
  /** Backend receipt/reference; null until a real backend confirms receipt. */
  serverReceipt: string | null;
  /** How many times this alert has been re-queued for a sync attempt. */
  retryCount: number;
  /** Canonical ISO-8601 UTC timestamp of the last local modification. */
  updatedAtUtc: string;
}>;

export type NewAlertInput = Readonly<{
  category: AlertCategory;
  location: AlertLocation;
  /**
   * Optional creation timestamp override (canonical ISO-8601 UTC string).
   * Intended for tests; callers should normally omit it to use the real time.
   */
  createdAtUtc?: string;
}>;
