/**
 * GET /api/v1/health
 *
 * Public, credential-free liveness/readiness:
 *   - anonymous callers get `{ status, db: { connected, category } }`.
 *   - an authenticated ADMIN additionally gets the operator `hint` and the
 *     sanitized driver message, so diagnostics are available without making
 *     them public.
 *
 * `category` and `hint` come from `classifyMongoError` and contain no host,
 * user, password or connection string by construction.
 */

import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { ConnectionProbe } from '../../db/connection';

export type HealthProbe = () => ConnectionProbe;

const MONGODB_URI_MARKER = 'mongodb://';

export function createHealthRouter(deps: {
  probeDatabase: HealthProbe;
  /** Usually `optionalAuthenticate(tokens)`. */
  optionalAuth: RequestHandler;
}): Router {
  const router = Router();

  router.get('/', deps.optionalAuth, (req, res) => {
    const probe = deps.probeDatabase();
    const diagnosis = probe.diagnosis;

    const db: Record<string, unknown> = {
      connected: probe.connected,
      category: probe.connected
        ? null
        : (diagnosis ? diagnosis.category : 'unknown'),
    };

    const principal = req.principal;
    const isAdmin = principal !== undefined && principal.role === 'admin';
    if (!probe.connected && isAdmin && diagnosis) {
      // Credential-free operator guidance; safe by construction.
      db.hint = diagnosis.hint;
    }
    if (!probe.connected && isAdmin && probe.lastError) {
      // `lastError` is scrubbed by `sanitizeMessage` when it is captured.
      db.lastError = probe.lastError;
      // Belt-and-braces: never echo anything that still looks like a URI.
      if (probe.lastError.includes(MONGODB_URI_MARKER)) {
        delete db.lastError;
      }
    }

    res.status(probe.connected ? 200 : 503).json({
      status: probe.connected ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      db,
    });
  });

  return router;
}