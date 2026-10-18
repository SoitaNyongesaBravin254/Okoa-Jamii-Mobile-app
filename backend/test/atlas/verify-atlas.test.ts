/**
 * [REAL ATLAS] — connects to the production Atlas cluster through the
 * backend's own `connectDatabase` code path (the same one the server and
 * `npm run verify:atlas` use).
 *
 * Deliberately OPT-IN and read-only:
 *   - RUN_ATLAS_TESTS=1 and MONGODB_URI must both be present; otherwise this
 *     suite reports as skipped, clearly labelled so CI output can never be
 *     confused with the isolated-test-database tier.
 *   - The only operation performed is `ping` plus listing collection names.
 *     Nothing is written, updated or deleted.
 *   - Assertions verify that no credential material appears in the probe /
 *     diagnosis output produced by the backend itself.
 *
 * TIER: integration / REAL ATLAS (opt-in).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { loadEnvironmentFiles } from '../../src/config/env';
import {
  connectDatabase,
  disconnectDatabase,
  probeConnection,
} from '../../src/db/connection';

loadEnvironmentFiles();

const runAtlasTests = process.env.RUN_ATLAS_TESTS === '1';
const atlasUri = process.env.MONGODB_URI?.trim() ?? '';
const enabled = runAtlasTests && atlasUri.length > 0;

const suiteName = enabled
  ? '[REAL ATLAS] backend connectivity through connectDatabase'
  : '[REAL ATLAS] backend connectivity (skipped: set RUN_ATLAS_TESTS=1 and MONGODB_URI to enable)';

const suite = enabled ? describe : describe.skip;

suite(suiteName, () => {
  beforeAll(async () => {
    await connectDatabase({ mongodbUri: atlasUri, serverSelectionTimeoutMs: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await disconnectDatabase();
  }, 30_000);

  it('reports a connected probe with no pending diagnosis', () => {
    const probe = probeConnection();
    expect(probe.connected).toBe(true);
    expect(probe.readyState).toBe(1);
    expect(probe.diagnosis).toBeNull();
    expect(probe.lastError).toBeNull();
  });

  it('answers a READ-ONLY ping through the active connection', async () => {
    const db = mongoose.connection.db;
    expect(db).toBeTruthy();
    const result = await db!.admin().command({ ping: 1 });
    expect(result.ok).toBe(1);
  });

  it('probe output contains no credential material', () => {
    const probe = probeConnection();
    const serialized = JSON.stringify(probe);
    expect(serialized).not.toContain('mongodb://');
    expect(serialized).not.toContain('mongodb+srv://');
    expect(serialized).not.toContain(atlasUri);
  });
});