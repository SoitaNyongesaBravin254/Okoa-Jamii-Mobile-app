/**
 * Mounts the REAL Express stack (auth middleware, RBAC, routes, error
 * sanitizer) on top of in-memory repositories. No database is touched, so
 * this helper is valid for the unit tier.
 */

import { createApp } from '../../src/app';
import type { AppConfig } from '../../src/config/env';
import { createLogger, type LogRecord, type Logger } from '../../src/lib/logger';
import { createTokenService } from '../../src/services/token-service';
import { createAuthService } from '../../src/services/auth-service';
import { createAlertService } from '../../src/services/alert-service';
import type { ConnectionProbe } from '../../src/db/connection';
import { makeConfig } from './config';
import { InMemoryAlertRepository, InMemoryUserRepository } from './fakes';

export type TestApp = Readonly<{
  app: ReturnType<typeof createApp>;
  config: AppConfig;
  tokens: ReturnType<typeof createTokenService>;
  users: InMemoryUserRepository;
  alerts: InMemoryAlertRepository;
  logRecords: LogRecord[];
  logger: Logger;
}>;

export function buildTestApp(options: {
  config?: Partial<AppConfig>;
  probe?: ConnectionProbe;
} = {}): TestApp {
  const config = makeConfig(options.config ?? {});
  const logRecords: LogRecord[] = [];
  const logger = createLogger({ level: 'debug', sink: (record) => logRecords.push(record) });

  const tokens = createTokenService(config);
  const users = new InMemoryUserRepository();
  const alerts = new InMemoryAlertRepository();

  const authService = createAuthService({ config, users, tokens, logger });
  const alertService = createAlertService({ alerts, logger });

  const probe: ConnectionProbe = options.probe ?? {
    connected: true,
    readyState: 1,
    diagnosis: null,
    lastError: null,
  };

  const app = createApp({
    config,
    logger,
    tokens,
    authService,
    alertService,
    probeDatabase: () => probe,
  });

  return Object.freeze({ app, config, tokens, users, alerts, logRecords, logger });
}