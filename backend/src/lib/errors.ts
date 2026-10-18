/**
 * Application error taxonomy.
 *
 * Two rules are enforced by construction:
 *  - Every AppError carries a machine-readable `code` so responses are stable.
 *  - `expose` decides whether the message may reach a client. Errors raised by
 *    our own validation are exposed; anything else collapses to a generic
 *    message at the error handler, so internal details never leak.
 */

export type ErrorCode =
  | 'validation-error'
  | 'authentication-error'
  | 'authorization-error'
  | 'not-found'
  | 'conflict'
  | 'rate-limited'
  | 'service-unavailable'
  | 'internal-error';

export type AppErrorOptions = {
  /** Whether `message` is safe to send to a client. Defaults to true. */
  expose?: boolean;
  cause?: unknown;
  /** Field-level issues, already safe to expose. */
  issues?: readonly string[];
};

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly exposed: boolean;
  readonly issues: readonly string[];

  constructor(statusCode: number, code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.exposed = options.expose ?? true;
    this.issues = options.issues ?? [];
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The request payload is invalid.', issues: readonly string[] = []) {
    super(400, 'validation-error', message, { issues });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed.') {
    super(401, 'authentication-error', message);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super(403, 'authorization-error', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.') {
    super(404, 'not-found', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'The request conflicts with the current state of the resource.') {
    super(409, 'conflict', message);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests. Please slow down and try again.') {
    super(429, 'rate-limited', message);
  }
}

/** Dependency (usually MongoDB) is unreachable or rejected the operation. */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'The service is temporarily unavailable. Please try again shortly.') {
    // Message is ours, so it is safe to expose; the cause never is.
    super(503, 'service-unavailable', message, { expose: true });
  }
}

export class InternalError extends AppError {
  constructor(message = 'An unexpected error occurred.', options: AppErrorOptions = {}) {
    super(500, 'internal-error', message, { ...options, expose: options.expose ?? false });
  }
}

/** Narrowing helper for handlers. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
