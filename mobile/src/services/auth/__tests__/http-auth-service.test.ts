import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createHttpAuthService,
  resolveApiOrigin,
  AUTH_ERROR_MESSAGES,
  type FetchLike,
  type FetchResponseLike,
} from '../http-auth-service';

/**
 * HTTP auth adapter tests. Every network call is a local fake, so these run
 * offline and never need the Express backend or MongoDB/Atlas.
 */

const BASE_URL = 'https://api.okoa.example';
const PASSWORD = 'correct-horse-battery-staple';
const TOKEN = 'header.payload.signature';

type RecordedCall = Readonly<{
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
}>;

function jsonResponse(status: number, body: unknown): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(status: number, body: string): FetchResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function mockFetch(
  handler: (url: string, init: RecordedCall['init']) => Promise<FetchResponseLike>,
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: { ...init, headers: { ...init.headers } } });
    return handler(url, init as RecordedCall['init']);
  };
  return { fetchImpl, calls };
}

function sessionBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    session: {
      accessToken: TOKEN,
      provider: 'http',
      user: {
        id: 'user_123',
        displayName: 'Ama Wanjiku',
        email: 'ama@example.com',
        role: 'community',
      },
      expiresAt: '2026-11-07T10:00:00.000Z',
      ...overrides,
    },
  };
}

function serviceWith(fetchImpl: FetchLike, baseUrl: string | null = BASE_URL) {
  return createHttpAuthService({ baseUrl, fetchImpl, timeoutMs: 1000 });
}

test('successful login posts only email and password to /api/v1/auth/login', async () => {
  const { fetchImpl, calls } = mockFetch(async () => jsonResponse(200, sessionBody()));

  const result = await serviceWith(fetchImpl).login({ email: ' ama@example.com ', password: PASSWORD });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/auth/login`);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0]!.init.body!), {
    email: 'ama@example.com',
    password: PASSWORD,
  });
  assert.equal(calls[0]!.init.headers.Authorization, undefined);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.session.provider, 'http');
  assert.equal(result.session.accessToken, TOKEN);
  assert.equal(result.session.expiresAt, '2026-11-07T10:00:00.000Z');
  assert.deepEqual(result.session.user, {
    id: 'user_123',
    displayName: 'Ama Wanjiku',
    email: 'ama@example.com',
    role: 'community',
  });
});

function conflictResponse(body: unknown = { error: { code: 'conflict' } }) {
  return jsonResponse(409, body);
}

test('duplicate registration is mapped to a clear conflict error', async () => {
  const { fetchImpl } = mockFetch(async () => conflictResponse());

  const result = await serviceWith(fetchImpl).register({
    displayName: 'Ama Wanjiku',
    email: 'ama@example.com',
    password: PASSWORD,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'conflict');
  assert.equal(result.error.message, 'An account with this email address already exists.');
});

test('duplicate registration with an unknown backend error code falls back to unknown', async () => {
  const { fetchImpl } = mockFetch(async () => jsonResponse(409, { error: { code: 'unknown' } }));

  const result = await serviceWith(fetchImpl).register({
    displayName: 'Ama Wanjiku',
    email: 'ama@example.com',
    password: PASSWORD,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unknown');
  assert.equal(result.error.message, AUTH_ERROR_MESSAGES.unknown);
});

test('existing authentication error mappings are unchanged', async () => {
  const { fetchImpl } = mockFetch(async (url, init) => {
    if (url.endsWith('/auth/login')) {
      return jsonResponse(401, { error: { code: 'invalid-credentials' } });
    }
    if (url.endsWith('/auth/register')) {
      return jsonResponse(400, { error: { code: 'invalid-input' } });
    }
    return jsonResponse(500, { error: { code: 'service-unavailable' } });
  });

  const login = await serviceWith(fetchImpl).login({ email: 'x@y.z', password: 'short' });
  const register = await serviceWith(fetchImpl).register({
    displayName: 'A',
    email: 'x@y.z',
    password: 'short',
  });

  assert.equal(login.ok, false);
  assert.equal(login.error.code, 'invalid-credentials');
  assert.equal(register.ok, false);
  assert.equal(register.error.code, 'invalid-input');
  assert.equal(login.error.message, AUTH_ERROR_MESSAGES['invalid-credentials']);
});

test('HTTP 409 conflict response maps to the conflict error', async () => {
  const { fetchImpl } = mockFetch(async () => jsonResponse(409, { error: { code: 'conflict' } }));

  const result = await serviceWith(fetchImpl).register({
    displayName: 'Ama Wanjiku',
    email: 'ama@example.com',
    password: PASSWORD,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'conflict');
  assert.equal(result.error.message, AUTH_ERROR_MESSAGES.conflict);
});

test('existing registration no longer depends on a hardcoded status rule', async () => {
  const { fetchImpl } = mockFetch(async () => jsonResponse(201, sessionBody()));

  const result = await serviceWith(fetchImpl).register({
    displayName: 'Ama Wanjiku',
    email: 'ama@example.com',
    password: PASSWORD,
  });

  assert.equal(result.ok, true);
  assert.equal(result.session.provider, 'http');
});

test('successful login posts only email and password to /api/v1/auth/login', async () => {
  const { fetchImpl, calls } = mockFetch(async () => jsonResponse(201, sessionBody()));

  const result = await serviceWith(fetchImpl).register({
    displayName: ' Ama Wanjiku ',
    email: 'ama@example.com',
    password: PASSWORD,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/auth/register`);
  assert.deepEqual(JSON.parse(calls[0]!.init.body!), {
    displayName: 'Ama Wanjiku',
    email: 'ama@example.com',
    password: PASSWORD,
  });
  assert.equal(result.ok, true);
});

