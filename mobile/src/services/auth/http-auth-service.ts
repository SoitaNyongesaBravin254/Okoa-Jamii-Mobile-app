/**
 * HTTP implementation of the mobile `AuthService`.
 *
 * Talks to the Express backend contract:
 *   POST {baseUrl}/api/v1/auth/login
 *   POST {baseUrl}/api/v1/auth/register
 *   GET  {baseUrl}/api/v1/auth/me       (Authorization: Bearer <accessToken>)
 *
 * Success: `{ ok: true, session: { accessToken, provider: 'http', user, expiresAt } }`
 * Failure: `{ ok: false, error: { code, message } }` (or the backend error
 * handler's `{ error: { code, message } }` envelope).
 * `/auth/me` success: `{ user: { id, displayName, email, role } }`.
 *
 * Deliberate properties:
 *  - No Expo / React Native imports, so this module is unit-testable in Node.
 *  - `fetch` is injected, which keeps tests offline and dependency-free.
 *  - Every response is validated at runtime; a malformed success body is an
 *    error, never a half-populated session.
 *  - Request bodies, passwords, tokens and headers are never logged.
 *  - One request helper (`request`) handles timeout, abort and error mapping
 *    for every endpoint, so there is no second HTTP client.
 */

// Relative (not `@/`) because this module is compiled and run directly by the
// Node test harness, where the Metro alias is not resolvable at runtime.
import {
  isUserRole,
  type AuthError,
  type AuthErrorCode,
  type AuthResult,
  type AuthSession,
  type LoginCredentials,
  type RegistrationInput,
  type SessionVerification,
  type UserProfile,
} from '../../types/auth';

export interface AuthService {
  /** Identifies the implementation in use (shown in the UI for transparency). */
  readonly provider: 'development-stub' | 'http';
  login(credentials: LoginCredentials): Promise<AuthResult>;
  register(input: RegistrationInput): Promise<AuthResult>;
  /** Verifies a stored access token and resolves the current profile. */
  verifySession(accessToken: string): Promise<SessionVerification>;
}

/** The subset of a fetch Response this service needs. */
export type FetchResponseLike = Readonly<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** The subset of fetch this service uses; injectable for tests. */
export type FetchLike = (
  url: string,
  init: Readonly<{
    method: 'GET' | 'POST';
    headers: Readonly<Record<string, string>>;
    body?: string;
    signal?: AbortSignal;
  }>,
) => Promise<FetchResponseLike>;

export type HttpAuthServiceOptions = Readonly<{
  /** Backend ORIGIN, e.g. `https://api.okoa.example` (no `/api/v1` suffix). */
  baseUrl: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}>;

const API_PREFIX = '/api/v1';

/* Full set of error codes the adapter understands, emitted by the backend. The
 * only supported way to extend mobile error mapping. */
export const AUTH_ERROR_CODES: readonly AuthErrorCode[] = [
  'invalid-input',
  'invalid-credentials',
  'network',
  'unavailable',
  'conflict',
  'unknown',
];

const NOT_CONFIGURED_MESSAGE =
  'Sign-in is not configured on this build. Set EXPO_PUBLIC_API_BASE_URL to the backend address.';
const TIMEOUT_MESSAGE = 'The server took too long to respond. Please try again.';
const MALFORMED_MESSAGE = 'The server returned an unexpected response. Please try again.';

/** Client-authored human-readable messages surfaced to the app. Produced by
 * the backend and echoed verbatim by design; the code is what callers branch
 * on. */
export const AUTH_ERROR_MESSAGES: Readonly<Record<AuthErrorCode, string>> = {
  'invalid-input': 'The request was rejected because of invalid input. Please check the details and try again.',
  'invalid-credentials': 'The email or password you entered is incorrect.',
  'network': 'Could not reach the server. Check your connection and try again.',
  'unavailable': 'Sign-in is temporarily unavailable. Please try again later.',
  'conflict': 'An account with this email address already exists.',
  'unknown': 'Something went wrong while contacting the server. Please try again.',
};

class RequestTimeoutError extends Error {}

