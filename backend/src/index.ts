/**
 * Server entry point.
 *
 * Startup order and failure behaviour:
 *   1. Load + validate configuration. On failure, print the offending
 *      VARIABLE NAMES + issue codes (never values) and exit 1.
 *   2. Connect to MongoDB through the backend's connection module. On
 *      failure, print the sanitized error category + operator hint
 *      (never the URI, user, password or host) and exit 1 — a server that
 *      cannot reach its database does not pretend to be healthy.
 *   3. Wire services with Mongo-backed repositories and listen.
 *   4. On SIGINT/SIGTERM: stop accepting connections, disconnect, exit 0.
 */

import type { Server } from 'node:http';
import { getConfig, ConfigurationError, describeConfigForLog } from './config/env';
import { createLogger } from './lib/logger';
import { connectDatabase, disconnectDatabase, DatabaseConnectionError } from './db/connection';
import { createTokenService } from './services/token-service';
import { createAuthService } from './services/auth-service';
import { createAlertService } from './services/alert-service';
import { MongoUserRepository } from './repositories/user-repository';
import { MongoAlertRepository } from './repositories/mongo-alert-repository';
import { createApp } from './app';

async function main(): Promise<void> {
  // 1. Configuration — issues are `variable: code` strings only.
  let config;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(`[startup] invalid environment configuration: ${error.issues.join('; ')}`);
      console.error('[startup] fix the variables above in the repository-root .env (see .env.example).');
    } else {
      console.error('[startup] configuration could not be loaded.');
    }
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: config.logLevel });
  // describeConfigForLog is the only sanctioned view: no URI, no JWT secret.
  logger.info('starting Okoa Jamii backend', describeConfigForLog(config));

  // 2. Database — sanitized category + hint on failure, then exit.
  try {
    await connectDatabase(config);
    logger.info('database connected', { host: describeConfigForLog(config).mongodbHost });
  } catch (error) {
    if (error instanceof DatabaseConnectionError) {
      logger.error('database connection failed', {
        category: error.diagnosis.category,
        hint: error.diagnosis.hint,
        // `sanitizedMessage` had mongodb:///, JWTs and Bearer values scrubbed.
        detail: error.sanitizedMessage,
      });
    } else {
      logger.error('database connection failed', {
        category: 'unknown',
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
    process.exitCode = 1;
    return;
  }

  // 3. Wiring.
  const tokens = createTokenService(config);
  const authService = createAuthService({
    config,
    users: new MongoUserRepository(),
    tokens,
    logger,
  });
  const alertService = createAlertService({ alerts: new MongoAlertRepository(), logger });

  const app = createApp({ config, logger, tokens, authService, alertService });

  const server: Server = app.listen(config.port, () => {
    logger.info('listening', { port: config.port, apiBase: `/api/v1` });
  });

  // 4. Graceful shutdown.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    server.close(() => {
      void disconnectDatabase().finally(() => {
        process.exit(0);
      });
    });
    // Do not hang forever on lingering keep-alive sockets.
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((error: unknown) => {
  // Last-resort handler: name + scrubbed message only.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[startup] fatal: ${message}`);
  process.exit(1);
});