test('a 401 invalid-credentials envelope maps to the mobile code without echoing server detail', async () => {
  const { fetchImpl } = mockFetch(async () =>
    jsonResponse(401, {
      ok: false,
      error: {
        code: 'invalid-credentials',
        message: 'MongoServerError: connect ECONNREFUSED at Object.<anonymous> (/srv/app.js:1:1)',
      },
    }),
  );

  const result = await serviceWith(fetchImpl).login({
    email: 'ama@example.com',
    password: 'wrong-password',
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'invalid-credentials');
  assert.ok(!result.error.message.includes('MongoServerError'));
  assert.ok(!result.error.message.includes('ECONNREFUSED'));
  assert.ok(!result.error.message.includes('/srv/app.js'));
});

test('a 400 invalid-input envelope maps to invalid-input', async () => {
  const { fetchImpl } = mockFetch(async () =>
    jsonResponse(400, { ok: false, error: { code: 'invalid-input', message: 'bad payload' } }),
  );

  const result = await serviceWith(fetchImpl).register({
    displayName: 'A',
    email: 'not-an-email',
    password: 'x',
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'invalid-input');
});

test('missing, empty or invalid API base URLs fail as unavailable without any request', async () => {
  for (const baseUrl of [null, '', '   ', 'not a url', 'ftp://api.okoa.example', '/api/v1']) {
    const { fetchImpl, calls } = mockFetch(async () => jsonResponse(200, sessionBody()));
    const result = await serviceWith(fetchImpl, baseUrl).login({
      email: 'ama@example.com',
      password: PASSWORD,
    });

    assert.equal(calls.length, 0, `no request for baseUrl=${String(baseUrl)}`);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error.code, 'unavailable');
  }
});

test('a network failure is reported as network and never throws', async () => {
  const { fetchImpl } = mockFetch(async () => {
    throw new TypeError('Network request failed');
  });

  const result = await serviceWith(fetchImpl).login({
    email: 'ama@example.com',
    password: PASSWORD,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'network');
  assert.ok(!result.error.message.includes('Network request failed'));
});

test('a request that exceeds the timeout fails as network', async () => {
  const { fetchImpl } = mockFetch(() => new Promise<FetchResponseLike>(() => {}));
  const service = createHttpAuthService({ baseUrl: BASE_URL, fetchImpl, timeoutMs: 25 });

  const startedAt = Date.now();
  const result = await service.login({ email: 'ama@example.com', password: PASSWORD });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'network');
  assert.ok(Date.now() - startedAt < 1000, 'timeout resolves promptly');
});

test('server-unavailable responses map to unavailable, including non-JSON bodies', async () => {
  const envelope = mockFetch(async () =>
    jsonResponse(503, { ok: false, error: { code: 'unavailable', message: 'db down' } }),
  );
  const html = mockFetch(async () => textResponse(500, '<html>Internal Server Error</html>'));
  const networkCode = mockFetch(async () =>
    jsonResponse(503, { error: { code: 'network', message: 'try later' } }),
  );

  const first = await serviceWith(envelope.fetchImpl).login({
    email: 'ama@example.com',
    password: PASSWORD,
  });
  const second = await serviceWith(html.fetchImpl).login({
    email: 'ama@example.com',
    password: PASSWORD,
  });
  const third = await serviceWith(networkCode.fetchImpl).login({
    email: 'ama@example.com',
    password: PASSWORD,
  });

  for (const result of [first, second]) {
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error.code, 'unavailable');
  }
  // A backend-reported `network` code is part of the mobile union and is kept.
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.error.code, 'network');
});

