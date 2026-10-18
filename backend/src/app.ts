/**
 * Express application assembly.
 *
 * `createApp` is pure dependency injection: everything it needs is passed in,
 * so tests can mount the real HTTP stack with in-memory fakes and never touch
 * MongoDB. The MongoDB-backed wiring lives in `index.ts`.
 *
 * Middleware order: helmet -> cors -> body parser -> access log -> rate limit
 * -> routes -> 404 -> error handler. The error handler must be last so every
 * thrown AppError is rendered by the same sanitizer.
 */

import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from './config/env';
import type { Logger } from './lib/logger';
import type { AuthService } from './services/auth-service';
import type { AlertService } from './services/alert-service';
import type { TokenService } from './services/token-service';
import { probeConnection } from './db/connection';
import { createErrorHandler, notFoundHandler } from './http/error-handler';
import { optionalAuthenticate } from './http/middleware/authenticate';
import { createAuthRouter } from './http/routes/auth-routes';
import { createAlertRouter } from './http/routes/alert-routes';
import { createHealthRouter } from './http/routes/health-routes';

export type AppDependencies = Readonly<{
  config: AppConfig;
  logger: Logger;
  tokens: TokenService;
  authService: AuthService;
  alertService: AlertService;
  /** Defaults to the real Mongoose probe; tests inject fakes. */
  probeDatabase?: () => ReturnType<typeof probeConnection>;
}>;

/** Access log: method, path (no query string — it may carry tokens), status. */
function createRequestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.info('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  };
}

export function createApp(deps: AppDependencies): Express {
  const { config, logger, tokens, authService, alertService } = deps;
  const probeDatabase = deps.probeDatabase ?? probeConnection;

  const app = express();
  app.disable('x-powered-by');

  app.use(helmet());
  if (config.corsOrigin) {
    app.use(cors({ origin: config.corsOrigin }));
  }
  app.use(express.json({ limit: config.maxRequestBodyBytes }));
  app.use(createRequestLogger(logger));

  // Rate limiting is infrastructure protection, not a tested behaviour: it is
  // disabled under NODE_ENV=test so suites never trip it accidentally.
  if (!config.isTest) {
    app.use(
      rateLimit({
        windowMs: 60_000,
        limit: 300,
        standardHeaders: true,
        legacyHeaders: false,
      }),
    );
    // Auth endpoints get a stricter budget: password guessing is expensive.
    app.use(
      '/api/v1/auth',
      rateLimit({
        windowMs: 15 * 60_000,
        limit: 30,
        standardHeaders: true,
        legacyHeaders: false,
      }),
    );
  }

  app.use('/api/v1/health', createHealthRouter({ probeDatabase, optionalAuth: optionalAuthenticate(tokens) }));
  app.use('/api/v1/auth', createAuthRouter({ authService, tokens }));
  app.use('/api/v1/alerts', createAlertRouter({ alertService, tokens }));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}