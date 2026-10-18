/**
 * Redaction helpers.
 *
 * Everything that reaches a log sink passes through here first. The rules are
 * intentionally aggressive: over-redacting a harmless field is cheap, while a
 * leaked connection string or token cannot be taken back.
 */

export const REDACTED = '[redacted]';

/**
 * Any key containing one of these fragments is replaced wholesale. Kept as
 * substrings so `MONGODB_URI`, `mongoUri`, `connection_uri`, `dbPassword`,
 * `X-Api-Key` and friends are all covered without maintaining a whitelist.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'pass',
  'secret',
  'token',
  'credential',
  'cookie',
  'authoriz',
  'apikey',
  'api_key',
  'api-key',
  'private_key',
  'privatekey',
  'uri',
  'dsn',
  'jwt',
  'session',
  'pwd',
];

const SENSITIVE_KEY_PATTERN = new RegExp(SENSITIVE_KEY_FRAGMENTS.join('|'), 'i');

/** Connection strings of every MongoDB scheme, including query strings. */
const MONGODB_URI_PATTERN = /\bmongodb(?:\+srv)?:\/\/[^\s"',;)]+/gi;

/** Compact JWS/JWT shapes (`header.payload.signature`). */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;

/** `Authorization: Bearer <token>` style header values. */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

/** True when a key name looks like it holds something sensitive. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Scrubs secrets out of free-form text. Applied to every log message and to
 * every error message before it is logged or returned to a client.
 */
export function sanitizeMessage(message: string): string {
  if (typeof message !== 'string' || message.length === 0) return message;
  return message
    .replace(MONGODB_URI_PATTERN, '[redacted-mongodb-uri]')
    .replace(JWT_PATTERN, '[redacted-jwt]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]');
}

/**
 * Deep-copies a value, replacing sensitive keys with `[redacted]` and
 * scrubbing strings. Cycles, Errors, Dates and Maps are handled so this is
 * safe to point at arbitrary request/response payloads.
 */
export function redactSensitive(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return sanitizeMessage(value);

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return value.toString();

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeMessage(value.message),
      // Stacks contain file paths only; still scrub in case a value was inlined.
      ...(value.stack ? { stack: sanitizeMessage(value.stack) } : {}),
    };
  }

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry, seen));
  }

  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      const stringKey = String(key);
      out[stringKey] = isSensitiveKey(stringKey) ? REDACTED : redactSensitive(entry, seen);
    }
    return out;
  }

  if (value instanceof Set) {
    return redactSensitive([...value], seen);
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactSensitive(entry, seen);
    }
    return out;
  }

  return String(value);
}
