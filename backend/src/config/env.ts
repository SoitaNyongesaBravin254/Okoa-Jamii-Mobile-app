/**
 * Environment configuration.
 *
 * Loading strategy is deliberate and explicit:
 *
 *   1. The repository-root `.env` (and only that file) is loaded by
 *      `loadEnvironmentFiles()`. The path is computed from `__dirname`, never
 *      from the process working directory, so starting the server from any
 *      directory resolves the same file.
 *   2. Existing `process.env` values win (`override: false`) so real
 *      environment variables — CI secrets, `npm start` in production — are
 *      never silently overwritten by a file on disk.
 *   3. `loadConfig()` then validates a plain object. It is a pure function of
 *      its input, so tests can pass their own source without touching
 *      `process.env` or the filesystem.
 *
 * Failure messages name the offending VARIABLE, never its value.
 */

import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { sanitizeMessage } from './redact';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export class ConfigurationError extends Error {
  /** Variable names (and reason codes) only — never a value. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid environment configuration: ${issues.join('; ')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

/**
 * JWT lifetime accepted by `JWT_EXPIRES_IN`.
 *
 * Format is deliberately strict: `<positive integer><unit>` with the unit
 * taken from { @see JWT_EXPIRES_IN_UNITS }.
 *
 *   7d, 12h, 30m, 90s, 4w   -> accepted
 *   3600, 1.5h, 7 days, 0s  -> rejected
 *
 * A bare number such as "3600" is rejected rather than guessed at: jsonwebtoken
 * would read it as milliseconds (6 seconds) while an operator almost certainly
 * meant seconds or hours. Ambiguity in a credential lifetime is a defect.
 */
export const JWT_EXPIRES_IN_PATTERN = /^([1-9]\d*)(s|m|h|d|w)$/;
export const JWT_EXPIRES_IN_UNITS = ['s', 'm', 'h', 'd', 'w'] as const;
const JWT_UNIT_MS: Record<(typeof JWT_EXPIRES_IN_UNITS)[number], number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Bounds for an access-token lifetime: 1 minute .. 30 days. */
export const JWT_EXPIRES_IN_MIN_MS = 60_000;
export const JWT_EXPIRES_IN_MAX_MS = 30 * JWT_UNIT_MS.d;

/**
 * Parses `JWT_EXPIRES_IN` into milliseconds. Returns `null` for anything that
 * is not `<positive integer><unit>`; range enforcement happens at the caller so
 * an out-of-bounds value gets its own, distinct reason code.
 */
export function parseJwtExpiresIn(value: string): number | null {
  const match = JWT_EXPIRES_IN_PATTERN.exec(value);
  const unit = match?.[2] as keyof typeof JWT_UNIT_MS | undefined;
  if (!match?.[1] || !unit) return null;
  // Validate the numeric component BEFORE converting: digit strings beyond
  // Number.MAX_SAFE_INTEGER would silently lose precision in `Number()`, and
  // multiplication of a huge/Infinite value is not a reliable gate. No
  // in-range value can reach this guard (the largest is 2\,592\,000 for 30d).
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return null;
  return amount * JWT_UNIT_MS[unit];
}

/**
 * Reverse-proxy trust setting, mirroring Express' `app.set('trust proxy', …)`:
 *
 *   false       no proxy at all — the socket peer address is the client.
 *               This is the safe default for a directly-reached API.
 *   number      trust this many trusted hops from the right of X-Forwarded-For.
 *   string[]    trust only these IPs / CIDR ranges (one reverse proxy subnet).
 *
 * `true` (trust everyone) is never representable: it lets any client forge
 * `X-Forwarded-For` and defeat IP-based rate limiting.
 */
export type TrustProxySetting = false | number | readonly string[];

export type TrustProxyParse =
  | { ok: true; value: TrustProxySetting }
  | { ok: false; code: string };

/** Highest hop count we will accept; real deployments sit at 1–3. */
export const MAX_TRUSTED_PROXY_HOPS = 10;

/**
 * Numeric CIDR prefix of an entry, or `null` for a bare IP. Only meaningful
 * for entries that already passed {@link isIpOrCidr}: the prefix regex
 * admits no non-numeric spellings, so `Number()` cannot lose information.
 */
function cidrPrefix(entry: string): number | null {
  const parts = entry.split('/');
  return parts.length === 2 && parts[1] !== undefined ? Number(parts[1]) : null;
}

/** True for a bare IP (`10.0.0.5`) or a CIDR range (`10.0.0.0/8`). */
function isIpOrCidr(entry: string): boolean {
  const parts = entry.split('/');
  if (parts.length > 2) return false;
  const address = parts[0];
  const prefix = parts[1];
  if (!address || isIP(address) === 0) return false;
  if (prefix === undefined) return true;
  // No leading zeros (`/08`) and no zero padding (`/000`): some tooling
  // reads those as octal, so their meaning is ambiguous — reject instead.
  if (!/^(?:0|[1-9]\d{0,2})$/.test(prefix)) return false;
  return Number(prefix) <= (isIP(address) === 4 ? 32 : 128);
}

/**
 * Parses `TRUST_PROXY` into an Express-compatible setting.
 * Never echoes the rejected value — callers surface `code` only.
 */
export function parseTrustProxy(raw: string): TrustProxyParse {
  const value = raw.trim();
  if (value === '' || value === 'false' || value === '0') {
    return { ok: true, value: false };
  }
  // Blind trust: every peer is a proxy, so any client can forge its own IP.
  if (value === 'true' || value === '*') {
    return { ok: false, code: 'blind_trust_not_allowed' };
  }
  if (/^[1-9]\d*$/.test(value)) {
    const hops = Number(value);
    return hops <= MAX_TRUSTED_PROXY_HOPS
      ? { ok: true, value: hops }
      : { ok: false, code: 'must_be_hop_count_between_1_and_10' };
  }
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // A commas-only value (", ,") names no proxy, so it is the safe direct
  // default — the same as leaving the variable unset. Never trust-all.
  if (entries.length === 0) {
    return { ok: true, value: false };
  }
  if (entries.every(isIpOrCidr)) {
    // A /0 subnet matches every peer — functionally identical to `true` or
    // `*`, which are rejected above. Compare the VALIDATED numeric prefix so
    // the decision rests on CIDR semantics, not on the entry's spelling.
    if (entries.some((entry) => cidrPrefix(entry) === 0)) {
      return { ok: false, code: 'blind_trust_not_allowed' };
    }
    return { ok: true, value: entries };
  }
  return { ok: false, code: 'must_be_zero_hop_count_or_ip_cidr_list' };
}

/**
 * Exact `http(s)://host[:port]` origin — no path, no wildcard, no regex.
 * Host must be dot-separated labels of alphanumerics/hyphens (so `a..b`,
 * a leading `-` and a trailing dot are rejected); the port is validated
 * separately for range in {@link corsOriginIssue}.
 */
export const HTTP_ORIGIN_PATTERN =
  /^https?:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::\d{1,5})?$/;

