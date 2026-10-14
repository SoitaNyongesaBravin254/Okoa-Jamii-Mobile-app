/**
 * Shared authentication types used by screens, services and the auth store.
 */

export type UserProfile = Readonly<{
  id: string;
  displayName: string;
  email: string;
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
  | 'unknown';

export type AuthError = Readonly<{
  code: AuthErrorCode;
  message: string;
}>;

/** Discriminated result so callers must handle failure explicitly. */
export type AuthResult =
  | Readonly<{ ok: true; session: AuthSession }>
  | Readonly<{ ok: false; error: AuthError }>;
