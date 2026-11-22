/**
 * Authentication and role-based authorization middleware.
 *
 * - `authenticate`           -> 401 unless a verifiable bearer token is present
 *                               AND its subject still resolves to an account.
 * - `optionalAuthenticate`   -> best-effort; used by health so an admin token
 *                               unlocks the diagnosis block while anonymous
 *                               callers still get a usable response.
 * - `requireRoles(...roles)` -> 403 when the principal's role is not allowed.
 *
 * Only signature-verified tokens reach `resolveUser`, and the principal used
 * for authorization is built from the CURRENT account record — not from the
 * token's `role`/`email` claims. Claims are therefore identity hints only.
 *
 * Revocation policy: authorization is never read from the token's `role`
 * claim, so a demotion or a deleted account takes effect on the very next
 * authenticated request. There is no deliberate revocation window; the only
 * boundary is the token's own expiry (`jwtExpiresIn`). The cost is one
 * indexed `_id` lookup per authenticated request (profile projection only,
 * never `passwordHash`), plus a second profile read inside `/auth/me`, which
 * needs the display name the principal does not carry.
 *
 * A lookup FAILURE is not a fallback to claims: the request fails closed
 * (500 via the error handler) rather than authorizing from a possibly-stale
 * token. A subject that is not a persisted account id simply resolves to "no
 * account" and gets the uniform 401.
 */

import type { RequestHandler } from 'express';
import { AuthenticationError, AuthorizationError } from '../../lib/errors';
import type { AuthenticatedPrincipal, UserProfile, UserRole } from '../../domain/auth';
import type { TokenService } from '../../services/token-service';

/** Uniform message: missing account, bad signature and expiry look alike. */
const INVALID_TOKEN_MESSAGE = 'The access token is invalid or has expired.';

/**
 * Loads the current account for a token subject. Returns null when no such
 * account exists. Implementations must use the profile-only read (no hash).
 */
export type PrincipalResolver = (userId: string) => Promise<UserProfile | null>;

/** Extracts the token from `Authorization: Bearer <token>`, or null. */
function extractBearerToken(header: string | undefined | string[]): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match && match[1] ? match[1] : null;
}

/**
 * Builds the authorization principal from the account record. Default-deny:
 * a missing account throws the same uniform 401 as an invalid token, so a
 * deleted user cannot authenticate with a still-valid signature.
 */
async function resolvePrincipal(
  tokens: TokenService,
  resolveUser: PrincipalResolver,
  token: string,
): Promise<AuthenticatedPrincipal> {
  const claimed = tokens.verify(token);
  const account = await resolveUser(claimed.userId);
  if (!account) {
    throw new AuthenticationError(INVALID_TOKEN_MESSAGE);
  }
  return Object.freeze({
    userId: account.id,
    role: account.role,
    email: account.email,
  });
}

export function authenticate(tokens: TokenService, resolveUser: PrincipalResolver): RequestHandler {
  return async (req, _res, next) => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      next(new AuthenticationError('An access token is required.'));
      return;
    }
    try {
      req.principal = await resolvePrincipal(tokens, resolveUser, token);
      next();
    } catch (error) {
      // token-service throws AuthenticationError with a uniform message; a
      // resolver failure propagates unchanged and fails closed.
      next(error);
    }
  };
}

export function optionalAuthenticate(
  tokens: TokenService,
  resolveUser: PrincipalResolver,
): RequestHandler {
  return async (req, _res, next) => {
    const token = extractBearerToken(req.headers.authorization);
    if (token) {
      try {
        req.principal = await resolvePrincipal(tokens, resolveUser, token);
      } catch {
        // An invalid token, a deleted account or an unavailable lookup all
        // degrade to anonymous: the route stays usable and never becomes an
        // error oracle for a diagnostics endpoint.
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
