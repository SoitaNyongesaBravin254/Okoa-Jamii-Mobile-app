/**
 * Authentication and role-based authorization middleware.
 *
 * - `authenticate`           -> 401 unless a verifiable bearer token is present.
 * - `optionalAuthenticate`   -> best-effort; used by health so an admin token
 *                               unlocks the diagnosis block while anonymous
 *                               callers still get a usable response.
 * - `requireRoles(...roles)` -> 403 when the principal's role is not allowed.
 *
 * Only signature-verified principals reach `req.principal`; nothing is read
 * from unverified token claims.
 */

import type { RequestHandler } from 'express';
import { AuthenticationError, AuthorizationError } from '../../lib/errors';
import type { UserRole } from '../../domain/auth';
import type { TokenService } from '../../services/token-service';

/** Extracts the token from `Authorization: Bearer <token>`, or null. */
function extractBearerToken(header: string | undefined | string[]): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match && match[1] ? match[1] : null;
}

export function authenticate(tokens: TokenService): RequestHandler {
  return (req, _res, next) => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      next(new AuthenticationError('An access token is required.'));
      return;
    }
    try {
      req.principal = tokens.verify(token);
      next();
    } catch (error) {
      // token-service throws AuthenticationError with a uniform message.
      next(error);
    }
  };
}

export function optionalAuthenticate(tokens: TokenService): RequestHandler {
  return (req, _res, next) => {
    const token = extractBearerToken(req.headers.authorization);
    if (token) {
      try {
        req.principal = tokens.verify(token);
      } catch {
        // An invalid token on an optional-auth route degrades to anonymous;
        // it must not become an error oracle for a diagnostics endpoint.
      }
    }
    next();
  };
}

/** 403 unless the principal holds one of `allowed`. Assumes `authenticate`. */
export function requireRoles(...allowed: readonly UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const principal = req.principal;
    if (!principal) {
      next(new AuthenticationError('An access token is required.'));
      return;
    }
    if (!allowed.includes(principal.role)) {
      next(new AuthorizationError());
      return;
    }
    next();
  };
}

/** Responders and admins may read the alert queue. */
export const requireResponder: RequestHandler = requireRoles('responder', 'admin');

/** Only admins may delete recorded alerts. */
export const requireAdmin: RequestHandler = requireRoles('admin');