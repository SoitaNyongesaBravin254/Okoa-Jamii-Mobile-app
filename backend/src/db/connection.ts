/**
 * MongoDB connection management.
 *
 * Connection failures are classified into coarse, credential-free categories
 * so an operator can act on them (fix DNS, allowlist the IP, rotate the
 * password) without the raw driver error — which can embed the connection
 * string — ever reaching a log line or an HTTP response.
 */

import mongoose from 'mongoose';
import type { AppConfig } from '../config/env';
import { sanitizeMessage } from '../config/redact';

export type MongoErrorCategory =
  | 'malformed-uri'
  | 'dns-failure'
  | 'network-timeout'
  | 'authentication-failure'
  | 'authorization-failure'
  | 'ip-not-allowed'
  | 'tls-failure'
  | 'unknown';

export type MongoErrorDiagnosis = Readonly<{
  category: MongoErrorCategory;
  /** Operator guidance. Contains no host, user, password or URI. */
  hint: string;
}>;

const HINTS: Record<MongoErrorCategory, string> = {
  'malformed-uri':
    'MONGODB_URI is not a valid MongoDB connection string. Check the scheme (mongodb:// or mongodb+srv://) and that it ends with a database name.',
  'dns-failure':
    'The cluster hostname could not be resolved. Check network/DNS egress from this host, and confirm the cluster hostname in MONGODB_URI.',
  'network-timeout':
    'The cluster did not respond in time. Check network egress and firewall rules, and that the cluster is running.',
  'authentication-failure':
    'The database user was rejected. Rotate the credentials for the database user and update MONGODB_URI.',
  'authorization-failure':
    'The database user is authenticated but lacks privileges on the target database. Grant the required roles.',
  'ip-not-allowed':
    'The cluster refused the connection because this client IP is not allowlisted. Add the client IP (or 0.0.0.0/0 for ephemeral hosts) to the Atlas Network Access list.',
  'tls-failure':
    'The TLS handshake failed. Check that the connection uses the TLS-enabled scheme and a supported TLS version.',
  unknown: 'The database connection failed for an unrecognised reason. Inspect the sanitized driver error.',
};

function readField(error: unknown, key: string): unknown {
  if (error === null || typeof error !== 'object') return undefined;
  return (error as Record<string, unknown>)[key];
}

/**
 * Maps a driver error onto a category using only machine-readable fields.
 * Message text is used as a last resort and is never returned to the caller.
 */
export function classifyMongoError(error: unknown): MongoErrorDiagnosis {
  const code = readField(error, 'code');
  const codeName = readField(error, 'codeName');
  const name = readField(error, 'name');
  const message = typeof readField(error, 'message') === 'string' ? String(readField(error, 'message')) : '';
  const cause = readField(error, 'cause');
  const causeCode = readField(cause, 'code');

  const combined = `${String(code ?? '')} ${String(codeName ?? '')} ${message}`.toLowerCase();

  if (name === 'MongoParseError' || combined.includes('invalid connection string')) {
    return Object.freeze({ category: 'malformed-uri', hint: HINTS['malformed-uri'] });
  }

  if (code === 'ENOTFOUND' || causeCode === 'ENOTFOUND' || code === 'EAI_AGAIN' || causeCode === 'EAI_AGAIN') {
    return Object.freeze({ category: 'dns-failure', hint: HINTS['dns-failure'] });
  }

  if (combined.includes('ip address') && combined.includes('not allowed')) {
    return Object.freeze({ category: 'ip-not-allowed', hint: HINTS['ip-not-allowed'] });
  }

  if (
    code === 18 ||
    code === 'ERR_MONGODB_ADVERTISED_HOST_NOT_REACHABLE' ||
    combined.includes('authentication failed') ||
    combined.includes('auth failed')
  ) {
    return Object.freeze({ category: 'authentication-failure', hint: HINTS['authentication-failure'] });
  }

  if (code === 13 || combined.includes('not authorized') || combined.includes('unauthorized')) {
    return Object.freeze({ category: 'authorization-failure', hint: HINTS['authorization-failure'] });
  }

  if (
    name === 'MongoServerSelectionError' ||
    code === 'ETIMEDOUT' ||
    causeCode === 'ETIMEDOUT' ||
    combined.includes('server selection timed out') ||
    combined.includes('connection timed out')
  ) {
    return Object.freeze({ category: 'network-timeout', hint: HINTS['network-timeout'] });
  }

  if (combined.includes('tls') || combined.includes('ssl')) {
    return Object.freeze({ category: 'tls-failure', hint: HINTS['tls-failure'] });
  }

  return Object.freeze({ category: 'unknown', hint: HINTS.unknown });
}

export type ConnectionProbe = Readonly<{
  connected: boolean;
  /** Mongoose readyState: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting. */
  readyState: number;
  diagnosis: MongoErrorDiagnosis | null;
  /** Scrubbed driver message. Safe to log. */
  lastError: string | null;
}>;

let lastDiagnosis: MongoErrorDiagnosis | null = null;
let lastErrorMessage: string | null = null;

/**
 * Opens the connection. `serverSelectionTimeoutMS` is kept short so a
 * misconfigured deployment fails fast instead of hanging every request.
 */
/**
 * Minimal configuration `connectDatabase` needs. Kept as a Pick so specialized
 * callers (the Atlas verification script, tests) can connect without a full
 * application config — for example when only MONGODB_URI is present.
 */
export type DatabaseConfig = Pick<AppConfig, 'mongodbUri' | 'serverSelectionTimeoutMs'>;

export async function connectDatabase(config: DatabaseConfig): Promise<void> {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('error', (error: unknown) => {
    const diagnosis = classifyMongoError(error);
    lastDiagnosis = diagnosis;
    lastErrorMessage = sanitizeMessage(error instanceof Error ? error.message : String(error));
  });

  mongoose.connection.on('disconnected', () => {
    // Intentionally no error details: disconnects also happen on shutdown.
    lastDiagnosis = lastDiagnosis ?? null;
  });

  try {
    await mongoose.connect(config.mongodbUri, {
      serverSelectionTimeoutMS: config.serverSelectionTimeoutMs,
      // Driver v6+ no longer emits a console logger (the old `loggerLevel`
      // option was removed), so there is no code path that prints the URI.
    });
    lastDiagnosis = null;
    lastErrorMessage = null;
  } catch (error) {
    const diagnosis = classifyMongoError(error);
    lastDiagnosis = diagnosis;
    lastErrorMessage = sanitizeMessage(error instanceof Error ? error.message : String(error));
    throw new DatabaseConnectionError(diagnosis, lastErrorMessage);
  }
}

/** Carries a sanitized diagnosis; the original error is never attached. */
export class DatabaseConnectionError extends Error {
  readonly diagnosis: MongoErrorDiagnosis;
  readonly sanitizedMessage: string | null;

  constructor(diagnosis: MongoErrorDiagnosis, sanitizedMessage: string | null) {
    super(`database connection failed: ${diagnosis.category}`);
    this.name = 'DatabaseConnectionError';
    this.diagnosis = diagnosis;
    this.sanitizedMessage = sanitizedMessage;
  }
}

/** Non-throwing status probe used by `/api/v1/health` and the verify script. */
export function probeConnection(): ConnectionProbe {
  return Object.freeze({
    connected: mongoose.connection.readyState === 1,
    readyState: mongoose.connection.readyState,
    diagnosis: lastDiagnosis,
    lastError: lastErrorMessage,
  });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
