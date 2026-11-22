import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHttpAuthService, type FetchLike, type FetchResponseLike } from '../http-auth-service';
import { restoreStoredSession, type SessionRestorationDeps } from '../session-restoration';
import type { AuthSession, SessionVerification } from '../../../types/auth';

/**
 * Startup restoration tests. HTTP is mocked locally; storage and clearing are
 * observed through small fakes, so nothing touches SecureStore or a backend.
 */

const BASE_URL = 'https://api.okoa.example';
const TOKEN = 'header.payload.signature';

const cachedHttpSession: AuthSession = {
  accessToken: TOKEN,
  provider: 'http',
  user: {
    id: 'user_123',
    displayName: 'Cached Name',
    email: 'ama@example.com',
    role: 'community',
  },
  expiresAt: '2026-11-07T10:00:00.000Z',
};

type Harness = Readonly<{
  deps: SessionRestorationDeps;
  saved: AuthSession[];
  cleared: number;
  verifiedTokens: string[];
}>;

function harness(options: {
  stored: AuthSession | null;
  verify?: (token: string) => Promise<SessionVerification>;
}): Harness {
  const saved: AuthSession[] = [];
  const verifiedTokens: string[] = [];
  const state = { cleared: 0 };

  return {
    saved,
    get cleared() {
      return state.cleared;
    },
    verifiedTokens,
    deps: {
      load: async () => options.stored,
      save: async (session) => {
        saved.push(session);
      },
      clear: async () => {
        state.cleared += 1;
      },
      verifySession: async (token) => {
        verifiedTokens.push(token);
        return options.verify
          ? options.verify(token)
          : { status: 'unverified', error: { code: 'network', message: 'offline' } };
      },
    },
  };
}

function jsonResponse(status: number, body: unknown): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function serviceWith(fetchImpl: FetchLike, baseUrl: string | null = BASE_URL, timeoutMs = 1000) {
  return createHttpAuthService({ baseUrl, fetchImpl, timeoutMs });
}

function mockFetch(
  handler: () => Promise<FetchResponseLike>,
): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    return handler();
  };
  return { fetchImpl, calls };
}

test('no stored session stays signed out without verifying', async () => {
  const testHarness = harness({ stored: null });

  const outcome = await restoreStoredSession(testHarness.deps);

  assert.deepEqual(outcome, { status: 'signed-out' });
  assert.equal(testHarness.verifiedTokens.length, 0);
  assert.equal(testHarness.cleared, 0);
  assert.equal(testHarness.saved.length, 0);
});

test('a verified HTTP session refreshes the profile and keeps token and expiry', async () => {
  const testHarness = harness({
    stored: cachedHttpSession,
    verify: async () => ({
      status: 'verified',
      user: {
        id: 'user_123',
        displayName: 'Ama Wanjiku',
        email: 'ama@example.com',
        role: 'responder',
      },
    }),
  });

  const outcome = await restoreStoredSession(testHarness.deps);

  assert.equal(outcome.status, 'restored');
  if (outcome.status !== 'restored') return;
  assert.equal(outcome.verification, 'verified');
  assert.equal(outcome.session.user.displayName, 'Ama Wanjiku');
  assert.equal(outcome.session.user.role, 'responder');
  assert.equal(outcome.session.accessToken, TOKEN);
  assert.equal(outcome.session.expiresAt, cachedHttpSession.expiresAt);
  assert.equal(outcome.session.provider, 'http');

  assert.equal(testHarness.verifiedTokens[0], TOKEN);
  assert.equal(testHarness.saved.length, 1);
  assert.equal(testHarness.saved[0]!.user.role, 'responder');
});

test('an explicit 401 clears storage and signs the user out', async () => {
  const testHarness = harness({
    stored: cachedHttpSession,
    verify: async () => ({ status: 'rejected' }),
  });

  const outcome = await restoreStoredSession(testHarness.deps);

  assert.deepEqual(outcome, { status: 'signed-out' });
  assert.equal(testHarness.cleared, 1);
  assert.equal(testHarness.saved.length, 0);
});

