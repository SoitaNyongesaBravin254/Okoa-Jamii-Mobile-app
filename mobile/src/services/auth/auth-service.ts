/**
 * Authentication service layer.
 *
 * Phase 1 has NO backend. The exported `authService` therefore points at a
 * clearly-labelled development stub that simulates the API on-device so the
 * UI flow can be exercised end-to-end. When a real backend exists (Phase 2+),
 * implement the `AuthService` interface with an HTTP client and switch the
 * selection below — callers (the auth store) will not need to change.
 */

import { appConfig } from '@/config/app-config';
import type {
  AuthProviderKind,
  AuthResult,
  LoginCredentials,
  RegistrationInput,
} from '@/types/auth';
import { isValidEmail, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/utils/validation';

export interface AuthService {
  /** Identifies the implementation in use (shown in the UI for transparency). */
  readonly provider: AuthProviderKind;
  login(credentials: LoginCredentials): Promise<AuthResult>;
  register(input: RegistrationInput): Promise<AuthResult>;
}

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
    },
    expiresAt,
  };
}

/**
 * Used when the dev stub is disabled but no backend is wired up yet.
 * Always fails explicitly instead of pretending to succeed.
 */
function createUnconfiguredAuthService(): AuthService {
  const unavailable: AuthResult = {
    ok: false,
    error: {
      code: 'unavailable',
      message: 'No authentication backend is configured yet. This arrives in a later phase.',
    },
  };

  return {
    provider: 'http',
    login: async () => unavailable,
    register: async () => unavailable,
  };
}

export const authService: AuthService = appConfig.features.devAuthStub
  ? createDevelopmentAuthService()
  : createUnconfiguredAuthService();
