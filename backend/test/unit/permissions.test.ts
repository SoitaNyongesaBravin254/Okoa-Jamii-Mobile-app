/**
 * Authorization / permission tests over the REAL HTTP stack with in-memory
 * fakes (no database).
 *
 * Matrix:
 *   POST   /api/v1/alerts     any authenticated role
 *   GET    /api/v1/alerts     responder, admin (community -> 403)
 *   GET    /api/v1/alerts/:id responder, admin
 *   DELETE /api/v1/alerts/:id admin only (responder -> 403)
 *   GET    /api/v1/auth/me    any authenticated role
 *   GET    /api/v1/health     anonymous, but the DB diagnosis block is admin
 *
 * TIER: unit. No database.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthSession } from '../../src/domain/auth';
import { buildTestApp, type TestApp } from '../helpers/build-app';

const VALID_ALERT = {
  id: 'alert_perms_0001',
  category: 'security',
  location: { state: 'available', latitude: -6.16, longitude: 35.75, accuracyMeters: 12 },
  createdAtUtc: '2026-10-14T09:15:00.000Z',
};

describe('role matrix over the HTTP stack', () => {
  let ctx: TestApp;
  let community: AuthSession;
  let responder: AuthSession;
  let admin: AuthSession;

  beforeEach(async () => {
    ctx = buildTestApp();
    community = await registerRole(ctx, 'community-member@example.com');
    responder = await registerRole(ctx, 'responder-one@example.com');
    admin = await registerRole(ctx, 'admin-one@example.com');

    // Promote the fixture accounts to their roles directly (unit shortcut):
    // role ASSIGNMENT policy is registered-bootstrap territory, so RBAC tests
    // seed roles and assert their ENFORCEMENT.
    ctx.users.promote(responder.user.id, 'responder');
    ctx.users.promote(admin.user.id, 'admin');
    // Re-login so freshly issued tokens carry the new role.
    responder = await loginAs(ctx, 'responder-one@example.com');
    admin = await loginAs(ctx, 'admin-one@example.com');
  });

  it('rejects an unauthenticated alert POST with 401', async () => {
    const response = await request(ctx.app).post('/api/v1/alerts').send(VALID_ALERT);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('authentication-error');
  });

  it('rejects a garbage bearer token with 401', async () => {
    const response = await request(ctx.app)
      .post('/api/v1/alerts')
      .set('Authorization', 'Bearer not.a.real.token')
      .send(VALID_ALERT);
    expect(response.status).toBe(401);
  });

  it('allows every authenticated role to POST an alert', async () => {
    let counter = 0;
    for (const session of [community, responder, admin]) {
      counter += 1;
      const response = await request(ctx.app)
        .post('/api/v1/alerts')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ ...VALID_ALERT, id: `alert_perms_post_${counter}` });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.alert.serverReceipt).toBeTruthy();
    }
  });

  it('blocks community from listing alerts (403) but serves responder and admin', async () => {
    const denied = await request(ctx.app)
      .get('/api/v1/alerts')
      .set('Authorization', `Bearer ${community.accessToken}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('authorization-error');

    for (const session of [responder, admin]) {
      const allowed = await request(ctx.app)
        .get('/api/v1/alerts')
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(allowed.status).toBe(200);
      expect(Array.isArray(allowed.body.alerts)).toBe(true);
    }
  });

  it('blocks community from reading a single alert but serves responder', async () => {
    const created = await request(ctx.app)
      .post('/api/v1/alerts')
      .set('Authorization', `Bearer ${community.accessToken}`)
      .send(VALID_ALERT);
    expect(created.status).toBe(201);

    const denied = await request(ctx.app)
      .get(`/api/v1/alerts/${VALID_ALERT.id}`)
      .set('Authorization', `Bearer ${community.accessToken}`);
    expect(denied.status).toBe(403);

    const allowed = await request(ctx.app)
      .get(`/api/v1/alerts/${VALID_ALERT.id}`)
      .set('Authorization', `Bearer ${responder.accessToken}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.alert.id).toBe(VALID_ALERT.id);
  });

  it('allows delete only for admin: responder 403, admin 204', async () => {
    const created = await request(ctx.app)
      .post('/api/v1/alerts')
      .set('Authorization', `Bearer ${community.accessToken}`)
      .send({ ...VALID_ALERT, id: 'alert_perms_delete' });
    expect(created.status).toBe(201);

    const denied = await request(ctx.app)
      .delete('/api/v1/alerts/alert_perms_delete')
      .set('Authorization', `Bearer ${responder.accessToken}`);
    expect(denied.status).toBe(403);

    const allowed = await request(ctx.app)
      .delete('/api/v1/alerts/alert_perms_delete')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(allowed.status).toBe(204);
    expect(ctx.alerts.size).toBe(0);
  });

  it('returns 404 for unknown alert ids to authorized roles', async () => {
    const response = await request(ctx.app)
      .get('/api/v1/alerts/no-such-alert')
      .set('Authorization', `Bearer ${responder.accessToken}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not-found');
  });

  it('serves /auth/me only with a valid token', async () => {
    const anonymous = await request(ctx.app).get('/api/v1/auth/me');
    expect(anonymous.status).toBe(401);

    const authenticated = await request(ctx.app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${responder.accessToken}`);
    expect(authenticated.status).toBe(200);
    expect(authenticated.body.user.email).toBe('responder-one@example.com');
    expect(authenticated.body.user).not.toHaveProperty('passwordHash');
  });

  it('sanitises unknown routes through the same error envelope', async () => {
    const response = await request(ctx.app).get('/api/v1/definitely-not-a-route');
    expect(response.status).toBe(404);
    expect(response.body.error).toEqual({
      code: 'not-found',
      message: expect.any(String),
    });
  });
});

describe('health endpoint diagnosis permissions', () => {
  it('is reachable anonymously and reports a connected database', async () => {
    const ctx = buildTestApp();
    const response = await request(ctx.app).get('/api/v1/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.db).toEqual({ connected: true, category: null });
  });

  it('reports a degraded database with a credential-free category to everyone', async () => {
    const ctx = buildTestApp({
      probe: {
        connected: false,
        readyState: 0,
        diagnosis: {
          category: 'ip-not-allowed',
          hint: 'Add the client IP to the Atlas Network Access list.',
        },
        lastError: 'server selection Error',
      },
    });
    const response = await request(ctx.app).get('/api/v1/health');
    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.db.connected).toBe(false);
    expect(response.body.db.category).toBe('ip-not-allowed');
    // Anonymous callers must NOT receive the operator hint or error detail.
    expect(response.body.db.hint).toBeUndefined();
    expect(response.body.db.lastError).toBeUndefined();
  });

  it('gives the operator hint to an authenticated admin only', async () => {
    const ctx = buildTestApp({
      probe: {
        connected: false,
        readyState: 0,
        diagnosis: {
          category: 'ip-not-allowed',
          hint: 'Add the client IP to the Atlas Network Access list.',
        },
        lastError: 'server selection Error',
      },
    });
    const session = await registerRole(ctx, 'admin-health@example.com');
    ctx.users.promote(session.user.id, 'admin');
    const adminSession = await loginAs(ctx, 'admin-health@example.com');

    const response = await request(ctx.app)
      .get('/api/v1/health')
      .set('Authorization', `Bearer ${adminSession.accessToken}`);
    expect(response.status).toBe(503);
    expect(response.body.db.hint).toBe('Add the client IP to the Atlas Network Access list.');
    // The hint and detail must never carry connection-string material.
    expect(JSON.stringify(response.body)).not.toContain('mongodb://');
    expect(JSON.stringify(response.body)).not.toContain('mongodb+srv://');
  });

  it('stays anonymous for a non-admin token on health', async () => {
    const ctx = buildTestApp({
      probe: {
        connected: false,
        readyState: 0,
        diagnosis: { category: 'network-timeout', hint: 'Check egress.' },
        lastError: null,
      },
    });
    const session = await registerRole(ctx, 'community-health@example.com');
    const response = await request(ctx.app)
      .get('/api/v1/health')
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(response.status).toBe(503);
    expect(response.body.db.hint).toBeUndefined();
  });
});

describe('HTTP error sanitizer', () => {
  it('returns a generic envelope for malformed JSON without echoing content', async () => {
    const ctx = buildTestApp();
    const response = await request(ctx.app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "secret-value-in-body@');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation-error');
    expect(JSON.stringify(response.body)).not.toContain('secret-value-in-body');
  });

  it('rejects a request body above MAX_REQUEST_BODY_BYTES with 413', async () => {
    const ctx = buildTestApp({ config: { maxRequestBodyBytes: 2048 } });
    const response = await request(ctx.app)
      .post('/api/v1/auth/register')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(5000) }));
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('validation-error');
  });

  it('never includes a stack trace in the response body', async () => {
    const ctx = buildTestApp();
    const response = await request(ctx.app)
      .get('/api/v1/alerts/x')
      .set('Authorization', 'Bearer bogus.token.here');
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain('at ');
    expect(response.body.error).not.toHaveProperty('stack');
  });
});

// ---------------------------------------------------------------- helpers

async function registerRole(ctx: TestApp, email: string): Promise<AuthSession> {
  const response = await request(ctx.app)
    .post('/api/v1/auth/register')
    .send({ displayName: `User ${email}`, email, password: 'test-password-123' });
  if (response.status !== 201) {
    throw new Error(`fixture registration failed: ${response.status}`);
  }
  return response.body.session as AuthSession;
}

async function loginAs(ctx: TestApp, email: string): Promise<AuthSession> {
  const response = await request(ctx.app)
    .post('/api/v1/auth/login')
    .send({ email, password: 'test-password-123' });
  if (response.status !== 200) {
    throw new Error(`fixture login failed: ${response.status}`);
  }
  return response.body.session as AuthSession;
}
/** Roles are seeded via `ctx.users.promote` in fixtures, never via HTTP. */
