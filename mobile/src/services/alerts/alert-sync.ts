/**
 * Pending-alert synchronisation (pure — no expo/react imports).
 *
 * Submits alerts that were persisted locally to:
 *
 *   POST {origin}/api/v1/alerts
 *   Authorization: Bearer <accessToken>
 *
 * The payload is exactly the backend ingestion contract:
 *   { id, category, location, createdAtUtc }
 *
 * Local-only state (`status`, `retryCount`, `serverReceipt`) is never sent,
 * and the user id is never sent because the backend derives it from the
 * bearer token. Available locations keep their real coordinates; unavailable
 * locations keep only their reason — coordinates are never invented.
 *
 * Safety invariants:
 *  - An alert is marked `sent` ONLY after a validated `{ ok: true, alert }`
 *    response whose id, category, status and receipt all match.
 *  - Any failure leaves the alert `pending`; nothing is ever deleted.
 *  - The stable local id is reused on every attempt, so the backend's
 *    idempotency makes duplicate delivery safe.
 *  - One run at a time: a concurrent call is rejected, not queued.
 *  - Nothing is logged here — no tokens, headers, coordinates or payloads.
 */

import {
  resolveApiOrigin,
  type FetchLike,
} from '../auth/http-auth-service';
import { isAlertCategory, isCanonicalUtcTimestamp } from './alert-model';
import type { AuthSession } from '../../types/auth';
import type { AlertCategory, AlertLocation, AlertRecord } from '../../types/alert';

export type AlertSyncConnectivity = 'online' | 'offline' | 'unknown';

export type AlertSyncErrorCode =
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'server'
  | 'rejected'
  | 'invalid-response'
  | 'storage';

export type AlertSyncError = Readonly<{
  code: AlertSyncErrorCode;
  message: string;
}>;

export type AlertSyncResult =
  | Readonly<{
      outcome: 'completed';
      /** Alerts confirmed by the backend and marked sent in this run. */
      submitted: number;
      /** Alerts from this batch that are still pending. */
      pendingRemaining: number;
    }>
  | Readonly<{
      outcome: 'skipped';
      reason: 'offline' | 'no-session' | 'not-configured' | 'already-running';
    }>
  | Readonly<{
      outcome: 'stopped';
      submitted: number;
      pendingRemaining: number;
      error: AlertSyncError;
    }>;

/** Exactly the fields the backend accepts; nothing local is included. */
export type AlertSyncPayload = Readonly<{
  id: string;
  category: AlertCategory;
  location: AlertLocation;
  createdAtUtc: string;
}>;

export type AlertSyncReceipt = Readonly<{
  id: string;
  category: AlertCategory;
  status: 'received';
  serverReceipt: string;
  createdAtUtc: string;
  receivedAtUtc: string;
  duplicate: boolean;
}>;

export type AlertSyncDependencies = Readonly<{
  /** Backend ORIGIN, e.g. `https://api.okoa.example` (no `/api/v1`). */
  baseUrl: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  getConnectivity(): Promise<AlertSyncConnectivity>;
  getSession(): Promise<AuthSession | null>;
  listPendingAlerts(): Promise<readonly AlertRecord[]>;
  markAlertSent(id: string, serverReceipt: string): Promise<void>;
}>;

export type AlertSyncService = Readonly<{
  isSyncing(): boolean;
  /** Submits the current pending queue once. Never throws. */
  sync(): Promise<AlertSyncResult>;
}>;

const API_PREFIX = '/api/v1';
const ALERTS_PATH = '/alerts';
export const DEFAULT_SYNC_TIMEOUT_MS = 10_000;

/** Fixed, client-authored messages. Server detail is never echoed. */
const ERROR_MESSAGES: Readonly<Record<AlertSyncErrorCode, string>> = {
  network: 'Could not reach the server to send pending alerts.',
  timeout: 'Sending pending alerts timed out.',
  unauthorized: 'Your session could not be authenticated. Please sign in again.',
  server: 'The server could not accept alerts right now.',
  rejected: 'The server rejected an alert payload.',
  'invalid-response': 'The server returned an unexpected response.',
  storage: 'Pending alerts could not be updated on this device.',
};

function syncError(code: AlertSyncErrorCode): AlertSyncError {
  return { code, message: ERROR_MESSAGES[code] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Maps a stored alert onto the ingestion contract. Copies only known fields
 * so a future local column can never leak into the request body.
 */
export function toAlertPayload(alert: AlertRecord): AlertSyncPayload {
  const location: AlertLocation =
    alert.location.state === 'available'
      ? {
          state: 'available',
          latitude: alert.location.latitude,
          longitude: alert.location.longitude,
          accuracyMeters: alert.location.accuracyMeters,
        }
      : {
          state: 'unavailable',
          reason: alert.location.reason,
        };

  return {
    id: alert.id,
    category: alert.category,
    location,
    createdAtUtc: alert.createdAtUtc,
  };
}

/**
 * Runtime validation of the backend's ingestion reply. Returns null unless
 * the envelope and every field are well formed AND the receipt belongs to the
 * alert we submitted.
 */
export function parseAlertReceipt(
  body: unknown,
  expected: Readonly<{ id: string; category: AlertCategory }>,
): AlertSyncReceipt | null {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.alert)) {
    return null;
  }
  const alert = body.alert;

  if (
    !isNonEmptyString(alert.id) ||
    alert.id !== expected.id ||
    !isAlertCategory(alert.category) ||
    alert.category !== expected.category ||
    alert.status !== 'received' ||
    !isNonEmptyString(alert.serverReceipt) ||
    !isNonEmptyString(alert.createdAtUtc) ||
    !isCanonicalUtcTimestamp(alert.createdAtUtc) ||
    !isNonEmptyString(alert.receivedAtUtc) ||
    !isCanonicalUtcTimestamp(alert.receivedAtUtc) ||
    typeof alert.duplicate !== 'boolean'
  ) {
    return null;
  }

  return {
    id: alert.id,
    category: alert.category,
    status: 'received',
    serverReceipt: alert.serverReceipt,
    createdAtUtc: alert.createdAtUtc,
    receivedAtUtc: alert.receivedAtUtc,
    duplicate: alert.duplicate,
  };
}

