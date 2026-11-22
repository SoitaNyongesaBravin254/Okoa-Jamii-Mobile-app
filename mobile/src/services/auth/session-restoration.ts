/**
 * Startup session restoration.
 *
 * Pure orchestration so the startup contract is unit-testable without React:
 *
 *   no stored session          -> signed out
 *   development-stub session   -> restore as-is (local simulation only)
 *   http session               -> verify with `GET /auth/me`
 *     verified                 -> refresh the cached profile, keep token/expiry
 *     rejected (HTTP 401)      -> clear storage, sign out
 *     unverified (offline/5xx) -> keep the cached session, flag it unverified
 *
 * A network failure is never treated as proof that the account is invalid, so
 * offline-first access survives a temporarily unreachable backend.
 */

import type {
  AuthSession,
  SessionVerification,
  SessionVerificationState,
  UserProfile,
} from '@/types/auth';

export type SessionRestorationDeps = Readonly<{
  load(): Promise<AuthSession | null>;
  save(session: AuthSession): Promise<void>;
  clear(): Promise<void>;
  verifySession(accessToken: string): Promise<SessionVerification>;
}>;

export type SessionRestorationOutcome =
  | Readonly<{ status: 'signed-out' }>
  | Readonly<{
      status: 'restored';
      session: AuthSession;
      verification: SessionVerificationState;
    }>;

function restored(
  session: AuthSession,
  verification: SessionVerificationState,
): SessionRestorationOutcome {
  return { status: 'restored', session, verification };
}

/**
 * Applies a verified profile to the cached session while preserving the
 * credential and its expiry: verification refreshes identity, not secrets.
 */
export function applyVerifiedProfile(
  session: AuthSession,
  user: UserProfile,
): AuthSession {
  return { ...session, user };
}

export async function restoreStoredSession(
  deps: SessionRestorationDeps,
): Promise<SessionRestorationOutcome> {
  let stored: AuthSession | null;
  try {
    stored = await deps.load();
  } catch {
    // Storage itself failed; treat as signed out rather than crash startup.
    return { status: 'signed-out' };
  }

  if (!stored) {
    return { status: 'signed-out' };
  }

  // The development stub is intentionally local; keep its previous
  // restoration behaviour. It is never selected by the active configuration.
  if (stored.provider !== 'http') {
    return restored(stored, 'unverified');
  }

  let verification: SessionVerification;
  try {
    verification = await deps.verifySession(stored.accessToken);
  } catch {
    // The service is written not to throw, but an unexpected failure must not
    // sign the user out or block offline features.
    return restored(stored, 'unverified');
  }

  if (verification.status === 'verified') {
    const updated = applyVerifiedProfile(stored, verification.user);
    try {
      // Persist the refreshed profile; a storage failure still lets this run
      // use the verified profile in memory.
      await deps.save(updated);
    } catch {
      // Ignored deliberately: sessionStore.save already handles its own errors.
    }
    return restored(updated, 'verified');
  }

  if (verification.status === 'rejected') {
    try {
      await deps.clear();
    } catch {
      // Best effort: the auth store is signed out regardless.
    }
    return { status: 'signed-out' };
  }

  // Network/timeout/5xx/malformed/config: preserve the cached session.
  return restored(stored, 'unverified');
}
