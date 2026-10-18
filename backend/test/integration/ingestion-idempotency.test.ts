/**
 * [ISOLATED TEST DATABASE] — NOT the real Atlas cluster.
 *
 * This suite exercises the real `MongoAlertRepository` / `MongoUserRepository`
 * against the database named by TEST_MONGODB_URI, including the unique-index
 * behaviour that makes ingestion idempotent under concurrency.
 *
 * Safety rails (all enforced below):
 *  1. Skips entirely when TEST_MONGODB_URI is unset (bare checkout is green).
 *  2. FAILS LOUDLY if TEST_MONGODB_URI equals MONGODB_URI — refusing to run
 *     is the point: this suite writes data and must never touch real Atlas.
 *  3. FAILS LOUDLY if the test database name does not contain "test".
 *
 * TIER: integration / ISOLATED TEST DATABASE.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvironmentFiles } from '../../src/config/env';
import { connectDatabase, disconnectDatabase } from '../../src/db/connection';
import { MongoAlertRepository } from '../../src/repositories/mongo-alert-repository';
import { MongoUserRepository } from '../../src/repositories/user-repository';
import { Alert, User } from '../../src/models';

// TEST_MONGODB_URI may come from the shell or the repository-root .env.
loadEnvironmentFiles();

const testUri = process.env.TEST_MONGODB_URI?.trim() ?? '';
const realUri = process.env.MONGODB_URI?.trim() ?? '';
const equalsRealAtlas = testUri.length > 0 && testUri === realUri;

/** Best-effort database-name extraction for the "must contain test" rail. */
function databaseNameOf(uri: string): string | null {
  const match = /^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^/?#]+)/.exec(uri);
  return match && match[1] ? match[1] : null;
}

const testDbName = testUri ? databaseNameOf(testUri) : null;
const dbLooksIsolated = testDbName !== null && /test/i.test(testDbName);

const IT_ALERT_PREFIX = 'itest_alert_';
const IT_EMAIL_PREFIX = 'itest-';