function parseJson(raw: string): unknown {
  if (raw.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

class SyncTimeoutError extends Error {}

type SubmitOutcome =
  | Readonly<{ kind: 'success'; receipt: AlertSyncReceipt }>
  | Readonly<{ kind: 'failure'; error: AlertSyncError }>;

export function createAlertSyncService(deps: AlertSyncDependencies): AlertSyncService {
  const origin = resolveApiOrigin(deps.baseUrl);
  const fetchImpl: FetchLike | undefined =
    deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  const timeoutMs =
    deps.timeoutMs !== undefined && deps.timeoutMs > 0
      ? deps.timeoutMs
      : DEFAULT_SYNC_TIMEOUT_MS;

  let inFlight = false;

  async function submit(alert: AlertRecord, accessToken: string): Promise<SubmitOutcome> {
    if (!origin) {
      return { kind: 'failure', error: syncError('network') };
    }
    if (typeof fetchImpl !== 'function') {
      return { kind: 'failure', error: syncError('network') };
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const body = JSON.stringify(toAlertPayload(alert));

    const send = async (): Promise<{ status: number; raw: string }> => {
      const response = await fetchImpl(`${origin}${API_PREFIX}${ALERTS_PATH}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body,
        ...(controller ? { signal: controller.signal } : {}),
      });
      return { status: response.status, raw: await response.text() };
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new SyncTimeoutError());
      }, timeoutMs);
    });

    let response: { status: number; raw: string };
    try {
      response = await Promise.race([send(), timeout]);
    } catch (error) {
      return {
        kind: 'failure',
        error: syncError(error instanceof SyncTimeoutError ? 'timeout' : 'network'),
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    // New alerts are 201, verified duplicates are 200. Any other 2xx shape is
    // not part of the contract.
    if (response.status === 200 || response.status === 201) {
      const receipt = parseAlertReceipt(parseJson(response.raw), {
        id: alert.id,
        category: alert.category,
      });
      if (!receipt) {
        return { kind: 'failure', error: syncError('invalid-response') };
      }
      return { kind: 'success', receipt };
    }

    if (response.status === 401 || response.status === 403) {
      return { kind: 'failure', error: syncError('unauthorized') };
    }
    if (response.status >= 500) {
      return { kind: 'failure', error: syncError('server') };
    }
    if (response.status >= 200 && response.status < 300) {
      return { kind: 'failure', error: syncError('invalid-response') };
    }
    return { kind: 'failure', error: syncError('rejected') };
  }

  async function run(): Promise<AlertSyncResult> {
    // Only submit when the device is confirmed online; `unknown` is not
    // treated as online, so we never fire a request blind.
    let connectivity: AlertSyncConnectivity;
    try {
      connectivity = await deps.getConnectivity();
    } catch {
      connectivity = 'offline';
    }
    if (connectivity !== 'online') {
      return { outcome: 'skipped', reason: 'offline' };
    }

    let session: AuthSession | null;
    try {
      session = await deps.getSession();
    } catch {
      session = null;
    }
    // Only a real HTTP session has a backend token. Cached-but-unverified
    // sessions are still allowed; no credentials are ever invented.
    if (
      !session ||
      session.provider !== 'http' ||
      !isNonEmptyString(session.accessToken)
    ) {
      return { outcome: 'skipped', reason: 'no-session' };
    }
    if (!origin || typeof fetchImpl !== 'function') {
      return { outcome: 'skipped', reason: 'not-configured' };
    }

    let pending: readonly AlertRecord[];
    try {
      pending = await deps.listPendingAlerts();
    } catch {
      return {
        outcome: 'stopped',
        submitted: 0,
        pendingRemaining: 0,
        error: syncError('storage'),
      };
    }

    let submitted = 0;
    for (const alert of pending) {
      const outcome = await submit(alert, session.accessToken);
      if (outcome.kind === 'failure') {
        return {
          outcome: 'stopped',
          submitted,
          pendingRemaining: pending.length - submitted,
          error: outcome.error,
        };
      }

      try {
        // A validated backend receipt is the only path to `sent`. If the local
        // write fails the alert stays pending; the backend idempotency key
        // (the stable alert id) makes the retry safe.
        await deps.markAlertSent(alert.id, outcome.receipt.serverReceipt);
      } catch {
        return {
          outcome: 'stopped',
          submitted,
          pendingRemaining: pending.length - submitted,
          error: syncError('storage'),
        };
      }
      submitted += 1;
    }

    return {
      outcome: 'completed',
      submitted,
      pendingRemaining: pending.length - submitted,
    };
  }

  return {
    isSyncing: () => inFlight,

    async sync(): Promise<AlertSyncResult> {
      if (inFlight) {
        return { outcome: 'skipped', reason: 'already-running' };
      }
      inFlight = true;
      try {
        return await run();
      } catch {
        // Defensive: run() is written not to throw. Treat anything unexpected
        // as a failed run; alerts were left pending.
        return {
          outcome: 'stopped',
          submitted: 0,
          pendingRemaining: 0,
          error: syncError('storage'),
        };
      } finally {
        inFlight = false;
      }
    },
  };
}
