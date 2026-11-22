/**
 * Shared authentication types used by screens, services and the auth store.
 */

/** Roles the backend grants. Mirrors `backend/src/domain/auth.ts`. */
export const USER_ROLES = ['community', 'responder', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

export type UserProfile = Readonly<{
  id: string;
  displayName: string;
  email: string;
  role: UserRole;
}>;

/** Which implementation produced/validates a session. */
export type AuthProviderKind = 'development-stub' | 'http';

/**
 * A signed-in session. The token is sensitive: it is persisted only through the
 * secure session storage abstraction, never in plain text or logs.
 */
export type AuthSession = Readonly<{
  accessToken: string;
  provider: AuthProviderKind;
  user: UserProfile;
  /** ISO-8601 expiry time, or null when the provider does not report one. */
  expiresAt: string | null;
}>;

export type LoginCredentials = Readonly<{
  email: string;
  password: string;
}>;

export type RegistrationInput = Readonly<{
  displayName: string;
  email: string;
  password: string;
}>;

export type AuthErrorCode =
  | 'invalid-input'
  | 'invalid-credentials'
  | 'network'
  | 'unavailable'
  | 'conflict'
  | 'unknown';

export type AuthError = Readonly<{
  code: AuthErrorCode;
  message: string;
}>;

/**
 * Whether a signed-in session has been confirmed by the backend in this app
 * run. `unverified` means the stored session is trusted from secure storage
 * but the backend could not confirm it (offline, timeout, server error).
 */
export type SessionVerificationState = 'verified' | 'unverified';

/**
 * Outcome of checking a stored access token against `GET /auth/me`.
 *
 *  - `verified`   -> the backend returned the current profile.
 *  - `rejected`   -> the backend explicitly rejected the token (HTTP 401).
 *  - `unverified` -> no trustworthy answer (network, timeout, 5xx, malformed
 *                    response or missing configuration). Never treated as
 *                    proof that the account is invalid.
 */
export type SessionVerification =
  | Readonly<{ status: 'verified'; user: UserProfile }>
  | Readonly<{ status: 'rejected' }>
  | Readonly<{ status: 'unverified'; error: AuthError }>;

/** Discriminated result so callers must handle failure explicitly. */
export type AuthResult =
  | Readonly<{ ok: true; session: AuthSession }>
  | Readonly<{ ok: false; error: AuthError }>;
