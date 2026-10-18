/**
 * Verifies MongoDB Atlas connectivity THROUGH THE BACKEND'S OWN connection
 * module (`src/db/connection.ts`) — the same code path the server uses.
 *
 * Output rules (enforced below):
 *  - never prints the connection string, the username, the password, or the
 *    database user's credentials;
 *  - prints only: success flag, credential-free host, latency, ping result,
 *    or on failure a sanitized error CATEGORY plus an operator HINT and a
 *    scrubbed message.
 *
 * Exit codes: 0 = connected and ping ok; 1 = failed (reason on stderr as JSON).
 * Requires MONGODB_URI in the repository-root .env (JWT_SECRET not needed).
 */

import mongoose from 'mongoose';
import {
  loadEnvironmentFiles,
  MONGO_URI_PATTERN,
  safeMongoHost,
} from '../src/config/env';
import { sanitizeMessage } from '../src/config/redact';
import {
  classifyMongoError,
  connectDatabase,
  disconnectDatabase,
  DatabaseConnectionError,
} from '../src/db/connection';

function readTimeoutMs(): number {
  const raw = Number(process.env.SERVER_SELECTION_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 100 && raw <= 60_000) return raw;
  return 8_000;
}

async function main(): Promise<void> {
  const loaded = loadEnvironmentFiles();
  const uri = process.env.MONGODB_URI?.trim();

  if (!uri || !MONGO_URI_PATTERN.test(uri)) {
    console.error(
      JSON.stringify({
        connected: false,
        category: 'malformed-uri',
        hint: loaded
          ? 'MONGODB_URI is missing or not a mongodb:// / mongodb+srv:// URL. Check the repository-root .env.'
          : 'No repository-root .env file was found. Copy .env.example to .env and set MONGODB_URI.',
      }),
    );
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  try {
    await connectDatabase({
      mongodbUri: uri,
      serverSelectionTimeoutMs: readTimeoutMs(),
    });

    const db = mongoose.connection.db;
    const pingResult = await db?.admin().command({ ping: 1 });
    const pingOk = pingResult?.ok === 1;

    console.log(
      JSON.stringify({
        connected: true,
        host: safeMongoHost(uri),
        latencyMs: Date.now() - startedAt,
        pingOk,
      }),
    );
    process.exitCode = pingOk ? 0 : 1;
  } catch (error) {
    const diagnosis =
      error instanceof DatabaseConnectionError
        ? error.diagnosis
        : classifyMongoError(error);
    const detail =
      error instanceof DatabaseConnectionError
        ? error.sanitizedMessage
        : sanitizeMessage(error instanceof Error ? error.message : String(error));

    console.error(
      JSON.stringify({
        connected: false,
        category: diagnosis.category,
        hint: diagnosis.hint,
        detail,
      }),
    );
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      connected: false,
      category: 'unknown',
      detail: sanitizeMessage(error instanceof Error ? error.message : String(error)),
    }),
  );
  process.exit(1);
});