function errorFor(code: AuthErrorCode, message: string = AUTH_ERROR_MESSAGES[code]): AuthError {
  return { code, message };
}

function fail(code: AuthErrorCode, message: string = AUTH_ERROR_MESSAGES[code]): AuthResult {
  return { ok: false, error: errorFor(code, message) };
}

function unverified(code: AuthErrorCode, message: string = AUTH_ERROR_MESSAGES[code]): SessionVerification {
  return { status: 'unverified', error: errorFor(code, message) };
}

/** Validates and normalises the configured origin:
 *  - must be an absolute http(s) URL,
 *  - trailing slashes are removed so `/api/v1/...` never doubles up.
 *
 * Returns null when the value is missing or unusable; callers must then fail
 * with `unavailable` rather than guessing a host. */
export function resolveApiOrigin(baseUrl: string | null | undefined): string | null {
  if (typeof baseUrl !== 'string') {
    return null;
  }
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.search.length > 0 || parsed.hash.length > 0) {
      return null;
    }
    return trimmed.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Runtime validation of a user profile, including the role union. */
export function parseUserProfile(value: unknown): UserProfile | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.displayName) ||
    !isNonEmptyString(value.email) ||
    !isUserRole(value.role)
  ) {
    return null;
  }
  // Copy only known fields so unexpected server properties never reach state.
  return {
    id: value.id,
    displayName: value.displayName,
    email: value.email,
    role: value.role,
  };
}

/** Runtime validation of the backend's `session` payload. */
export function parseSession(value: unknown): AuthSession | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.session)) {
    return null;
  }
  const session = value.session;
  const profile = parseUserProfile(session.user);

  if (!profile) {
    return null;
  }
  if (!isNonEmptyString(session.accessToken) || session.provider !== 'http') {
    return null;
  }
  if (session.expiresAt !== null && !isNonEmptyString(session.expiresAt)) {
    return null;
  }

  return {
    accessToken: session.accessToken,
    provider: 'http',
    user: profile,
    expiresAt: session.expiresAt,
  };
}

/** Runtime validation of the backend's `{ user }` reply from `/auth/me`. */
export function parseMeResponse(value: unknown): UserProfile | null {
  if (!isRecord(value)) {
    return null;
  }
  return parseUserProfile(value.user);
}

