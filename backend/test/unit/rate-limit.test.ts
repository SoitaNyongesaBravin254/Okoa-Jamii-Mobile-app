/**
 * Rate limiting over the REAL HTTP stack (in-memory fakes, no database).
 *
 * Covers two Phase-1 hardening properties:
 *   1. A 429 uses the project's standard error envelope and the stable
 *      `rate-limited` code, with no internal detail in the body.
 *   2. Client-IP bucketing follows the configured proxy trust: a trusted
 *      X-Forwarded-For separates clients, an untrusted one cannot.
 *
 * The limiter is mounted only when `config.isTest` is false, so these suites
 * build the app with `isTest: false` explicitly. The auth limiter budget
 * (30 requests / 15 min) is the one exercised: it is small enough to trip.
 *
 * TIER: unit. No database.
 */

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/build-app';
import { RateLimitedError } from '../../src/lib/errors';

const AUTH_PATH = '/api/v1/auth/me';
const AUTH_LIMIT = 30;

/** A trusted proxy rewrites X-Forwarded-For; these stand in for real clients. */
const CLIENT_A = '198.51.100.10';
const CLIENT_B = '203.0.113.27';

/** Sends one anonymous request; /auth/me answers 401 without touching the DB. */
function hitAuth(ctx: TestApp, forwardedFor?: string) {
  const req = request(ctx.app).get(AUTH_PATH);
  return forwardedFor === undefined ? req : req.set('X-Forwarded-For', forwardedFor);
}

async function exhaustAuthBudget(ctx: TestApp, forwardedFor: string): Promise<void> {
  for (let i = 0; i < AUTH_LIMIT; i += 1) {
    const response = await hitAuth(ctx, forwardedFor);
    expect(response.status).toBe(401);
  }
}

/** Codes express-rate-limit reported through our bridged logger. */
function rateLimiterCodes(ctx: TestApp): string[] {
  return ctx.logRecords
    .map((record) => record.meta?.rateLimiterCode)
    .filter((code): code is string => typeof code === 'string');
}

describe('proxy trust configuration', () => {
  it('defaults to no trusted proxy so a client cannot forge its IP', () => {
    const ctx = buildTestApp();
    expect(ctx.config.trustProxy).toBe(false);
    expect(ctx.app.get('trust proxy')).toBe(false);
  });

  it('applies a configured hop count to Express', () => {
    const ctx = buildTestApp({ config: { trustProxy: 1 } });
    expect(ctx.app.get('trust proxy')).toBe(1);
  });

  it('applies a configured proxy subnet to Express', () => {
    const trustProxy = ['10.0.0.0/8'] as const;
    const ctx = buildTestApp({ config: { trustProxy } });
    expect(ctx.app.get('trust proxy')).toEqual(['10.0.0.0/8']);
  });
});

describe('429 responses use the standard error envelope', () => {
  it('returns status, content type, envelope and stable code', async () => {
    const ctx = buildTestApp({ config: { isTest: false, trustProxy: 1 } });
    await exhaustAuthBudget(ctx, CLIENT_A);

    const response = await hitAuth(ctx, CLIENT_A);

    expect(response.status).toBe(429);
    expect(response.headers['content-type']).toContain('application/json');

    // Exact envelope: only `error.code` and `error.message`, nothing else.
    expect(response.body).toEqual({
      error: {
        code: 'rate-limited',
        message: new RateLimitedError().message,
      },
    });
    expect(Object.keys(response.body)).toEqual(['error']);
    expect(Object.keys(response.body.error).sort()).toEqual(['code', 'message']);
  });

  it('exposes no internal detail in the body', async () => {
    const ctx = buildTestApp({ config: { isTest: false, trustProxy: 1 } });
    await exhaustAuthBudget(ctx, CLIENT_A);

    const response = await hitAuth(ctx, CLIENT_A);
    const text = response.text ?? '';

    expect(text).not.toContain('stack');
    expect(text).not.toContain(CLIENT_A);
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('300');
    expect(response.body.error.issues).toBeUndefined();
  });

  it('logs the event through the project logger', async () => {
    const ctx = buildTestApp({ config: { isTest: false, trustProxy: 1 } });
    await exhaustAuthBudget(ctx, CLIENT_A);
    await hitAuth(ctx, CLIENT_A);

    const records = ctx.logRecords.filter((record) => record.message === 'rate limit exceeded');
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]?.level).toBe('warn');
  });

  it('leaves non-rate-limited error formats untouched', async () => {
    const ctx = buildTestApp({ config: { isTest: false, trustProxy: 1 } });
    const response = await request(ctx.app).get('/api/v1/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'not-found', message: 'The requested resource was not found.' },
    });
  });
});

describe('rate-limit client-IP handling under a trusted proxy', () => {
  it('raises no forwarded-IP validation error when the proxy is trusted', async () => {
    const ctx = buildTestApp({ config: { isTest: false, trustProxy: 1 } });

    await exhaustAuthBudget(ctx, CLIENT_A);
    await hitAuth(ctx, CLIENT_A);

    expect(rateLimiterCodes(ctx)).toEqual([]);
    const detail = ctx.logRecords.map((record) => record.meta?.detail).join(' ');
    expect(detail).not.toContain('ERR_ERL');
  });

  it('keys the budget on the forwarded client, not the proxy', async () => {
    const ctx = buildTestApp({ config: { isTest: false, trustProxy: 1 } });

    await exhaustAuthBudget(ctx, CLIENT_A);
    expect((await hitAuth(ctx, CLIENT_A)).status).toBe(429);

    // A different forwarded client still has its own budget.
    expect((await hitAuth(ctx, CLIENT_B)).status).toBe(401);
    // ... and so does a direct connection with no forwarded header at all.
    expect((await hitAuth(ctx)).status).toBe(401);
  });

  it('ignores X-Forwarded-For entirely when no proxy is trusted', async () => {
    const ctx = buildTestApp({ config: { isTest: false, trustProxy: false } });

    // Different forged headers must NOT mint separate buckets: with no trusted
    // proxy Express keys on the socket peer, so every request shares one.
    for (let i = 0; i < AUTH_LIMIT; i += 1) {
      const response = await hitAuth(ctx, `203.0.113.${(i % 200) + 1}`);
      expect(response.status).toBe(401);
    }
    const response = await hitAuth(ctx, '203.0.113.250');
    expect(response.status).toBe(429);
  });

  it('still surfaces the misconfiguration warning instead of suppressing it', async () => {
    const ctx = buildTestApp({ config: { isTest: false, trustProxy: false } });

    await hitAuth(ctx, CLIENT_A);

    expect(rateLimiterCodes(ctx)).toContain('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR');
  });
});
