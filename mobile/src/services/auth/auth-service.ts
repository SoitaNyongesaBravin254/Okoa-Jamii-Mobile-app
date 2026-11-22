/**
 * Authentication service selection.
 *
 * The active application configuration uses the real HTTP implementation in
 * `http-auth-service.ts`, pointed at `EXPO_PUBLIC_API_BASE_URL`. The auth store
 * only depends on the `AuthService` interface below, so the provider never
 * needs to know which implementation is in use.
 *
 * The development stub remains available for isolated development and tests,
 * but it is no longer selected by `appConfig` (see `features.devAuthStub`).
 * When no backend URL is configured the HTTP service fails with an explicit
 * `unavailable` result instead of accepting simulated credentials.
 */

import { appConfig } from '@/config/app-config';
import {
  createHttpAuthService,
  type AuthService,
} from '@/services/auth/http-auth-service';
import type { AuthResult, SessionVerification } from '@/types/auth';
import { isValidEmail, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/utils/validation';

export type { AuthService } from '@/services/auth/http-auth-service';

const DEV_STUB_LATENCY_MS = 400;
const DEV_STUB_SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates the DEVELOPMENT STUB auth service.
 *
 * - Makes no network requests and stores nothing: any syntactically valid
 *   credentials are accepted, so there is no user database and passwords are
 *   never retained.
 * - Returns a session with a clearly fake token marked `development-stub`.
 *
 * Only for isolated development/testing; never selected by the active config.
 */
export function createDevelopmentAuthService(): AuthService {
  console.info(
    '[auth] DEVELOPMENT stub active — sign-in is simulated on this device; no backend is contacted.',
  );

  return {
    provider: 'development-stub',

    async login({ email, password }): Promise<AuthResult> {
      await delay(DEV_STUB_LATENCY_MS);

      if (!isValidEmail(email)) {
        return {
          ok: false,
          error: { code: 'invalid-input', message: 'Enter a valid email address.' },
        };
      }
      if (!isAcceptablePassword(password)) {
        return {
          ok: false,
          error: {
            code: 'invalid-input',
            message: `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
          },
        };
      }

      return { ok: true, session: createDevSession(email.trim()) };
    },

    async register({ displayName, email, password }): Promise<AuthResult> {
      await delay(DEV_STUB_LATENCY_MS);

      if (displayName.trim().length < 2) {
        return {
          ok: false,
          error: { code: 'invalid-input', message: 'Enter your name.' },
        };
      }
      if (!isValidEmail(email)) {
        return {
          ok: false,
          error: { code: 'invalid-input', message: 'Enter a valid email address.' },
        };
      }
      if (!isAcceptablePassword(password)) {
        return {
          ok: false,
          error: {
            code: 'invalid-input',
            message: `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
          },
        };
      }

      return {
        ok: true,
        session: createDevSession(email.trim(), displayName.trim()),
      };
    },

    async verifySession(): Promise<SessionVerification> {
      // The stub has no backend token to verify. Restoration for stub sessions
      // is handled locally by the auth store and never calls this method; if
      // that ever changes, fail transiently rather than inventing a profile.
      return {
        status: 'unverified',
        error: {
          code: 'unavailable',
          message: 'Simulated sessions cannot be verified with the backend.',
        },
      };
    },
  };
}

function isAcceptablePassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

function createDevSession(email: string, displayName?: string) {
  const expiresAt = new Date(Date.now() + DEV_STUB_SESSION_DURATION_MS).toISOString();

  return {
    // Deliberately fake and self-identifying — never a real credential.
    accessToken: `dev-stub-token-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    provider: 'development-stub' as const,
    user: {
      id: `dev-stub-user-${Math.random().toString(36).slice(2, 10)}`,
      // The stub has no user database; fall back to the email prefix as a name.
      displayName: displayName ?? email.split('@')[0] ?? 'Community member',
      email,
      // The stub is a local development aid; treat it as the base role.
      role: 'community' as const,
    },
    expiresAt,
  };
}

/**
 * Active service. The stub is opt-in through config only; with it disabled the
 * app always talks HTTP and fails honestly when the backend is unreachable.
 */
export const authService: AuthService = appConfig.features.devAuthStub
  ? createDevelopmentAuthService()
  : createHttpAuthService({ baseUrl: appConfig.api.baseUrl });
