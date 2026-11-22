/**
 * Storage primitive used by the web alert repository.
 *
 * Implementations must be durable for the current browser profile and must
 * surface every write failure; there is deliberately no in-memory fallback,
 * because an alert reported as saved must actually be stored.
 */

import type { AlertRecord } from '@/types/alert';

export interface AlertStore {
  /** Opens/prepares the underlying storage. Throws when unavailable. */
  ensureOpen(): Promise<void>;
  /** All stored alerts, in the store's natural order (not presentation order). */
  list(): Promise<AlertRecord[]>;
  /** Returns null when the id is not stored. */
  get(id: string): Promise<AlertRecord | null>;
  /** Inserts a new alert. Must fail rather than overwrite an existing id. */
  add(alert: AlertRecord): Promise<void>;
  /**
   * Reads, applies and writes atomically (one transaction), so concurrent
   * status changes cannot interleave or lose a server receipt. If `apply`
   * throws, nothing is written and the error propagates.
   */
  update(
    id: string,
    apply: (current: AlertRecord | null) => AlertRecord,
  ): Promise<AlertRecord>;
  /** Deletes one alert. Returns false when nothing matched. */
  remove(id: string): Promise<boolean>;
  /** Closes the underlying connection. Safe to call repeatedly. */
  close(): Promise<void>;
}