test('malformed JSON is never trusted', async () => {
  const badSuccess = mockFetch(async () => textResponse(200, '{"ok": true,'));
  const badError = mockFetch(async () => textResponse(401, 'not json at all'));

  const success = await serviceWith(badSuccess.fetchImpl).login({
    email: 'ama@example.com',
    password: PASSWORD,
  });
  const failure = await serviceWith(badError.fetchImpl).login({
    email: 'ama@example.com',
    password: PASSWORD,
  });

  assert.equal(success.ok, false);
  if (!success.ok) assert.equal(success.error.code, 'unknown');
  assert.equal(failure.ok, false);
  if (!failure.ok) assert.equal(failure.error.code, 'invalid-credentials');
});

test('malformed success envelopes are rejected instead of returning a partial session', async () => {
  const bodies = [
    { ok: true },
    { ok: true, session: { provider: 'http', user: sessionBody().session.user, expiresAt: null } },
    { ...sessionBody(), session: { ...sessionBody().session, accessToken: '' } },
    { ...sessionBody(), session: { ...sessionBody().session, provider: 'development-stub' } },
    { ...sessionBody(), session: { ...sessionBody().session, user: null } },
  ];

  for (const body of bodies) {
    const { fetchImpl } = mockFetch(async () => jsonResponse(200, body));
    const result = await serviceWith(fetchImpl).login({
      email: 'ama@example.com',
      password: PASSWORD,
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'unknown');
  }
});

test('a missing or unknown user role rejects the session', async () => {
  const invalidRoles: unknown[] = ['superadmin', '', null, 42, undefined];

  for (const role of invalidRoles) {
    const body = sessionBody();
    const sessionWithRole = {
      ...body,
      session: { ...body.session, user: { ...body.session.user, role } },
    };
    const { fetchImpl } = mockFetch(async () => jsonResponse(200, sessionWithRole));
    const result = await serviceWith(fetchImpl).login({
      email: 'ama@example.com',
      password: PASSWORD,
    });

    assert.equal(result.ok, false, `role ${String(role)} must be rejected`);
    if (!result.ok) assert.equal(result.error.code, 'unknown');
  }

  for (const role of ['community', 'responder', 'admin'] as const) {
    const body = sessionBody();
    const sessionWithRole = {
      ...body,
      session: { ...body.session, user: { ...body.session.user, role } },
    };
    const { fetchImpl } = mockFetch(async () => jsonResponse(200, sessionWithRole));
    const result = await serviceWith(fetchImpl).login({
      email: 'ama@example.com',
      password: PASSWORD,
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.session.user.role, role);
  }
});

test('base URL trailing slashes are normalised and an origin path is preserved', async () => {
  assert.equal(resolveApiOrigin('https://api.okoa.example/'), 'https://api.okoa.example');
  assert.equal(resolveApiOrigin('https://api.okoa.example///'), 'https://api.okoa.example');
  assert.equal(
    resolveApiOrigin('http://10.0.2.2:4000/gateway/'),
    'http://10.0.2.2:4000/gateway',
  );

  const { fetchImpl, calls } = mockFetch(async () => jsonResponse(200, sessionBody()));
  await serviceWith(fetchImpl, 'https://api.okoa.example/gateway/').login({
    email: 'ama@example.com',
    password: PASSWORD,
  });

  assert.equal(calls[0]!.url, 'https://api.okoa.example/gateway/api/v1/auth/login');
});

test('verifySession calls GET /api/v1/auth/me with the bearer token and validates the profile', async () => {
  const { fetchImpl, calls } = mockFetch(async () =>
    jsonResponse(200, {
      user: {
        id: 'user_123',
        displayName: 'Ama Wanjiku (verified)',
        email: 'ama@example.com',
        role: 'responder',
      },
    }),
  );

  const result = await serviceWith(fetchImpl).verifySession(TOKEN);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/auth/me`);
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal(calls[0]!.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0]!.init.body, undefined);
  assert.equal(calls[0]!.init.headers['Content-Type'], undefined);

  assert.equal(result.status, 'verified');
  if (result.status !== 'verified') return;
  assert.deepEqual(result.user, {
    id: 'user_123',
    displayName: 'Ama Wanjiku (verified)',
    email: 'ama@example.com',
    role: 'responder',
  });
});

test('verifySession treats only an explicit HTTP 401 as a rejected token', async () => {
  const { fetchImpl } = mockFetch(async () =>
    jsonResponse(401, {
      error: { code: 'internal-error', message: 'token expired at /srv/auth.js:42' },
    }),
  );

  const result = await serviceWith(fetchImpl).verifySession(TOKEN);

  assert.deepEqual(result, { status: 'rejected' });
});

test('verifySession keeps 5xx, network and timeout outcomes unverified', async () => {
  const unavailable = mockFetch(async () =>
    jsonResponse(503, { error: { code: 'unavailable', message: 'db down' } }),
  );
  const network = mockFetch(async () => {
    throw new TypeError('Network request failed');
  });
  const timeout = mockFetch(() => new Promise<FetchResponseLike>(() => {}));

  const first = await serviceWith(unavailable.fetchImpl).verifySession(TOKEN);
  const second = await serviceWith(network.fetchImpl).verifySession(TOKEN);
  const third = await createHttpAuthService({
    baseUrl: BASE_URL,
    fetchImpl: timeout.fetchImpl,
    timeoutMs: 25,
  }).verifySession(TOKEN);

  assert.equal(first.status, 'unverified');
  if (first.status === 'unverified') assert.equal(first.error.code, 'unavailable');
  assert.equal(second.status, 'unverified');
  if (second.status === 'unverified') assert.equal(second.error.code, 'network');
  assert.equal(third.status, 'unverified');
  if (third.status === 'unverified') assert.equal(third.error.code, 'network');
});

test('verifySession rejects malformed bodies and missing or invalid roles', async () => {
  const bodies: unknown[] = [
    {},
    { user: null },
    { user: { id: 'user_123', displayName: 'Ama', email: 'ama@example.com' } },
    { user: { id: '', displayName: 'Ama', email: 'ama@example.com', role: 'community' } },
    { user: { id: 'user_123', displayName: 'Ama', email: 'ama@example.com', role: 'owner' } },
    { user: { id: 'user_123', displayName: 'Ama', email: 'ama@example.com', role: 42 } },
  ];

  for (const body of bodies) {
    const { fetchImpl } = mockFetch(async () => jsonResponse(200, body));
    const result = await serviceWith(fetchImpl).verifySession(TOKEN);

    assert.equal(result.status, 'unverified', `body ${JSON.stringify(body)}`);
    if (result.status === 'unverified') assert.equal(result.error.code, 'unknown');
  }

  const malformed = mockFetch(async () => textResponse(200, '{"user":'));
  const result = await serviceWith(malformed.fetchImpl).verifySession(TOKEN);
  assert.equal(result.status, 'unverified');
});

test('verifySession without API configuration is unverified and makes no request', async () => {
  const { fetchImpl, calls } = mockFetch(async () =>
    jsonResponse(200, {
      user: { id: 'user_123', displayName: 'Ama', email: 'ama@example.com', role: 'community' },
    }),
  );

  const result = await serviceWith(fetchImpl, null).verifySession(TOKEN);

  assert.equal(calls.length, 0);
  assert.equal(result.status, 'unverified');
  if (result.status === 'unverified') assert.equal(result.error.code, 'unavailable');
});

test('verifySession never logs the token, authorization header or profile', async () => {
  const captured: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(' '));
    };
  }

  try {
    const success = mockFetch(async () =>
      jsonResponse(200, {
        user: { id: 'user_123', displayName: 'Ama', email: 'ama@example.com', role: 'admin' },
      }),
    );
    await serviceWith(success.fetchImpl).verifySession(TOKEN);

    const rejected = mockFetch(async () => jsonResponse(401, { error: { code: 'unauthorized' } }));
    await serviceWith(rejected.fetchImpl).verifySession(TOKEN);
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index]!;
    });
  }

  const output = captured.join('\n');
  for (const marker of [TOKEN, 'Bearer', 'ama@example.com', 'Authorization']) {
    assert.ok(!output.includes(marker), `console output must not contain ${marker}`);
  }
});

test('no password, token, authorization header or request body is written to logs', async () => {
  const captured: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(' '));
    };
  }

  try {
    const success = mockFetch(async () => jsonResponse(200, sessionBody()));
    await serviceWith(success.fetchImpl).login({
      email: 'ama@example.com',
      password: PASSWORD,
    });

    const failure = mockFetch(async () => {
      throw new TypeError('Network request failed');
    });
    await serviceWith(failure.fetchImpl).register({
      displayName: 'Ama Wanjiku',
      email: 'ama@example.com',
      password: PASSWORD,
    });
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index]!;
    });
  }

  const output = captured.join('\n');
  for (const marker of [PASSWORD, TOKEN, 'ama@example.com', 'Authorization', 'accessToken']) {
    assert.ok(!output.includes(marker), `console output must not contain ${marker}`);
  }
});
