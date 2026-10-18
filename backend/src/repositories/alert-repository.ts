/**
 * Alert repository contract.
 *
 * The interface exists so the ingestion invariant can be enforced and tested
 * without MongoDB:
 *
 *   A server receipt may only be produced by a SUCCESSFUL WRITE, or by a
 *   VERIFIED DUPLICATE LOOKUP that actually returned a stored document.
 *
 * `unavailable` is the third outcome for a reason that is easy to get wrong:
 * when a write fails *and* the follow-up lookup cannot confirm anything, the
 * caller must be told to retry rather than handed a fabricated receipt.
 */

import type { AlertCategory, AlertLocation, IngestionStatus } from '../domain/alerts';

export type AlertCandidate = Readonly<{
  id: string;
  category: AlertCategory;
  location: AlertLocation;
  createdAtUtc: string;
}>;

/** Read model returned to handlers. */
export type StoredAlert = Readonly<{
  id: string;
  category: AlertCategory;
  location: AlertLocation;
  createdAtUtc: string;
  receivedAtUtc: string;
  ingestionStatus: IngestionStatus;
  serverReceipt: string;
  receivedBy: string | null;
}>;

export type IngestOutcome =
  | Readonly<{ kind: 'created'; receipt: string; receivedAtUtc: string }>
  | Readonly<{ kind: 'duplicate'; receipt: string; receivedAtUtc: string }>
  /** Neither a write nor a lookup could be confirmed. No receipt exists. */
  | Readonly<{ kind: 'unconfirmed' }>;

export type ListAlertsOptions = Readonly<{
  limit?: number;
  category?: AlertCategory;
}>;

export interface AlertRepository {
  /**
   * Persists a new alert, or confirms an already-stored one with the same
   * client id. Must never resolve with a receipt that was neither written
   * nor read back.
   */
  ingest(candidate: AlertCandidate, receivedBy: string | null): Promise<IngestOutcome>;

  /** Returns null when the id is unknown. */
  findById(id: string): Promise<StoredAlert | null>;

  /** Newest first. */
  list(options?: ListAlertsOptions): Promise<readonly StoredAlert[]>;

  /** Returns false when nothing matched. */
  deleteById(id: string): Promise<boolean>;
}
