/**
 * Idempotency tests for alert ingestion — the "receipt invariant":
 *
 *   A server receipt is returned ONLY after (a) a successful database write,
 *   or (b) a duplicate lookup that actually read the stored document back.
 *   When neither can be confirmed, the client gets a retryable error and NO
 *   receipt, ever.
 *
 * TIER: unit. The repository here is in-memory but implements the real
 * `AlertRepository` contract; the database-level idempotency (unique index)
 * is additionally proven in test/integration against an isolated database.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ServiceUnavailableError } from '../../src/lib/errors';
import { createAlertService, type AlertService } from '../../src/services/alert-service';
import { createSilentLogger } from '../../src/lib/logger';
import { InMemoryAlertRepository } from '../helpers/fakes';

const PAYLOAD = {
  id: 'alert_idem_0001',
  category: 'medical',
  location: { state: 'unavailable', reason: 'timeout' },
  createdAtUtc: '2026-10-10T12:00:00.000Z',
};

function setup(): { service: AlertService; repo: InMemoryAlertRepository } {
  const repo = new InMemoryAlertRepository();
  const service = createAlertService({ alerts: repo, logger: createSilentLogger() });
  return { service, repo };
}

describe('idempotent ingestion', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('first delivery creates the alert and returns the stored receipt', async () => {
    const first = await ctx.service.ingestAlert(null, PAYLOAD);
    expect(first.alert.duplicate).toBe(false);
    expect(first.alert.serverReceipt).toMatch(/^rcpt_/);
    expect(ctx.repo.writeCount).toBe(1);

    // The returned receipt EQUALS the receipt on the stored document.
    const stored = await ctx.repo.findById(PAYLOAD.id);
    expect(stored!.serverReceipt).toBe(first.alert.serverReceipt);
  });

  it('a repeated delivery is marked duplicate and returns the SAME receipt', async () => {
    const first = await ctx.service.ingestAlert(null, PAYLOAD);
    const second = await ctx.service.ingestAlert(null, PAYLOAD);

    expect(second.alert.duplicate).toBe(true);
    expect(second.alert.serverReceipt).toBe(first.alert.serverReceipt);
    expect(second.alert.receivedAtUtc).toBe(first.alert.receivedAtUtc);

    // No second row, no second write.
    expect(ctx.repo.size).toBe(1);
    expect(ctx.repo.writeCount).toBe(1);
  });

  it('different ids are independent alerts', async () => {
    await ctx.service.ingestAlert(null, PAYLOAD);
    const other = await ctx.service.ingestAlert(null, { ...PAYLOAD, id: 'alert_idem_0002' });
    expect(other.alert.duplicate).toBe(false);
    expect(ctx.repo.size).toBe(2);
  });

  it('concurrent deliveries of the same id all converge on one receipt', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ctx.service.ingestAlert(null, PAYLOAD)),
    );
    const receipts = new Set(results.map((result) => result.alert.serverReceipt));
    expect(receipts.size).toBe(1);
    expect(ctx.repo.size).toBe(1);
    expect(ctx.repo.writeCount).toBe(1);
    const createdAt = results.filter((result) => !result.alert.duplicate);
    expect(createdAt).toHaveLength(1);
  });

  it('a failed write surfaces as 503 and returns NO receipt', async () => {
    ctx.repo.failNextWrite = true;
    let caught: unknown;
    try {
      await ctx.service.ingestAlert(null, PAYLOAD);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableError);
    expect((caught as ServiceUnavailableError).statusCode).toBe(503);
    // The error body must not contain any receipt material.
    const body = JSON.stringify({
      message: (caught as Error).message,
      issues: (caught as { issues?: string[] }).issues,
    });
    expect(body).not.toContain('rcpt_');
    // Nothing was stored: the client's retry cannot be mistaken for success.
    expect(await ctx.repo.findById(PAYLOAD.id)).toBeNull();
  });

  it('an unverifiable duplicate (lookup failure) yields 503, not a receipt', async () => {
    // Seed the stored document, then break the read-back path.
    const first = await ctx.service.ingestAlert(null, PAYLOAD);
    ctx.repo.failDuplicateLookup = true;

    let caught: unknown;
    try {
      await ctx.service.ingestAlert(null, PAYLOAD);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableError);
    const body = JSON.stringify({ message: (caught as Error).message });
    expect(body).not.toContain('rcpt_');
    expect(body).not.toContain(first.alert.serverReceipt);

    // Once the lookup works again, the same receipt is returned (healed).
    ctx.repo.failDuplicateLookup = false;
    const retried = await ctx.service.ingestAlert(null, PAYLOAD);
    expect(retried.alert.serverReceipt).toBe(first.alert.serverReceipt);
    expect(retried.alert.duplicate).toBe(true);
  });

  it('storage exceptions never leak driver messages to the client', async () => {
    ctx.repo.failNextWrite = true;
    try {
      await ctx.service.ingestAlert(null, PAYLOAD);
      expect.unreachable('expected ServiceUnavailableError');
    } catch (error) {
      expect((error as Error).message).not.toContain('simulated storage failure');
      expect((error as Error).message).toMatch(/could not be recorded/i);
    }
  });
});

describe('alert id generation invariants (server side)', () => {
  it('receipts are unique across creations', async () => {
    const ctx = setup();
    const receipts = new Set<string>();
    for (let index = 0; index < 25; index += 1) {
      const result = await ctx.service.ingestAlert(null, {
        ...PAYLOAD,
        id: `alert_uniq_${index}`,
      });
      receipts.add(result.alert.serverReceipt);
    }
    expect(receipts.size).toBe(25);
  });
});