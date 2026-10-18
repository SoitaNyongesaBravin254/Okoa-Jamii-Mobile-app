/**
 * JWT issuing and verification.
 *
 * The algorithm is pinned at verification time. Accepting whatever `alg` the
 * token claims is the classic JWT vulnerability; here a token that is not
 * HS256 is rejected before any signature check runs.
 */

import jwt from 'jsonwebtoken';
import type { AppConfig } from '../config/env';
import { AuthenticationError } from '../lib/errors';
import { isUserRole, type AuthenticatedPrincipal, type UserRole } from '../domain/auth';

const ALLOWED_ALGORITHM = 'HS256';

export type TokenService = Readonly<{
  issue(principal: AuthenticatedPrincipal): { token: string; expiresAt: string };
  verify(token: string): AuthenticatedPrincipal;
}>;

type TokenPayload = Readonly<{
  sub: string;
  role: string;
  email: string;
  iat?: number;
  exp?: number;
}>;

export function createTokenService(config: AppConfig): TokenService {
  return Object.freeze({
    issue(principal) {
      const token = jwt.sign({ role: principal.role, email: principal.email }, config.jwtSecret, {
        algorithm: ALLOWED_ALGORITHM,
        subject: principal.userId,
        expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
      });

      const decoded = jwt.decode(token) as TokenPayload | null;
      const expiresAt =
        decoded?.exp !== undefined
          ? new Date(decoded.exp * 1000).toISOString()
          : new Date().toISOString();

      return Object.freeze({ token, expiresAt });
    },

    verify(token: string): AuthenticatedPrincipal {
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new AuthenticationError('An access token is required.');
      }

      let payload: TokenPayload;
      try {
        payload = jwt.verify(token, config.jwtSecret, {
          algorithms: [ALLOWED_ALGORITHM],
        }) as TokenPayload;
      } catch {
        // Deliberately uniform: expired, malformed and wrongly-signed all look
        // the same from outside, so the endpoint is not an oracle.
        throw new AuthenticationError('The access token is invalid or has expired.');
      }

      if (
        typeof payload.sub !== 'string' ||
        typeof payload.email !== 'string' ||
        !isUserRole(payload.role)
      ) {
        throw new AuthenticationError('The access token is invalid or has expired.');
      }

      return Object.freeze({
        userId: payload.sub,
        role: payload.role as UserRole,
        email: payload.email,
      });
    },
  });
}
