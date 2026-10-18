/**
 * Alert payload validation tests — the exact rules the mobile model encodes,
 * enforced at the server boundary so a client can never smuggle
 * server-owned fields or fabricate coordinates.
 *
 * TIER: unit. No database (service runs against the in-memory repository).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/lib/errors';
import { createAlertService, type AlertService } from '../../src/services/alert-service';
import { createSilentLogger } from '../../src/lib/logger';
import { InMemoryAlertRepository } from '../helpers/fakes';

function setup(): { service: AlertService; repo: InMemoryAlertRepository } {
  const repo = new InMemoryAlertRepository();
  const service = createAlertService({ alerts: repo, logger: createSilentLogger() });
  return { service, repo };
}

const VALID_PAYLOAD = {
  id: 'alert_abc_123',
  category: 'fire',
  location: { state: 'available', latitude: -6.16, longitude: 35.75, accuracyMeters: 8 },
  createdAtUtc: '2026-10-14T09:15:00.000Z',
};

async function expectRejected(service: AlertService, payload: unknown): Promise<ValidationError> {
  let caught: unknown;
  try {
    await service.ingestAlert(null, payload);
  } catch (error) {
    caught = error;
  }
  expect(caught, JSON.stringify(payload)).toBeInstanceOf(ValidationError);
  return caught as ValidationError;
}

describe('valid alert payloads', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('accepts an available-location payload and returns a server receipt', async () => {
    const result = await ctx.service.ingestAlert(null, VALID_PAYLOAD);
    expect(result.ok).toBe(true);
    expect(result.alert.id).toBe(VALID_PAYLOAD.id);
    expect(result.alert.category).toBe('fire');
    expect(result.alert.status).toBe('received');
    expect(result.alert.serverReceipt).toMatch(/^rcpt_/);
    expect(result.alert.duplicate).toBe(false);
    expect(result.alert.receivedAtUtc).not.toBe('');
  });

  it('accepts every mobile alert category', async () => {
    let counter = 0;
    for (const category of ['security', 'medical', 'fire', 'flood', 'other'] as const) {
      counter += 1;
      const result = await ctx.service.ingestAlert(null, {
        ...VALID_PAYLOAD,
        id: `alert_cat_${counter}`,
        category,
      });
      expect(result.alert.category).toBe(category);
    }
  });

  it('accepts an unavailable-location payload (coordinates are never fabricated)', async () => {
    const result = await ctx.service.ingestAlert(null, {
      ...VALID_PAYLOAD,
      id: 'alert_no_loc',
      location: { state: 'unavailable', reason: 'permission-denied' },
    });
    expect(result.ok).toBe(true);
    const stored = await ctx.repo.findById('alert_no_loc');
    expect(stored!.location).toEqual({ state: 'unavailable', reason: 'permission-denied' });
  });

  it('defaults createdAtUtc when the client omits it', async () => {
    const { createdAtUtc: _omitted, ...withoutTimestamp } = VALID_PAYLOAD;
    const result = await ctx.service.ingestAlert(null, {
      ...withoutTimestamp,
      id: 'alert_no_ts',
    });
    expect(result.alert.createdAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

describe('alert payload rejection', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('rejects missing or empty id', async () => {
    for (const id of ['', undefined, 42]) {
      const error = await expectRejected(ctx.service, { ...VALID_PAYLOAD, id });
      expect(error.issues.length).toBeGreaterThan(0);
    }
    expect(ctx.repo.size).toBe(0);
  });

  it('rejects an id longer than 128 characters or with control characters', async () => {
    await expectRejected(ctx.service, { ...VALID_PAYLOAD, id: 'x'.repeat(129) });
    const error = await expectRejected(ctx.service, {
      ...VALID_PAYLOAD,
      id: 'alert\u0001break',
    });
    expect(error.issues.join(' ')).toContain('control_characters');
    expect(ctx.repo.size).toBe(0);
  });

  it('rejects an unknown category', async () => {
    const error = await expectRejected(ctx.service, {
      ...VALID_PAYLOAD,
      category: 'zombie-attack',
    });
    expect(error.issues.length).toBeGreaterThan(0);
    expect(ctx.repo.size).toBe(0);
  });

  it('rejects out-of-range coordinates', async () => {
    await expectRejected(ctx.service, {
      ...VALID_PAYLOAD,
      location: { state: 'available', latitude: 999, longitude: 0, accuracyMeters: 5 },
    });
    await expectRejected(ctx.service, {
      ...VALID_PAYLOAD,
      location: { state: 'available', latitude: 0, longitude: -500, accuracyMeters: 5 },
    });
    expect(ctx.repo.size).toBe(0);
  });

  it('rejects invalid accuracy or a bogus unavailable reason', async () => {
    await expectRejected(ctx.service, {
      ...VALID_PAYLOAD,
      location: { state: 'available', latitude: 0, longitude: 0, accuracyMeters: -1 },
    });
    await expectRejected(ctx.service, {
      ...VALID_PAYLOAD,
      location: { state: 'unavailable', reason: 'made-up-reason' },
    });
    expect(ctx.repo.size).toBe(0);

    // `accuracyMeters: null` is VALID — it is how the mobile model records
    // "device did not report an accuracy" (never fabricated, never omitted).
    const result = await ctx.service.ingestAlert(null, {
      ...VALID_PAYLOAD,
      id: 'alert_null_accuracy',
      location: { state: 'available', latitude: 1, longitude: 2, accuracyMeters: null },
    });
    expect(result.ok).toBe(true);
    const stored = await ctx.repo.findById('alert_null_accuracy');
    expect(stored!.location).toEqual({
      state: 'available',
      latitude: 1,
      longitude: 2,
      accuracyMeters: null,
    });
  });

  it('rejects non-canonical timestamps but accepts canonical ISO UTC', async () => {
    await expectRejected(ctx.service, {
      ...VALID_PAYLOAD,
      createdAtUtc: '2026-10-14T09:15:00Z',
    });
    await expectRejected(ctx.service, { ...VALID_PAYLOAD, createdAtUtc: 'yesterday' });
    // canonical form passes (covered in the happy-path suite)
    expect((await ctx.service.ingestAlert(null, VALID_PAYLOAD)).ok).toBe(true);
  });

  it('rejects server-owned fields smuggled by the client (strict schema)', async () => {
    for (const extra of [
      { serverReceipt: 'rcpt_forged' },
      { status: 'sent' },
      { receivedAtUtc: '2026-01-01T00:00:00.000Z' },
      { receivedBy: 'someone-else' },
      { retryCount: 99 },
    ]) {
      await expectRejected(ctx.service, { ...VALID_PAYLOAD, ...extra, id: `smuggle_${Date.now()}_${Math.random()}` });
    }
    expect(ctx.repo.size).toBe(0);
    // Nothing was stored, so a forged receipt can never be observed later.
    expect(await ctx.repo.findById(VALID_PAYLOAD.id)).toBeNull();
  });

  it('rejects a malformed location discriminator and unknown nested keys', async () => {
    await expectRejected(ctx.service, {
      ...VALID_PAYLOAD,
      location: { state: 'approximate', latitude: 1, longitude: 1 },
    });
    await expectRejected(ctx.service, {
      ...VALID_PAYLOAD,
      location: { state: 'available', latitude: 1, longitude: 1, accuracyMeters: 1, hint: 'x' },
    });
  });

  it('rejects null, strings and arrays as the whole payload', async () => {
    for (const payload of [null, 'alert', 42, [VALID_PAYLOAD]]) {
      await expectRejected(ctx.service, payload);
    }
    expect(ctx.repo.size).toBe(0);
  });

  it('log lines for rejections carry field codes only, never payload values', async () => {
    const records: { message: string; meta?: unknown }[] = [];
    const repo = new InMemoryAlertRepository();
    const service = createAlertService({
      alerts: repo,
      logger: {
        level: 'debug',
        debug: () => undefined,
        info: () => undefined,
        warn: (message, meta) => records.push({ message, meta }),
        error: () => undefined,
      },
    });
    await expectRejected(service, {
      ...VALID_PAYLOAD,
      id: 'id-with-secret-marker',
      category: 'nope',
    });
    expect(records).toHaveLength(1);
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain('id-with-secret-marker');
    expect(serialized).not.toContain('nope');
  });
});