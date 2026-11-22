/**
 * Platform-agnostic alert repository contract.
 *
 * Native platforms use the expo-sqlite implementation
 * (`sqlite-alert-repository.ts`); web uses an IndexedDB implementation
 * (`web-alert-repository.ts`). Screens, sync and submission code depend only
 * on this interface and on `getAlertRepository()`.
 */

import type { AlertDeliveryStatus, AlertRecord, NewAlertInput } from '@/types/alert';

export type UpdateStatusOptions = Readonly<{
  /** Required (non-empty) when moving an alert to `sent`. */
  serverReceipt?: string | null;
}>;

export interface AlertRepository {
  /** Opens/prepares storage. Safe to call repeatedly and concurrently. */
  initialize(): Promise<void>;
  /** Validates and persists a new alert. Always stored as `pending`. */
  createAlert(input: NewAlertInput): Promise<AlertRecord>;
  /** All alerts, newest first. */
  listAlerts(): Promise<AlertRecord[]>;
  /** Returns null when the id is unknown; throws on an invalid id. */
  getAlertById(id: string): Promise<AlertRecord | null>;
  /** Sync-queue view: only `pending` alerts, oldest first. */
  listPendingAlerts(): Promise<AlertRecord[]>;
  /** Applies a validated status transition; `sent` requires a receipt. */
  updateStatus(
    id: string,
    nextStatus: AlertDeliveryStatus,
    options?: UpdateStatusOptions,
  ): Promise<AlertRecord>;
  /** Explicit deletion of a single alert. Returns false when nothing matched. */
  deleteAlert(id: string): Promise<boolean>;
  /** Releases the underlying storage resources. */
  close(): Promise<void>;
}
