import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createAlertSyncService,
  type AlertSyncConnectivity,
} from '../alert-sync';
import { createAlertRecord } from '../alert-model';
import type { FetchLike, FetchResponseLike } from '../../auth/http-auth-service';
import type { AuthSession } from '@/types/auth';
import type { AlertCategory, AlertLocation, AlertRecord } from '@/types/alert';

/**
 * Pending-alert synchronisation tests. Every request is a local fake and the
 * repository is an in-memory queue, so these run offline — no Express backend
 * and no MongoDB/Atlas required.
 */

const BASE_URL = 'https://api.okoa.example';
const TOKEN = 'header.payload.signature';

const AVAILABLE_LOCATION: AlertLocation = {
  state: 'available',
  latitude: -1.292066,
  longitude: 36.821945,
  accuracyMeters: 8,
};

const UNAVAILABLE_LOCATION: AlertLocation = {
  state: 'unavailable',
  reason: 'permission-denied',
};

const SESSION: AuthSession = {
  accessToken: TOKEN,
  provider: 'http',
  user: {
    id: 'user_123',
    displayName: 'Ama Wanjiku',
    email: 'ama@example.com',
    role: 'community',
  },
  expiresAt: '2026-11-07T10:00:00.000Z',
};

type RecordedCall = Readonly<{
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
}>;

type Handler = (url: string, init: RecordedCall['init']) => Promise<FetchResponseLike>;

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

function makeAlert(
  options: {
    category?: AlertCategory;
    location?: AlertLocation;
    createdAtUtc?: string;
  } = {},
): AlertRecord {
  return createAlertRecord({
    category: options.category ?? 'security',
    location: options.location ?? AVAILABLE_LOCATION,
    createdAtUtc: options.createdAtUtc ?? '2026-10-20T10:00:00.000Z',
  });
}

function receiptBody(alert: AlertRecord, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    alert: {
      id: alert.id,
      category: alert.category,
      status: 'received',
      serverReceipt: 'rcpt_abc_123',
      createdAtUtc: alert.createdAtUtc,
      receivedAtUtc: '2026-10-20T10:00:05.000Z',
      duplicate: false,
      ...overrides,
    },
  };
}

type SetupOptions = Readonly<{
  alerts?: AlertRecord[];
  handler?: Handler;
  connectivity?: AlertSyncConnectivity;
  session?: AuthSession | null;
  baseUrl?: string | null;
  timeoutMs?: number;
  failMarkSent?: boolean;
}>;

function setup(options: SetupOptions = {}) {
  const alerts: AlertRecord[] = (options.alerts ?? [makeAlert()]).map((alert) => ({ ...alert }));
  const calls: RecordedCall[] = [];
  const sent: { id: string; serverReceipt: string }[] = [];

  const handler: Handler = options.handler ?? (async () => jsonResponse(201, receiptBody(alerts[0]!)));

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: { ...init, headers: { ...init.headers } } });
    return handler(url, init as RecordedCall['init']);
  };

  const service = createAlertSyncService({
    baseUrl: options.baseUrl === undefined ? BASE_URL : options.baseUrl,
    fetchImpl,
    timeoutMs: options.timeoutMs ?? 1000,
    getConnectivity: async () => options.connectivity ?? 'online',
    getSession: async () => (options.session === undefined ? SESSION : options.session),
    listPendingAlerts: async () => alerts.filter((alert) => alert.status === 'pending'),
    markAlertSent: async (id, serverReceipt) => {
      if (options.failMarkSent) {
        throw new Error('disk full');
      }
      const index = alerts.findIndex((alert) => alert.id === id);
      if (index < 0) {
        throw new Error('missing alert');
      }
      alerts[index] = { ...alerts[index]!, status: 'sent', serverReceipt };
      sent.push({ id, serverReceipt });
    },
  });

  return { service, alerts, calls, sent };
}

