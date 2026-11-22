/**
 * In-memory fakes implementing the REAL repository interfaces.
 *
 * They exist so the service + HTTP layers can be tested end-to-end without
 * any database. `InMemoryAlertRepository` mirrors the MongoDB contract that
 * matters for idempotency: an id is stored at most once, a repeat insert
 * yields `duplicate` only by reading the stored document back, and a "lookup
 * failure" yields `unconfirmed` rather than a fabricated receipt.
 */

import { randomUUID } from 'node:crypto';
import { generateServerReceipt } from '../../src/domain/alerts';
import type {
  AlertCandidate,
  AlertRepository,
  IngestOutcome,
  ListAlertsOptions,
  StoredAlert,
} from '../../src/repositories/alert-repository';
import type {
  NewUser,
  StoredUser,
  StoredUserProfile,
  UserRepository,
} from '../../src/repositories/user-repository';

export class InMemoryAlertRepository implements AlertRepository {
  private readonly store = new Map<string, StoredAlert>();

  /** When true, the next ingest throws (simulates a storage outage). */
  failNextWrite = false;
  /** When true, duplicate lookups cannot read the stored document. */
  failDuplicateLookup = false;
  /** Total successful writes; lets tests assert no duplicate row was made. */
  writeCount = 0;

  get size(): number {
    return this.store.size;
  }

  all(): StoredAlert[] {
    return [...this.store.values()];
  }

  async ingest(candidate: AlertCandidate, receivedBy: string | null): Promise<IngestOutcome> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated storage failure');
    }

    const existing = this.store.get(candidate.id);
    if (existing) {
      // Duplicate path: a receipt is returned ONLY by reading it back.
      if (this.failDuplicateLookup) {
        return Object.freeze({ kind: 'unconfirmed' });
      }
      return Object.freeze({
        kind: 'duplicate',
        receipt: existing.serverReceipt,
        receivedAtUtc: existing.receivedAtUtc,
      });
    }

    this.writeCount += 1;
    const stored: StoredAlert = Object.freeze({
      id: candidate.id,
      category: candidate.category,
      location: candidate.location,
      createdAtUtc: candidate.createdAtUtc,
      receivedAtUtc: new Date().toISOString(),
      ingestionStatus: 'received' as const,
      serverReceipt: generateServerReceipt(),
      receivedBy,
    });
    this.store.set(candidate.id, stored);
    return Object.freeze({
      kind: 'created',
      receipt: stored.serverReceipt,
      receivedAtUtc: stored.receivedAtUtc,
    });
  }

  async findById(id: string): Promise<StoredAlert | null> {
    return this.store.get(id) ?? null;
  }

  async list(options: ListAlertsOptions = {}): Promise<readonly StoredAlert[]> {
    const limit = options.limit ?? 100;
    return [...this.store.values()]
      .filter((alert) => !options.category || alert.category === options.category)
      .sort((a, b) => (a.receivedAtUtc < b.receivedAtUtc ? 1 : -1))
      .slice(0, limit);
  }

  async deleteById(id: string): Promise<boolean> {
    return this.store.delete(id);
  }
}

export class InMemoryUserRepository implements UserRepository {
  private readonly byEmail = new Map<string, StoredUser>();
  private readonly byId = new Map<string, StoredUser>();

  async findByEmail(email: string): Promise<StoredUser | null> {
    return this.byEmail.get(email.trim().toLowerCase()) ?? null;
  }

  async findById(id: string): Promise<StoredUser | null> {
    return this.byId.get(id) ?? null;
  }

  async findProfileById(id: string): Promise<StoredUserProfile | null> {
    const user = this.byId.get(id);
    if (!user) return null;
    // Mirrors the Mongo projection: the hash is not part of a profile read.
    return Object.freeze({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    });
  }

  async create(user: NewUser): Promise<StoredUser> {
    const email = user.email.trim().toLowerCase();
    if (this.byEmail.has(email)) {
      // Same shape MongoDB produces for a unique-index violation.
      throw Object.assign(
        new Error(`E11000 duplicate key error collection: users index: ${email}`),
        { code: 11000 },
      );
    }
    const stored: StoredUser = Object.freeze({
      id: randomUUID(),
      email,
      displayName: user.displayName,
      passwordHash: user.passwordHash,
      role: user.role,
    });
    this.byEmail.set(email, stored);
    this.byId.set(stored.id, stored);
    return stored;
  }

  /** Test convenience: total users stored. */
  get size(): number {
    return this.byEmail.size;
  }

  /** Test convenience: seed a role for RBAC fixtures. */
  promote(userId: string, role: StoredUser['role']): void {
    const user = this.byId.get(userId);
    if (!user) throw new Error('cannot promote an unknown user');
    const updated: StoredUser = Object.freeze({ ...user, role });
    this.byId.set(userId, updated);
    this.byEmail.set(user.email, updated);
  }

  /** Test convenience: simulate account deletion (no delete API exists yet). */
  remove(userId: string): boolean {
    const user = this.byId.get(userId);
    if (!user) return false;
    this.byId.delete(userId);
    this.byEmail.delete(user.email);
    return true;
  }
}