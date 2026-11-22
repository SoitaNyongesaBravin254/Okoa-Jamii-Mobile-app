/**
 * Server-side auth domain.
 *
 * Mirrors `mobile/src/utils/validation.ts` and `mobile/src/types/auth.ts` so
 * the phone's own form rules and the API's rules agree: a password the app
 * accepts must not be rejected by the server, and the error codes returned by
 * `/auth/*` are the mobile `AuthErrorCode` union verbatim.
 */

import { z } from 'zod';
import { MAX_DISPLAY_NAME_LENGTH } from './alerts';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MIN_DISPLAY_NAME_LENGTH = 2;

/** Roles granted to a account. Ordered least to most privileged. */
export const USER_ROLES = ['community', 'responder', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Verbatim from `mobile/src/types/auth.ts`. The HTTP adapter on the phone
 * maps these one-to-one, so a server error code is directly actionable.
 */
export const AUTH_ERROR_CODES = [
  'invalid-input',
  'invalid-credentials',
  'network',
  'unavailable',
  'conflict',
  'unknown',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** Same pattern the mobile app uses, so validation is identical on both sides. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: unknown): email is string {
  return typeof email === 'string' && EMAIL_PATTERN.test(email.trim());
}

export const loginInputSchema = z.strictObject({
  email: z
    .string()
    .trim()
    .min(1, { error: 'required' })
    .max(254, { error: 'too_long' })
    .refine(isValidEmail, { error: 'invalid_email' }),
  password: z.string().min(1, { error: 'required' }).max(MAX_PASSWORD_LENGTH, {
    error: 'too_long',
  }),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const registerInputSchema = z.strictObject({
  displayName: z
    .string()
    .trim()
    .min(MIN_DISPLAY_NAME_LENGTH, { error: 'too_short' })
    .max(MAX_DISPLAY_NAME_LENGTH, { error: 'too_long' }),
  email: z
    .string()
    .trim()
    .min(1, { error: 'required' })
    .max(254, { error: 'too_long' })
    .refine(isValidEmail, { error: 'invalid_email' }),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, { error: 'too_short' })
    .max(MAX_PASSWORD_LENGTH, { error: 'too_long' }),
});
export type RegisterInput = z.infer<typeof registerInputSchema>;

/** Shaped exactly like the mobile `UserProfile`. */
export type UserProfile = Readonly<{
  id: string;
  displayName: string;
  email: string;
  role: UserRole;
}>;

/** Shaped like the mobile `AuthSession`, plus the role the client needs. */
export type AuthSession = Readonly<{
  accessToken: string;
  provider: 'http';
  user: UserProfile;
  expiresAt: string;
}>;

/** Shape of a verified JWT payload. */
export type AuthenticatedPrincipal = Readonly<{
  userId: string;
  role: UserRole;
  email: string;
}>;
