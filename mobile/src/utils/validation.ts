import type { LoginCredentials, RegistrationInput } from '@/types/auth';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
const MIN_DISPLAY_NAME_LENGTH = 2;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LoginFormErrors = {
  email?: string;
  password?: string;
};

export type RegisterFormErrors = LoginFormErrors & {
  displayName?: string;
  confirmPassword?: string;
};

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim());
}

/**
 * Validates the sign-in form. Returns a map of field name → error message.
 * An empty object means the input is valid.
 */
export function validateLoginForm(input: LoginCredentials): LoginFormErrors {
  const errors: LoginFormErrors = {};

  if (!isValidEmail(input.email)) {
    errors.email = 'Enter a valid email address.';
  }

  const passwordError = validatePassword(input.password);
  if (passwordError) {
    errors.password = passwordError;
  }

  return errors;
}

/**
 * Validates the registration form. Returns a map of field name → error message.
 * An empty object means the input is valid.
 */
export function validateRegisterForm(
  input: RegistrationInput & { confirmPassword: string },
): RegisterFormErrors {
  const errors: RegisterFormErrors = {};

  if (input.displayName.trim().length < MIN_DISPLAY_NAME_LENGTH) {
    errors.displayName = `Enter your name (at least ${MIN_DISPLAY_NAME_LENGTH} characters).`;
  }

  if (!isValidEmail(input.email)) {
    errors.email = 'Enter a valid email address.';
  }

  const passwordError = validatePassword(input.password);
  if (passwordError) {
    errors.password = passwordError;
  }

  if (input.confirmPassword !== input.password) {
    errors.confirmPassword = 'The two passwords do not match.';
  }

  return errors;
}

/** True when a field-error map contains at least one error. */
export function hasErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some((message) => message !== undefined);
}

function validatePassword(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return undefined;
}
