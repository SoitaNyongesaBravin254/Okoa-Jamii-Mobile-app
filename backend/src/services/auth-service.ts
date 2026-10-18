/**
 * Authentication service.
 *
 * Implements the mobile `AuthService` contract server-side: `login` and
 * `register` return the same session shape the phone expects from
 * `mobile/src/types/auth.ts`, with `provider` fixed to `'http'`.
 *
 * Two behaviours are deliberate:
 *  - Registration and login return the SAME error for "unknown email" and
 *    "wrong password", so the endpoint cannot be used to enumerate accounts.
 *  - Every failure is an `AuthErrorCode` from the mobile union, so the phone
 *    can branch on `error.code` without string matching.
 */

import bcrypt from 'bcryptjs';
import type { AppConfig } from '../config/env';
import type { Logger } from '../lib/logger';
import { ConflictError } from '../lib/errors';
import type { UserRepository } from '../repositories/user-repository';
import {
  loginInputSchema,
  registerInputSchema,
  type AuthErrorCode,
  type AuthSession,
  type LoginInput,
  type RegisterInput,
  type UserProfile,
} from '../domain/auth';
import type { TokenService } from './token-service';
import { z } from 'zod';

export type AuthFailure = Readonly<{ ok: false; code: AuthErrorCode; message: string }>;
export type AuthSuccess = Readonly<{ ok: true; session: AuthSession }>;
export type AuthOutcome = AuthSuccess | AuthFailure;

export type AuthService = Readonly<{
  register(input: unknown): Promise<AuthOutcome>;
  login(input: unknown): Promise<AuthOutcome>;
  /** Resolves the principal behind a token, or null when it does not verify. */
  resolveUser(userId: string): Promise<UserProfile | null>;
}>;

/** One message for both "no such account" and "wrong password". */
const INVALID_CREDENTIALS: AuthFailure = Object.freeze({
  ok: false,
  code: 'invalid-credentials',
  message: 'Email or password is incorrect.',
});

function invalidInput(message: string): AuthFailure {
  return Object.freeze({ ok: false, code: 'invalid-input', message });
}

function toProfile(user: {
  id: string;
  displayName: string;
  email: string;
  role: UserProfile['role'];
}): UserProfile {
  return Object.freeze({
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
  });
}

/** Maps the first Zod issue to a user-facing message. Never echoes the value. */
function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'The request payload is invalid.';
  const field = issue.path.length > 0 ? issue.path.join('.') : 'payload';
  return `The ${field} is invalid.`;
}

export function createAuthService(deps: {
  config: AppConfig;
  users: UserRepository;
  tokens: TokenService;
  logger: Logger;
}): AuthService {
  const { config, users, tokens, logger } = deps;

  return Object.freeze({
    async register(input: unknown): Promise<AuthOutcome> {
      const parsed = registerInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput(firstIssueMessage(parsed.error));
      }
      const registration = parsed.data as RegisterInput;

      const existing = await users.findByEmail(registration.email);
      if (existing) {
        // Conflict rather than a silent overwrite. The message is generic so
        // this does not become a stronger enumeration signal than login.
        throw new ConflictError('An account with that email address already exists.');
      }

      const passwordHash = await bcrypt.hash(registration.password, config.bcryptRounds);

      let created;
      try {
        created = await users.create({
          email: registration.email,
          displayName: registration.displayName,
          passwordHash,
          role: 'community',
        });
      } catch (error) {
        // Two registrations racing on the same email surface as a duplicate
        // key error from the unique index — treat it as a conflict, not a 500.
        const code = (error as { code?: unknown } | null)?.code;
        if (code === 11000) {
          throw new ConflictError('An account with that email address already exists.');
        }
        throw error;
      }

      const session = issueSession(tokens, created);
      logger.info('user registered', { userId: created.id, role: created.role });
      return Object.freeze({ ok: true, session });
    },

    async login(input: unknown): Promise<AuthOutcome> {
      const parsed = loginInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput(firstIssueMessage(parsed.error));
      }
      const credentials = parsed.data as LoginInput;

      const user = await users.findByEmail(credentials.email);
      if (!user) {
        // Burn comparable CPU so response time does not reveal "no such user".
        await bcrypt.compare(credentials.password, DUMMY_HASH);
        return INVALID_CREDENTIALS;
      }

      const matches = await bcrypt.compare(credentials.password, user.passwordHash);
      if (!matches) {
        return INVALID_CREDENTIALS;
      }

      const session = issueSession(tokens, user);
      logger.info('user signed in', { userId: user.id, role: user.role });
      return Object.freeze({ ok: true, session });
    },

    async resolveUser(userId: string): Promise<UserProfile | null> {
      const user = await users.findById(userId);
      return user ? toProfile(user) : null;
    },
  });
}

/**
 * A real bcrypt hash of a random value, used only to equalise timing when the
 * email is unknown. Computed once at startup.
 */
const DUMMY_HASH = bcrypt.hashSync('timing-equalisation-only', 10);

function issueSession(
  tokens: TokenService,
  user: { id: string; displayName: string; email: string; role: UserProfile['role'] },
): AuthSession {
  const issued = tokens.issue({ userId: user.id, role: user.role, email: user.email });

  return Object.freeze({
    accessToken: issued.token,
    provider: 'http' as const,
    user: toProfile(user),
    expiresAt: issued.expiresAt,
  });
}