/** Reads `error.code` from either backend envelope shape, if it is valid. */
function readErrorCode(body: unknown): AuthErrorCode | null {
  if (!isRecord(body)) {
    return null;
  }
  const envelope = body.error;
  if (!isRecord(envelope) || typeof envelope.code !== 'string') {
    return null;
  }
  const code = envelope.code as AuthErrorCode;
  return AUTH_ERROR_CODES.includes(code) ? code : null;
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

/** Maps a non-2xx response without a usable error code onto the mobile union. */
function statusToCode(status: number): AuthErrorCode {
  if (status === 400 || status === 413 || status === 422) {
    return 'invalid-input';
  }
  if (status === 401 || status === 403) {
    return 'invalid-credentials';
  }
  if (status === 408 || status === 429) {
    return 'network';
  }
  if (status >= 500) {
    return 'unavailable';
  }
  return 'unknown';
}

function interpretResponse(status: number, raw: string): AuthResult {
  const body = parseJson(raw);

  if (status >= 200 && status < 300) {
    const session = parseSession(body);
    if (!session) {
      return fail('unknown', MALFORMED_MESSAGE);
    }
    return { ok: true, session };
  }

  const code = readErrorCode(body);
  if (code) {
    return fail(code);
  }
  // A 409 from the backend is a duplicate registration. It has no mobile error
  // code inside the envelope, so map it here instead of degrading to generic
  // unknown (which would hide the 'conflict' message from the app).
  if (status === 409) {
    return fail('conflict');
  }
  // Malformed or unrecognised error envelope: fall back to the HTTP status,
  // never to a raw body or message.
  return fail(statusToCode(status));
}

type RequestOptions = Readonly<{
  method: 'GET' | 'POST';
  /** Pre-serialised JSON body; never logged. */
  body?: string;
  /** Bearer token; never logged. */
  accessToken?: string;
}>;

type RequestOutcome =
  | Readonly<{ kind: 'response'; status: number; raw: string }>
  | Readonly<{ kind: 'failure'; error: AuthError }>;

/**
 * Messages are fixed, client-authored text: server messages must never be
 * echoed into the app (a misconfigured or compromised backend must not be
 * able to surface stack traces or internal detail).
 */

/** Default auth timeout in ms. */
export const DEFAULT_AUTH_TIMEOUT_MS = 30_000;

export function createHttpAuthService(options: HttpAuthServiceOptions): AuthService {
  const origin = resolveApiOrigin(options.baseUrl);
  const fetchImpl: FetchLike =
    options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_AUTH_TIMEOUT_MS;

  async function request(path: string, requestOptions: RequestOptions): Promise<RequestOutcome> {
    if (!origin) {
      return {
        kind: 'failure',
        error: errorFor('unavailable', NOT_CONFIGURED_MESSAGE),
      };
    }
    if (typeof fetchImpl !== 'function') {
      return {
        kind: 'failure',
        error: errorFor('unavailable', NOT_CONFIGURED_MESSAGE),
      };
    }

    const url = `${origin}${API_PREFIX}${path}`;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (requestOptions.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (requestOptions.accessToken !== undefined) {
      headers.Authorization = `Bearer ${requestOptions.accessToken}`;
    }

    const send = async (): Promise<{ status: number; raw: string }> => {
      const response = await fetchImpl(url, {
        method: requestOptions.method,
        headers,
        ...(requestOptions.body !== undefined ? { body: requestOptions.body } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
      return { status: response.status, raw: await response.text() };
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Best-effort cancellation; the race below is what guarantees the
        // caller never waits longer than the timeout.
        controller?.abort();
        reject(new RequestTimeoutError());
      }, timeoutMs);
    });

    try {
      const { status, raw } = await Promise.race([send(), timeout]);
      return { kind: 'response', status, raw };
    } catch (error) {
      if (error instanceof RequestTimeoutError) {
        return { kind: 'failure', error: errorFor('network', TIMEOUT_MESSAGE) };
      }
      // DNS failure, refused connection, abort, or a native fetch error.
      return { kind: 'failure', error: errorFor('network') };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  return {
    provider: 'http',

    login({ email, password }: LoginCredentials): Promise<AuthResult> {
      // Only the fields the API expects — no extra properties.
      return request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password }),
      }).then((outcome) =>
        outcome.kind === 'failure'
          ? { ok: false, error: outcome.error }
          : interpretResponse(outcome.status, outcome.raw),
      );
    },

    register({ displayName, email, password }: RegistrationInput): Promise<AuthResult> {
      return request('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          displayName: displayName.trim(),
          email: email.trim(),
          password,
        }),
      }).then((outcome) =>
        outcome.kind === 'failure'
          ? { ok: false, error: outcome.error }
          : interpretResponse(outcome.status, outcome.raw),
      );
    },

    async verifySession(accessToken: string): Promise<SessionVerification> {
      if (!isNonEmptyString(accessToken)) {
        return unverified('unavailable', NOT_CONFIGURED_MESSAGE);
      }

      const outcome = await request('/auth/me', {
        method: 'GET',
        accessToken,
      });

      if (outcome.kind === 'failure') {
        // Offline, timeout or missing configuration: not proof of invalidity.
        return { status: 'unverified', error: outcome.error };
      }

      const body = parseJson(outcome.raw);

      if (outcome.status >= 200 && outcome.status < 300) {
        const user = parseMeResponse(body);
        if (!user) {
          return unverified('unknown', MALFORMED_MESSAGE);
        }
        return { status: 'verified', user };
      }

      if (outcome.status === 401) {
        // The backend explicitly rejected the token. Only this status may
        // clear a stored session.
        return { status: 'rejected' };
      }

      // 5xx, 429, malformed error envelopes and anything else are transient.
      const code = readErrorCode(body) ?? statusToCode(outcome.status);
      return unverified(code);
    },
  };
}

/** Default auth timeout in ms. */