/** Splits `CORS_ORIGIN` on commas into trimmed, non-empty, de-duplicated entries. */
export function splitCorsOrigins(raw: string): string[] {
  return [...
    new Set(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

/** Reason code for one allow-list entry, or `null` when it is acceptable. */
export function corsOriginIssue(origin: string): string | null {
  if (origin === '*') return 'wildcard_not_allowed';
  if (!HTTP_ORIGIN_PATTERN.test(origin)) return 'must_be_exact_http_origin';
  // A browser never sends Origin with port 0 or above 65535; such an entry
  // would be a dead allow-list line — fail it loudly instead.
  const port = /:(\d{1,5})$/.exec(origin)?.[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
    return 'port_out_of_range';
  }
  return null;
}

export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  isTest: boolean;
  port: number;
  /** In-memory only. Never logged, never serialised into a response. */
  mongodbUri: string;
  /** In-memory only. Never logged. */
  jwtSecret: string;
  jwtExpiresIn: string;
  /** Exact browser origins allowed by CORS. Empty = CORS middleware not mounted. */
  corsOrigins: readonly string[];
  /** Value passed to `app.set('trust proxy', …)`. */
  trustProxy: TrustProxySetting;
  logLevel: LogLevel;
  bcryptRounds: number;
  serverSelectionTimeoutMs: number;
  maxRequestBodyBytes: number;
}>;

/** The single `.env` file this application reads, at the repository root. */
export function resolveEnvFilePath(rootOverride?: string): string {
  const root = rootOverride ?? path.resolve(__dirname, '..', '..', '..');
  return path.join(root, '.env');
}

/**
 * Loads the repository-root `.env` into `process.env` if it exists.
 * Safe to call repeatedly: dotenv never overwrites existing variables.
 */
export function loadEnvironmentFiles(rootOverride?: string): { loaded: boolean; path: string } {
  const filePath = resolveEnvFilePath(rootOverride);
  if (!existsSync(filePath)) {
    return { loaded: false, path: filePath };
  }
  loadDotenv({ path: filePath, override: false, quiet: true });
  return { loaded: true, path: filePath };
}

export const MONGO_URI_PATTERN = /^mongodb(?:\+srv)?:\/\/\S+$/;

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z
    .string()
    .trim()
    .min(1, { error: 'required' })
    .refine((value) => MONGO_URI_PATTERN.test(value), { error: 'must_be_mongodb_scheme' }),
  JWT_SECRET: z
    .string()
    .min(1, { error: 'required' })
    // Authored as a custom refine (not .min) so the failure reports our
    // stable tag instead of a zod-version-specific built-in code.
    .refine((value) => value.length >= 32, {
      error: 'must_be_at_least_32_characters',
    }),
  JWT_EXPIRES_IN: z.string().trim().default('7d'),
  CORS_ORIGIN: z
    .string()
    .trim()
    .optional()
    .transform((value) => splitCorsOrigins(value ?? '')),
  TRUST_PROXY: z.string().trim().optional().transform((value) => value ?? ''),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1024).max(10485760).default(65536),
});

