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
  corsOrigin: string | null;
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

const envSchema = z.object({
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
  JWT_EXPIRES_IN: z.string().trim().min(1).default('7d'),
  CORS_ORIGIN: z.string().trim().optional().transform((value) => value || null),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1024).max(10485760).default(65536),
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
  const config: AppConfig = {
    nodeEnv: value.NODE_ENV,
    isProduction: value.NODE_ENV === 'production',
    isTest: value.NODE_ENV === 'test',
    port: value.PORT,
    mongodbUri: value.MONGODB_URI,
    jwtSecret: value.JWT_SECRET,
    jwtExpiresIn: value.JWT_EXPIRES_IN,
    corsOrigin: value.CORS_ORIGIN,
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
    corsOrigin: config.corsOrigin,
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