test('a network failure preserves the cached session as unverified', async () => {
  const { fetchImpl } = mockFetch(async () => {
    throw new TypeError('Network request failed');
  });
  const session = serviceWith(fetchImpl);
  const testHarness = harness({
    stored: cachedHttpSession,
    verify: (token) => session.verifySession(token),
  });

  const outcome = await restoreStoredSession(testHarness.deps);

  assert.equal(outcome.status, 'restored');
  if (outcome.status !== 'restored') return;
  assert.equal(outcome.verification, 'unverified');
  assert.deepEqual(outcome.session, cachedHttpSession);
  assert.equal(testHarness.cleared, 0);
  assert.equal(testHarness.saved.length, 0);
});

test('a timeout preserves the cached session as unverified', async () => {
  const { fetchImpl } = mockFetch(() => new Promise<FetchResponseLike>(() => {}));
  const session = serviceWith(fetchImpl, BASE_URL, 25);
  const testHarness = harness({
    stored: cachedHttpSession,
    verify: (token) => session.verifySession(token),
  });

  const startedAt = Date.now();
  const outcome = await restoreStoredSession(testHarness.deps);

  assert.equal(outcome.status, 'restored');
  if (outcome.status !== 'restored') return;
  assert.equal(outcome.verification, 'unverified');
  assert.deepEqual(outcome.session, cachedHttpSession);
  assert.equal(testHarness.cleared, 0);
  assert.ok(Date.now() - startedAt < 1000);
});

test('a 5xx response preserves the cached session as unverified', async () => {
  const { fetchImpl } = mockFetch(async () =>
    jsonResponse(500, { error: { code: 'internal-error', message: 'stack trace' } }),
  );
  const session = serviceWith(fetchImpl);
  const testHarness = harness({
    stored: cachedHttpSession,
    verify: (token) => session.verifySession(token),
  });

  const outcome = await restoreStoredSession(testHarness.deps);

  assert.equal(outcome.status, 'restored');
  if (outcome.status !== 'restored') return;
  assert.equal(outcome.verification, 'unverified');
  assert.deepEqual(outcome.session.user, cachedHttpSession.user);
  assert.equal(testHarness.cleared, 0);
});

test('a malformed /auth/me response or invalid role preserves the cached session', async () => {
  const bodies: unknown[] = [
    { user: null },
    { user: { id: 'user_123', displayName: 'Ama', email: 'ama@example.com' } },
    { user: { id: 'user_123', displayName: 'Ama', email: 'ama@example.com', role: 'owner' } },
  ];

  for (const body of bodies) {
    const { fetchImpl } = mockFetch(async () => jsonResponse(200, body));
    const session = serviceWith(fetchImpl);
    const testHarness = harness({
      stored: cachedHttpSession,
      verify: (token) => session.verifySession(token),
    });

    const outcome = await restoreStoredSession(testHarness.deps);

    assert.equal(outcome.status, 'restored', JSON.stringify(body));
    if (outcome.status !== 'restored') continue;
    assert.equal(outcome.verification, 'unverified');
    assert.deepEqual(outcome.session, cachedHttpSession);
    assert.equal(testHarness.cleared, 0);
  }
});

test('missing API configuration preserves the cached session without a request', async () => {
  const { fetchImpl, calls } = mockFetch(async () =>
    jsonResponse(200, {
      user: { id: 'user_123', displayName: 'Ama', email: 'ama@example.com', role: 'community' },
    }),
  );
  const session = serviceWith(fetchImpl, null);
  const testHarness = harness({
    stored: cachedHttpSession,
    verify: (token) => session.verifySession(token),
  });

  const outcome = await restoreStoredSession(testHarness.deps);

  assert.equal(outcome.status, 'restored');
  if (outcome.status !== 'restored') return;
  assert.equal(outcome.verification, 'unverified');
  assert.deepEqual(outcome.session, cachedHttpSession);
  assert.equal(calls.length, 0);
  assert.equal(testHarness.cleared, 0);
});

test('a development-stub session restores locally without calling the backend', async () => {
  const stubSession: AuthSession = {
    ...cachedHttpSession,
    accessToken: 'dev-stub-token-local',
    provider: 'development-stub',
  };
  const testHarness = harness({
    stored: stubSession,
    verify: async () => {
      throw new Error('stub sessions must not be verified remotely');
    },
  });

  const outcome = await restoreStoredSession(testHarness.deps);

  assert.equal(outcome.status, 'restored');
  if (outcome.status !== 'restored') return;
  assert.equal(outcome.verification, 'unverified');
  assert.deepEqual(outcome.session, stubSession);
  assert.equal(testHarness.verifiedTokens.length, 0);
  assert.equal(testHarness.cleared, 0);
});
