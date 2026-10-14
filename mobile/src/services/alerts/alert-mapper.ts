/**
 * Maps SQLite rows to alert records, validating every field so a corrupted
 * row surfaces as an error instead of a silently wrong record.
 * Error messages never include stored values.
 */

import { AlertStorageError } from './alert-errors';
import {
  isAlertCategory,
  isAlertDeliveryStatus,
  isCanonicalUtcTimestamp,
  isLocationUnavailableReason,
  isValidAlertId,
  isValidCoordinates,
} from './alert-model';
import type { SqlValue } from './sql-driver';
import type { AlertRecord } from '@/types/alert';

export type AlertRow = Readonly<{
  id: string;
  created_at_utc: string;
  category: string;
  status: string;
  location_state: string;
  latitude: number | null;
  longitude: number | null;
  location_accuracy: number | null;
  location_unavailable_reason: string | null;
  server_receipt: string | null;
  retry_count: number;
  updated_at_utc: string;
}>;

/** Column list used by every SELECT so rows always map completely. */
export const ALERT_COLUMNS =
  'id, created_at_utc, category, status, location_state, latitude, longitude, ' +
  'location_accuracy, location_unavailable_reason, server_receipt, retry_count, updated_at_utc';

export const INSERT_ALERT_SQL =
  'INSERT INTO alerts (id, created_at_utc, category, status, location_state, latitude, ' +
  'longitude, location_accuracy, location_unavailable_reason, server_receipt, retry_count, ' +
  'updated_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

/** Ordered parameters matching INSERT_ALERT_SQL for the given record. */
export function insertAlertParams(alert: AlertRecord): SqlValue[] {
  const location = alert.location;
  return [
    alert.id,
    alert.createdAtUtc,
    alert.category,
    alert.status,
    location.state,
    location.state === 'available' ? location.latitude : null,
    location.state === 'available' ? location.longitude : null,
    location.state === 'available' ? location.accuracyMeters : null,
    location.state === 'unavailable' ? location.reason : null,
    alert.serverReceipt,
    alert.retryCount,
    alert.updatedAtUtc,
  ];
}

export function rowToAlert(row: AlertRow): AlertRecord {
  if (
    !isValidAlertId(row.id) ||
    !isAlertCategory(row.category) ||
    !isAlertDeliveryStatus(row.status) ||
    !isCanonicalUtcTimestamp(row.created_at_utc) ||
    !isCanonicalUtcTimestamp(row.updated_at_utc) ||
    !Number.isInteger(row.retry_count) ||
    row.retry_count < 0 ||
    (row.server_receipt !== null && typeof row.server_receipt !== 'string')
  ) {
    throw new AlertStorageError('stored alert row failed validation');
  }

  return {
    id: row.id,
    createdAtUtc: row.created_at_utc,
    category: row.category,
    status: row.status,
    location: rowToLocation(row),
    serverReceipt: row.server_receipt,
    retryCount: row.retry_count,
    updatedAtUtc: row.updated_at_utc,
  };
}

function rowToLocation(row: AlertRow): AlertRecord['location'] {
  if (row.location_state === 'available') {
    const { latitude, longitude } = row;
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      !isValidCoordinates(latitude, longitude)
    ) {
      throw new AlertStorageError('stored alert row failed validation');
    }
    if (
      row.location_accuracy !== null &&
      (typeof row.location_accuracy !== 'number' || row.location_accuracy < 0)
    ) {
      throw new AlertStorageError('stored alert row failed validation');
    }
    return {
      state: 'available',
      latitude,
      longitude,
      accuracyMeters: row.location_accuracy,
    };
  }

  if (row.location_state === 'unavailable') {
    if (
      row.latitude !== null ||
      row.longitude !== null ||
      !isLocationUnavailableReason(row.location_unavailable_reason)
    ) {
      throw new AlertStorageError('stored alert row failed validation');
    }
    return { state: 'unavailable', reason: row.location_unavailable_reason };
  }

  throw new AlertStorageError('stored alert row failed validation');
}
