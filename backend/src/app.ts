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
 *
 * Proxy trust is set from validated configuration, never unconditionally:
 * `app.set('trust proxy', …)` decides which peers may speak for a client IP,
 * and that same value drives Express' `req.ip` and therefore rate-limit
 * bucketing. Trusting every peer would let any client forge X-Forwarded-For
 * and mint unlimited buckets.
 */

import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import {
  rateLimit,
  type RateLimitExceededEventHandler,
  type Logger as RateLimitLogger,
} from 'express-rate-limit';
import type { AppConfig } from './config/env';
import type { Logger } from './lib/logger';
import { RateLimitedError } from './lib/errors';
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

/**
 * Bridges express-rate-limit's diagnostics onto the project logger so its
 * validation findings land in the same redacted stream as everything else
 * instead of raw console output. Findings are forwarded, never swallowed;
 * the logger's redaction pipeline scrubs `detail` before it reaches a sink.
 */
function createRateLimitLogger(logger: Logger): RateLimitLogger {
  const forward = (level: 'error' | 'warn') => (error: unknown, message?: string): void => {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined;
    const detail = error instanceof Error ? error.message : String(error);
    logger[level](message ?? 'rate limiter diagnostic', {
      ...(code ? { rateLimiterCode: code } : {}),
      detail,
    });
  };
  return { error: forward('error'), warn: forward('warn') };
}

/**
 * 429 in the project's error envelope: `{ error: { code, message } }` with the
 * stable `rate-limited` code from the error taxonomy. The body is built only
 * from values we control — no window sizes, no counts, no internal detail.
 */
function createRateLimitHandler(logger: Logger): RateLimitExceededEventHandler {
  const limited = new RateLimitedError();
  return (req, res) => {
    logger.warn('rate limit exceeded', { method: req.method, path: req.path });
    res.status(limited.statusCode).json({
      error: { code: limited.code, message: limited.message },
    });
  };
}

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

  // Validated proxy trust: `false` (direct connection), a hop count, or an
  // allow-list of proxy IPs/CIDRs. Never `true`.
  app.set('trust proxy', config.trustProxy);

  app.use(helmet());
  if (config.corsOrigins.length > 0) {
    // `cors` reflects a request Origin only when it is an exact member of the
    // list; a non-member (and a request with no Origin) gets no allow-header.
    app.use(cors({ origin: [...config.corsOrigins] }));
  }
  app.use(express.json({ limit: config.maxRequestBodyBytes }));
  app.use(createRequestLogger(logger));

  // Rate limiting is infrastructure protection, not a tested behaviour: it is
  // disabled under NODE_ENV=test so suites never trip it accidentally.
  if (!config.isTest) {
    const rateLimitLogger = createRateLimitLogger(logger);
    const onLimitExceeded = createRateLimitHandler(logger);
    app.use(
      rateLimit({
        windowMs: 60_000,
        limit: 300,
        standardHeaders: true,
        legacyHeaders: false,
        logger: rateLimitLogger,
        handler: onLimitExceeded,
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
        logger: rateLimitLogger,
        handler: onLimitExceeded,
      }),
    );
  }

  // Authorization is rebuilt from the account record on every request, so a
  // demoted or deleted user's old token cannot outlive the change.
  app.use(
    '/api/v1/health',
    createHealthRouter({
      probeDatabase,
      optionalAuth: optionalAuthenticate(tokens, authService.resolveUser),
    }),
  );
  app.use('/api/v1/auth', createAuthRouter({ authService, tokens }));
  app.use(
    '/api/v1/alerts',
    createAlertRouter({ alertService, tokens, resolveUser: authService.resolveUser }),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}