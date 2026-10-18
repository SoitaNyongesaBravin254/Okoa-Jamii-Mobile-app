/**
 * Express request augmentation.
 *
 * `principal` is only present on requests that passed the `authenticate`
 * middleware (or `optionalAuthenticate` when a valid token was supplied).
 * Handlers must still handle the `undefined` case defensively.
 */

import type { AuthenticatedPrincipal } from '../domain/auth';

declare global {
  namespace Express {
    interface Request {
      principal?: AuthenticatedPrincipal;
    }
  }
}

export {};