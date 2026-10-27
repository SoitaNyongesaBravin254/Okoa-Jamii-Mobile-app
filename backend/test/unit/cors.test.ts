/**
 * CORS allow-list over the REAL HTTP stack (in-memory fakes, no database).
 *
 * The allow-list is exact-match only: the configured origins are reflected,
 * everything else gets no allow-header, and an empty list means the CORS
 * middleware is not mounted at all (the pre-existing development/test
 * behaviour). Production never reaches the app with an empty list — that is
 * rejected during configuration parsing (see config.test.ts).
 *
 * TIER: unit. No database.
 */

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app';

const ALLOWED = 'https://app.example.com';
const OTHER_ALLOWED = 'http://localhost:3000';
const DENIED = 'https://evil.example';

describe('CORS allow-list', () => {
  it('reflects an origin that is an exact member of the list', async () => {
    const ctx = buildTestApp({ config: { corsOrigins: [ALLOWED] } });
    const response = await request(ctx.app).get('/api/v1/health').set('Origin', ALLOWED);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('never echoes an origin outside the list', async () => {
    const ctx = buildTestApp({ config: { corsOrigins: [ALLOWED] } });
    const response = await request(ctx.app).get('/api/v1/health').set('Origin', DENIED);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('supports several origins without accepting arbitrary ones', async () => {
    const ctx = buildTestApp({ config: { corsOrigins: [ALLOWED, OTHER_ALLOWED] } });

    for (const origin of [ALLOWED, OTHER_ALLOWED]) {
      const allowed = await request(ctx.app).get('/api/v1/health').set('Origin', origin);
      expect(allowed.headers['access-control-allow-origin']).toBe(origin);
    }

    const denied = await request(ctx.app).get('/api/v1/health').set('Origin', DENIED);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight for an allowed origin', async () => {
    const ctx = buildTestApp({ config: { corsOrigins: [ALLOWED] } });
    const response = await request(ctx.app)
      .options('/api/v1/alerts')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-methods']).toContain('POST');
  });

  it('does not answer a preflight for a disallowed origin', async () => {
    const ctx = buildTestApp({ config: { corsOrigins: [ALLOWED] } });
    const response = await request(ctx.app)
      .options('/api/v1/alerts')
      .set('Origin', DENIED)
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('mounts no CORS headers when the allow-list is empty', async () => {
    const ctx = buildTestApp();
    expect(ctx.config.corsOrigins).toEqual([]);

    const response = await request(ctx.app).get('/api/v1/health').set('Origin', ALLOWED);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