/**
 * Cross-field rules that a single field schema cannot express. Every issue is
 * authored as a static `custom` tag so `toSafeIssues` reports
 * `VARIABLE: reason-code` and never a value.
 */
const envSchema = baseEnvSchema.superRefine((value, ctx) => {
  const expiresInMs = parseJwtExpiresIn(value.JWT_EXPIRES_IN);
  if (expiresInMs === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_EXPIRES_IN'],
      message: 'must_match_duration_format',
    });
  } else if (expiresInMs < JWT_EXPIRES_IN_MIN_MS || expiresInMs > JWT_EXPIRES_IN_MAX_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_EXPIRES_IN'],
      message: 'must_be_between_1_minute_and_30_days',
    });
  }

  for (const origin of value.CORS_ORIGIN) {
    const issue = corsOriginIssue(origin);
    if (issue) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGIN'], message: issue });
      break;
    }
  }
  // Production serves browser clients: an empty allow-list would silently
  // disable CORS. Fail startup instead of shipping a broken configuration.
  if (value.NODE_ENV === 'production' && value.CORS_ORIGIN.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['CORS_ORIGIN'], message: 'required_in_production' });
  }

  const trustProxy = parseTrustProxy(value.TRUST_PROXY);
  if (!trustProxy.ok) {
    ctx.addIssue({ code: 'custom', path: ['TRUST_PROXY'], message: trustProxy.code });
  }
});

/**
 * Converts a ZodError into `field: reason-code` strings.
 * Only the issue *code* is surfaced — Zod messages can embed received values,
 * which for MONGODB_URI / JWT_SECRET would be a credential leak.
 */
function toSafeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    // `custom` issues carry the static tag WE authored in the schema above
    // (e.g. must_be_mongodb_scheme) — a stable machine-readable reason that
    // names no value. Built-in codes are used verbatim because their default
    // messages may embed the received input.
    if (issue.code === 'custom') return `${field}: ${sanitizeMessage(issue.message)}`;
    return `${field}: ${issue.code}`;
  });
}

/** Pure validator: takes an env-like object and returns a frozen config. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigurationError(toSafeIssues(parsed.error));
  }

  const value = parsed.data;
  const trustProxy = parseTrustProxy(value.TRUST_PROXY);
  const config: AppConfig = {
    nodeEnv: value.NODE_ENV,
    isProduction: value.NODE_ENV === 'production',
    isTest: value.NODE_ENV === 'test',
    port: value.PORT,
    mongodbUri: value.MONGODB_URI,
    jwtSecret: value.JWT_SECRET,
    jwtExpiresIn: value.JWT_EXPIRES_IN,
    corsOrigins: Object.freeze([...value.CORS_ORIGIN]),
    // Already validated above; a rejected value would have thrown.
    trustProxy: trustProxy.ok ? trustProxy.value : false,
    logLevel: value.LOG_LEVEL,
    bcryptRounds: value.BCRYPT_ROUNDS,
    serverSelectionTimeoutMs: value.SERVER_SELECTION_TIMEOUT_MS,
    maxRequestBodyBytes: value.MAX_REQUEST_BODY_BYTES,
  };

  return Object.freeze(config);
}

let cached: AppConfig | null = null;

/**
 * Loads the root `.env` (once) and validates it (once).
 * The returned object is frozen and must never be written to a log.
 */
export function getConfig(): AppConfig {
  if (cached) return cached;
  loadEnvironmentFiles();
  cached = loadConfig(process.env);
  return cached;
}

/** Test-only: clears the memoised configuration. */
export function resetConfigCache(): void {
  cached = null;
}

/**
 * Produces a loggable view of the configuration with every secret removed.
 * This is the only representation of config that may be printed.
 */
export function describeConfigForLog(config: AppConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    nodeEnv: config.nodeEnv,
    port: config.port,
    logLevel: config.logLevel,
    bcryptRounds: config.bcryptRounds,
    jwtExpiresIn: config.jwtExpiresIn,
    corsOrigins: config.corsOrigins,
    trustProxy: config.trustProxy,
    serverSelectionTimeoutMs: config.serverSelectionTimeoutMs,
    maxRequestBodyBytes: config.maxRequestBodyBytes,
    // Host and database name only — no user, no password, no credentials.
    mongodbHost: safeMongoHost(config.mongodbUri),
  });
}

/**
 * Extracts `cluster.example.mongodb.net/<db>` from a connection string for
 * diagnostics. Returns `null` on anything unrecognised so no partial
 * credential material can survive.
 */
export function safeMongoHost(uri: string): string | null {
  const match = /^(?:mongodb\+srv|mongodb):\/\/(?:[^@/]+)@([^/?\s]+)/.exec(uri);
  if (!match || !match[1]) return null;
  return match[1];
}
