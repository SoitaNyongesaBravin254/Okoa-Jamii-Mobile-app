/**
 * /api/v1/auth/*
 *
 * Response bodies mirror the mobile contract (`AuthResult` in
 * `mobile/src/types/auth.ts`) so the phone can branch on `error.code`
 * directly:
 *   success -> 200/201 `{ ok: true, session }`
 *   failure -> status  `{ ok: false, error: { code, message } }`
 *
 * Express 5 forwards rejected handler promises to the error handler, so
 * thrown `ConflictError` etc. are handled centrally.
 */

import { Router } from 'express';
import type { AuthService, AuthOutcome } from '../../services/auth-service';
import type { AuthErrorCode } from '../../domain/auth';
import { AuthenticationError, NotFoundError } from '../../lib/errors';
import type { TokenService } from '../../services/token-service';
import { authenticate } from '../middleware/authenticate';

/** Mobile `AuthErrorCode` -> HTTP status. */
const AUTH_STATUS: Record<AuthErrorCode, number> = {
  'invalid-input': 400,
  'invalid-credentials': 401,
  network: 503,
  unavailable: 503,
  unknown: 500,
};

function sendOutcome(outcome: AuthOutcome, successStatus: number, res: import('express').Response): void {
  if (!outcome.ok) {
    res.status(AUTH_STATUS[outcome.code]).json({
      ok: false,
      error: { code: outcome.code, message: outcome.message },
    });
    return;
  }
  res.status(successStatus).json({ ok: true, session: outcome.session });
}

export function createAuthRouter(deps: { authService: AuthService; tokens: TokenService }): Router {
  const { authService, tokens } = deps;
  const router = Router();

  router.post('/register', async (req, res) => {
    const outcome = await authService.register(req.body);
    sendOutcome(outcome, 201, res);
  });

  router.post('/login', async (req, res) => {
    const outcome = await authService.login(req.body);
    sendOutcome(outcome, 200, res);
  });

  router.get('/me', authenticate(tokens), async (req, res) => {
    const principal = req.principal;
    if (!principal) {
      // Unreachable when `authenticate` ran; kept so the invariant is total.
      throw new AuthenticationError('An access token is required.');
    }
    const profile = await authService.resolveUser(principal.userId);
    if (!profile) {
      throw new NotFoundError('The account for this token no longer exists.');
    }
    res.json({ user: profile });
  });

  return router;
}