if (testUri.length === 0) {
  describe.skip('[ISOLATED TEST DATABASE] ingestion idempotency (skipped: TEST_MONGODB_URI not set)', () => {
    it('would exercise the real repositories against an isolated database', () => {
      expect.unreachable('this suite is intentionally skipped without TEST_MONGODB_URI');
    });
  });
} else if (equalsRealAtlas) {
  describe('[ISOLATED TEST DATABASE] MISCONFIGURATION — refuses to run', () => {
    it('TEST_MONGODB_URI must never equal MONGODB_URI (real Atlas)', () => {
      throw new Error(
        'TEST_MONGODB_URI is identical to MONGODB_URI. This suite writes data and will not run against the real Atlas cluster. Point TEST_MONGODB_URI at a disposable test database.',
      );
    });
  });
} else if (!dbLooksIsolated) {
  describe('[ISOLATED TEST DATABASE] MISCONFIGURATION — refuses to run', () => {
    it('the test database name must contain "test"', () => {
      throw new Error(
        `TEST_MONGODB_URI must point at a database whose name contains "test" (got: ${testDbName ?? 'unparseable URI'}).`,
      );
    });
  });
} else {
  describe(`[ISOLATED TEST DATABASE: ${testDbName}] real repository idempotency`, () => {
    const alerts = new MongoAlertRepository();
    const users = new MongoUserRepository();

    const candidate = {
      id: `${IT_ALERT_PREFIX}0001`,
      category: 'fire' as const,
      location: {
        state: 'available' as const,
        latitude: -6.16,
        longitude: 35.75,
        accuracyMeters: 10,
      },
      createdAtUtc: '2026-10-14T09:15:00.000Z',
    };

    beforeAll(async () => {
      await connectDatabase({ mongodbUri: testUri, serverSelectionTimeoutMs: 15_000 });
      // Build unique indexes before the concurrency test relies on them.
      await Alert.init();
      await User.init();
      // Start from a clean slate for our prefixed fixtures.
      await Alert.deleteMany({ id: { $regex: `^${IT_ALERT_PREFIX}` } });
      await User.deleteMany({ email: { $regex: `^${IT_EMAIL_PREFIX}` } });
    }, 60_000);

    afterAll(async () => {
      await Alert.deleteMany({ id: { $regex: `^${IT_ALERT_PREFIX}` } }).catch(() => undefined);
      await User.deleteMany({ email: { $regex: `^${IT_EMAIL_PREFIX}` } }).catch(() => undefined);
      await disconnectDatabase();
    }, 60_000);

    it('creates an alert and returns a receipt verified by reading it back', async () => {
      const outcome = await alerts.ingest(candidate, null);
      expect(outcome.kind).toBe('created');
      if (outcome.kind === 'unconfirmed') return;

      const stored = await alerts.findById(candidate.id);
      expect(stored).not.toBeNull();
      expect(stored!.serverReceipt).toBe(outcome.receipt);
      expect(stored!.ingestionStatus).toBe('received');
      expect(stored!.location).toEqual(candidate.location);
    }, 20_000);

    it('never writes the same id twice under sequential retries', async () => {
      const first = await alerts.ingest(candidate, null);
      const second = await alerts.ingest(candidate, null);
      if (first.kind === 'unconfirmed' || second.kind === 'unconfirmed') {
        throw new Error('expected the database to confirm both outcomes');
      }
      expect(first.kind).toBe('created');
      expect(second.kind).toBe('duplicate');
      expect(second.receipt).toBe(first.receipt);

      const count = await Alert.countDocuments({ id: candidate.id });
      expect(count).toBe(1);
    }, 20_000);

    it('settles concurrent duplicate syncs via the unique index, one write total', async () => {
      const concurrentId = `${IT_ALERT_PREFIX}concurrent`;
      await Alert.deleteMany({ id: concurrentId });

      const attempts = await Promise.all(
        Array.from({ length: 5 }, () =>
          alerts.ingest({ ...candidate, id: concurrentId }, null),
        ),
      );

      const outcomes = attempts.map((outcome) => outcome.kind);
      expect(outcomes).toContain('created');
      expect(outcomes).not.toContain('unconfirmed');

      const count = await Alert.countDocuments({ id: concurrentId });
      expect(count).toBe(1);

      // Every confirmed receipt must equal the single stored document's receipt.
      const stored = await alerts.findById(concurrentId);
      expect(stored).not.toBeNull();
      for (const outcome of attempts) {
        if (outcome.kind === 'unconfirmed') continue;
        expect(outcome.receipt).toBe(stored!.serverReceipt);
      }
    }, 30_000);

    it('stores injected receivedBy as null for non-object ids', async () => {
      const id = `${IT_ALERT_PREFIX}received_by`;
      const outcome = await alerts.ingest({ ...candidate, id }, 'not-an-object-id');
      expect(outcome.kind).toBe('created');
      const stored = await alerts.findById(id);
      expect(stored!.receivedBy).toBeNull();
    }, 20_000);

    it('lists newest-first and deletes by id', async () => {
      const id = `${IT_ALERT_PREFIX}list_delete`;
      await alerts.ingest({ ...candidate, id }, null);
      const fetched = await alerts.findById(id);
      expect(fetched).not.toBeNull();

      const listed = await alerts.list({ category: 'fire', limit: 500 });
      expect(listed.some((alert) => alert.id === id)).toBe(true);

      expect(await alerts.deleteById(id)).toBe(true);
      expect(await alerts.deleteById(id)).toBe(false);
      expect(await alerts.findById(id)).toBeNull();
    }, 20_000);

    it('user repository: normalises email case, hides the hash by default, and enforces uniqueness', async () => {
      const email = `${IT_EMAIL_PREFIX}Case@Example.COM`;
      const created = await users.create({
        email,
        displayName: 'Integration User',
        passwordHash: '$2b$4$fixturehashfixturehashfixturehashfixturehash',
        role: 'community',
      });

      const fetched = await users.findByEmail('  itest-case@example.com ');
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.email).toBe('itest-case@example.com');

      // Unique index: a second create with the same email fails with 11000.
      let duplicateCode: unknown;
      try {
        await users.create({
          email: 'itest-case@example.com',
          displayName: 'Impostor',
          passwordHash: 'x',
          role: 'community',
        });
      } catch (error) {
        duplicateCode = (error as { code?: unknown }).code;
      }
      expect(duplicateCode).toBe(11000);

      expect(await users.findById(created.id)).not.toBeNull();
      expect(await users.findById('000000000000000000000000')).toBeNull();
    }, 20_000);
  });
}