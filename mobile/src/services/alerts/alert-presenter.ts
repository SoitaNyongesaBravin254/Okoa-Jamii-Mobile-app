/**
 * Pure presentation helpers for alert UI (SOS result + history screen).
 *
 * These deliberately expose NO coordinate values: the history list shows
 * whether a location was attached, never where the user was. Status labels
 * clearly separate "saved on this device" from server-confirmed delivery.
 */

import type {
  AlertCategory,
  AlertDeliveryStatus,
  AlertLocation,
  AlertRecord,
  LocationUnavailableReason,
} from '@/types/alert';

export const ALERT_CATEGORY_LABELS: Record<AlertCategory, string> = {
  security: 'Security',
  medical: 'Medical',
  fire: 'Fire',
  flood: 'Flood',
  other: 'Other',
};

export type AlertStatusPresentation = Readonly<{
  label: string;
  /** Banner tone hint for the UI: 'info' | 'warning' | 'success'. */
  tone: 'info' | 'warning' | 'success';
  /** True only for server-confirmed delivery. */
  isServerConfirmed: boolean;
}>;

const STATUS_PRESENTATION: Record<AlertDeliveryStatus, AlertStatusPresentation> = {
  pending: {
    label: 'Saved on this device — not yet sent',
    tone: 'info',
    isServerConfirmed: false,
  },
  failed: {
    label: 'Delivery failed — still saved on this device',
    tone: 'warning',
    isServerConfirmed: false,
  },
  sent: {
    label: 'Confirmed received by server',
    tone: 'success',
    isServerConfirmed: true,
  },
};

const LOCATION_UNAVAILABLE_LABELS: Record<LocationUnavailableReason, string> = {
  'permission-denied': 'Location permission denied',
  'service-disabled': 'Location services off',
  timeout: 'Location timed out',
  unknown: 'Location unavailable',
};

/** Human label for a category (for pickers and history rows). */
export function presentAlertCategory(category: AlertCategory): string {
  return ALERT_CATEGORY_LABELS[category];
}

/**
 * Status label that never overstates delivery: only the `sent` status is
 * presented as server-confirmed, and that status requires a real receipt.
 */
export function presentAlertStatus(status: AlertDeliveryStatus): AlertStatusPresentation {
  return STATUS_PRESENTATION[status];
}

/**
 * Location summary for UI. Returns a description only — precise coordinates
 * are intentionally not part of any presentation output.
 */
export function presentAlertLocation(
  location: AlertLocation,
): string {
  return location.state === 'available'
    ? 'Location attached'
    : LOCATION_UNAVAILABLE_LABELS[location.reason];
}

/** Everything a history row needs, with no coordinates included. */
export type AlertHistoryItem = Readonly<{
  id: string;
  categoryLabel: string;
  /** Local-time display string derived from the stored UTC timestamp. */
  createdLabel: string;
  status: AlertStatusPresentation;
  locationLabel: string;
  retryCount: number;
}>;

export function presentAlertHistoryItem(alert: AlertRecord): AlertHistoryItem {
  return {
    id: alert.id,
    categoryLabel: presentAlertCategory(alert.category),
    createdLabel: formatUtcForDisplay(alert.createdAtUtc),
    status: presentAlertStatus(alert.status),
    locationLabel: presentAlertLocation(alert.location),
    retryCount: alert.retryCount,
  };
}

/**
 * Formats a canonical UTC timestamp for local display. Invalid input (which
 * the repository never produces) falls back to the raw string rather than
 * inventing a date.
 */
export function formatUtcForDisplay(utc: string): string {
  const parsed = Date.parse(utc);
  if (Number.isNaN(parsed)) return utc;
  return new Date(parsed).toLocaleString();
}