test('successful 201 submission sends exactly the ingestion contract and records the receipt', async () => {
  const alert = makeAlert();
  const { service, alerts, calls, sent } = setup({
    alerts: [alert],
    handler: async () => jsonResponse(201, receiptBody(alert)),
  });

  const result = await service.sync();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${BASE_URL}/api/v1/alerts`);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0]!.init.headers['Content-Type'], 'application/json');
  // No status, retryCount, serverReceipt or user id may be sent.
  assert.deepEqual(JSON.parse(calls[0]!.init.body!), {
    id: alert.id,
    category: 'security',
    location: AVAILABLE_LOCATION,
    createdAtUtc: alert.createdAtUtc,
  });

  assert.deepEqual(result, { outcome: 'completed', submitted: 1, pendingRemaining: 0 });
  assert.equal(alerts[0]!.status, 'sent');
  assert.deepEqual(sent, [{ id: alert.id, serverReceipt: 'rcpt_abc_123' }]);
});

test('a 200 verified-duplicate response is a success', async () => {
  const alert = makeAlert();
  const { service, alerts, sent } = setup({
    alerts: [alert],
    handler: async () => jsonResponse(200, receiptBody(alert, { duplicate: true })),
  });

  const result = await service.sync();

  assert.deepEqual(result, { outcome: 'completed', submitted: 1, pendingRemaining: 0 });
  assert.equal(alerts[0]!.status, 'sent');
  assert.equal(sent.length, 1);
});

test('a valid receipt is persisted exactly as returned by the server', async () => {
  const alert = makeAlert();
  const receipt = 'rcpt_exact_server_value_42';
  const { service, alerts, sent } = setup({
    alerts: [alert],
    handler: async () => jsonResponse(201, receiptBody(alert, { serverReceipt: receipt })),
  });

  await service.sync();

  assert.deepEqual(sent, [{ id: alert.id, serverReceipt: receipt }]);
  assert.equal(alerts[0]!.serverReceipt, receipt);
});

test('an available location keeps its real coordinates and accuracy', async () => {
  const location: AlertLocation = {
    state: 'available',
    latitude: 0.3476,
    longitude: 32.5825,
    accuracyMeters: 12.5,
  };
  const alert = makeAlert({ category: 'medical', location });
  const { service, calls } = setup({
    alerts: [alert],
    handler: async () => jsonResponse(201, receiptBody(alert)),
  });

  await service.sync();

  const payload = JSON.parse(calls[0]!.init.body!);
  assert.deepEqual(payload.location, {
    state: 'available',
    latitude: 0.3476,
    longitude: 32.5825,
    accuracyMeters: 12.5,
  });
});

test('an unavailable location is sent with its reason and no coordinates', async () => {
  const alert = makeAlert({ category: 'fire', location: UNAVAILABLE_LOCATION });
  const { service, calls } = setup({
    alerts: [alert],
    handler: async () => jsonResponse(201, receiptBody(alert)),
  });

  await service.sync();

  const payload = JSON.parse(calls[0]!.init.body!);
  assert.deepEqual(payload.location, { state: 'unavailable', reason: 'permission-denied' });
  assert.equal('latitude' in payload.location, false);
  assert.equal('longitude' in payload.location, false);
});

test('offline skips the run without requesting and leaves alerts pending', async () => {
  const { service, alerts, calls, sent } = setup({ connectivity: 'offline' });

  const result = await service.sync();

  assert.deepEqual(result, { outcome: 'skipped', reason: 'offline' });
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(alerts[0]!.status, 'pending');
});

test('connectivity that cannot be determined is not treated as online', async () => {
  const { service, calls } = setup({ connectivity: 'unknown' });

  const result = await service.sync();

  assert.deepEqual(result, { outcome: 'skipped', reason: 'offline' });
  assert.equal(calls.length, 0);
});

test('a network failure stops the run and preserves pending status', async () => {
  const { service, alerts, sent } = setup({
    handler: async () => {
      throw new TypeError('Network request failed');
    },
  });

  const result = await service.sync();

  assert.equal(result.outcome, 'stopped');
  if (result.outcome !== 'stopped') return;
  assert.equal(result.error.code, 'network');
  assert.equal(result.submitted, 0);
  assert.equal(result.pendingRemaining, 1);
  assert.equal(alerts[0]!.status, 'pending');
  assert.equal(sent.length, 0);
});

test('a request timeout stops the run and preserves pending status', async () => {
  const { service, alerts, sent } = setup({
    timeoutMs: 20,
    handler: () => new Promise<FetchResponseLike>(() => {}),
  });

  const result = await service.sync();

  assert.equal(result.outcome, 'stopped');
  if (result.outcome !== 'stopped') return;
  assert.equal(result.error.code, 'timeout');
  assert.equal(alerts[0]!.status, 'pending');
  assert.equal(sent.length, 0);
});

test('HTTP 401 never marks an alert sent and surfaces an authentication error', async () => {
  const { service, alerts, sent } = setup({
    handler: async () =>
      jsonResponse(401, { error: { code: 'unauthorized', message: 'expired' } }),
  });

  const result = await service.sync();

  assert.equal(result.outcome, 'stopped');
  if (result.outcome !== 'stopped') return;
  assert.equal(result.error.code, 'unauthorized');
  assert.equal(result.submitted, 0);
  assert.equal(alerts[0]!.status, 'pending');
  assert.equal(sent.length, 0);
});

test('HTTP 5xx preserves pending status', async () => {
  const { service, alerts } = setup({
    handler: async () => jsonResponse(503, { error: { code: 'unavailable' } }),
  });

  const result = await service.sync();

  assert.equal(result.outcome, 'stopped');
  if (result.outcome !== 'stopped') return;
  assert.equal(result.error.code, 'server');
  assert.equal(alerts[0]!.status, 'pending');
});

test('malformed success envelopes are rejected and alerts stay pending', async () => {
  const alert = makeAlert();
  const bodies: unknown[] = [
    {},
    { ok: true },
    { ok: true, alert: null },
    { ok: true, alert: 'received' },
    { ok: false, alert: receiptBody(alert).alert },
  ];

  for (const body of bodies) {
    const { service, alerts, calls } = setup({
      alerts: [alert],
      handler: async () => jsonResponse(201, body),
    });
    const result = await service.sync();

    assert.equal(result.outcome, 'stopped', `body ${JSON.stringify(body)}`);
    if (result.outcome !== 'stopped') continue;
    assert.equal(result.error.code, 'invalid-response');
    assert.equal(alerts[0]!.status, 'pending');
    assert.equal(calls.length, 1);
  }

  const malformedJson = setup({
    alerts: [alert],
    handler: async () => textResponse(200, '{"ok":true,"alert":'),
  });
  const result = await malformedJson.service.sync();
  assert.equal(result.outcome, 'stopped');
  assert.equal(malformedJson.alerts[0]!.status, 'pending');
});

test('a missing server receipt is rejected', async () => {
  const alert = makeAlert();
  const { service, alerts, sent } = setup({
    alerts: [alert],
    handler: async () => jsonResponse(201, receiptBody(alert, { serverReceipt: '   ' })),
  });

  const result = await service.sync();

  assert.equal(result.outcome, 'stopped');
  if (result.outcome !== 'stopped') return;
  assert.equal(result.error.code, 'invalid-response');
  assert.equal(alerts[0]!.status, 'pending');
  assert.equal(sent.length, 0);
});

test('a mismatched alert id is rejected', async () => {
  const alert = makeAlert();
  const { service, alerts } = setup({
    alerts: [alert],
    handler: async () => jsonResponse(201, receiptBody(alert, { id: 'alert_someone_else' })),
  });

  const result = await service.sync();

  assert.equal(result.outcome, 'stopped');
  if (result.outcome !== 'stopped') return;
  assert.equal(result.error.code, 'invalid-response');
  assert.equal(alerts[0]!.status, 'pending');
});

test('an invalid category, status or timestamp is rejected', async () => {
  const alert = makeAlert();
  const overrides: Record<string, unknown>[] = [
    { category: 'medical' },
    { category: 'space' },
    { category: 42 },
    { status: 'pending' },
    { status: 'sent' },
    { createdAtUtc: 'yesterday' },
    { receivedAtUtc: 'yesterday' },
    { duplicate: 'no' },
  ];

  for (const override of overrides) {
    const { service, alerts } = setup({
      alerts: [alert],
      handler: async () => jsonResponse(201, receiptBody(alert, override)),
    });
    const result = await service.sync();

    assert.equal(result.outcome, 'stopped', `override ${JSON.stringify(override)}`);
    if (result.outcome !== 'stopped') continue;
    assert.equal(result.error.code, 'invalid-response');
    assert.equal(alerts[0]!.status, 'pending');
  }
});

test('the stable local alert id is reused across retry attempts', async () => {
  const alert = makeAlert();
  const failing = setup({
    alerts: [alert],
    handler: async () => {
      throw new TypeError('Network request failed');
    },
  });
  await failing.service.sync();

  const succeeding = setup({
    alerts: [alert],
    handler: async () => jsonResponse(201, receiptBody(alert)),
  });
  await succeeding.service.sync();

  const ids = [...failing.calls, ...succeeding.calls].map(
    (call) => JSON.parse(call.init.body!).id,
  );
  assert.deepEqual(ids, [alert.id, alert.id]);
});

test('multiple pending alerts are submitted oldest first', async () => {
  const first = makeAlert({
    category: 'flood',
    location: UNAVAILABLE_LOCATION,
    createdAtUtc: '2026-10-20T09:00:00.000Z',
  });
  const second = makeAlert({
    category: 'fire',
    createdAtUtc: '2026-10-20T10:00:00.000Z',
  });
  const pending = [first, second];

  const { service, alerts, sent } = setup({
    alerts: pending,
    handler: async (_url, init) => {
      const body = JSON.parse(init.body!);
      const match = pending.find((alert) => alert.id === body.id)!;
      return jsonResponse(201, receiptBody(match));
    },
  });

  const result = await service.sync();

  assert.deepEqual(result, { outcome: 'completed', submitted: 2, pendingRemaining: 0 });
  assert.deepEqual(
    sent.map((entry) => entry.id),
    [first.id, second.id],
  );
  assert.ok(alerts.every((alert) => alert.status === 'sent'));
});

test('a concurrent run is refused instead of double-submitting', async () => {
  const alert = makeAlert();
  let release!: (response: FetchResponseLike) => void;

  const { service, calls } = setup({
    alerts: [alert],
    handler: () =>
      new Promise<FetchResponseLike>((resolve) => {
        release = resolve;
      }),
  });

  const first = service.sync();
  const second = await service.sync();

  assert.deepEqual(second, { outcome: 'skipped', reason: 'already-running' });
  assert.equal(service.isSyncing(), true);

  while (calls.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  release(jsonResponse(201, receiptBody(alert)));

  const firstResult = await first;
  assert.deepEqual(firstResult, { outcome: 'completed', submitted: 1, pendingRemaining: 0 });
  assert.equal(calls.length, 1);
  assert.equal(service.isSyncing(), false);
});

test('a missing or non-HTTP session skips without inventing credentials', async () => {
  const missing = setup({ session: null });
  const missingResult = await missing.service.sync();
  assert.deepEqual(missingResult, { outcome: 'skipped', reason: 'no-session' });
  assert.equal(missing.calls.length, 0);

  const stub = setup({ session: { ...SESSION, provider: 'development-stub' } });
  const stubResult = await stub.service.sync();
  assert.deepEqual(stubResult, { outcome: 'skipped', reason: 'no-session' });
  assert.equal(stub.calls.length, 0);

  const emptyToken = setup({ session: { ...SESSION, accessToken: '   ' } });
  const emptyResult = await emptyToken.service.sync();
  assert.deepEqual(emptyResult, { outcome: 'skipped', reason: 'no-session' });
  assert.equal(emptyToken.calls.length, 0);
});

test('a missing API base URL skips without a request', async () => {
  const { service, calls, alerts } = setup({ baseUrl: null });

  const result = await service.sync();

  assert.deepEqual(result, { outcome: 'skipped', reason: 'not-configured' });
  assert.equal(calls.length, 0);
  assert.equal(alerts[0]!.status, 'pending');
});

test('a local storage failure while marking sent leaves the alert pending', async () => {
  const alert = makeAlert();
  const { service, alerts, sent } = setup({
    alerts: [alert],
    handler: async () => jsonResponse(201, receiptBody(alert)),
    failMarkSent: true,
  });

  const result = await service.sync();

  assert.equal(result.outcome, 'stopped');
  if (result.outcome !== 'stopped') return;
  assert.equal(result.error.code, 'storage');
  assert.equal(alerts[0]!.status, 'pending');
  assert.equal(sent.length, 0);
});

test('no token, authorization header, coordinates or payload is written to logs', async () => {
  const captured: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(' '));
    };
  }

  try {
    const alert = makeAlert();
    const success = setup({
      alerts: [alert],
      handler: async () => jsonResponse(201, receiptBody(alert)),
    });
    await success.service.sync();

    const rejected = setup({
      handler: async () => jsonResponse(401, { error: { code: 'unauthorized' } }),
    });
    await rejected.service.sync();
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index]!;
    });
  }

  const output = captured.join('\n');
  for (const marker of [
    TOKEN,
    'Bearer',
    'Authorization',
    String(AVAILABLE_LOCATION.latitude),
    String(AVAILABLE_LOCATION.longitude),
    'createdAtUtc',
    'ama@example.com',
  ]) {
    assert.ok(!output.includes(marker), `console output must not contain ${marker}`);
  }
});
