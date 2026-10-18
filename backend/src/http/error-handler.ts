/**
 * Centralised error handling.
 *
 * Guarantees:
 *  - The response body is built exclusively from values we control: an
 *    `AppError`'s exposed message/issues, or a fixed generic message.
 *  - Unexposed errors (the default for unexpected failures) collapse to
 *    `{ code: 'internal-error', message: 'An unexpected error occurred.' }`;
 *    their real message and stack go to the logger, redacted, never to the
 *    client.
 *  - Every logged record passes through the logger's redaction pipeline, so a
 *    driver error embedding the connection string cannot leak through here.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ErrorCode } from '../lib/errors';
import { isAppError } from '../lib/errors';
import { sanitizeMessage } from '../config/redact';
import type { Logger } from '../lib/logger';

const GENERIC_INTERNAL_MESSAGE = 'An unexpected error occurred.';

/** 404 for unmatched routes. Registered before the error handler. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({
    error: { code: 'not-found', message: 'The requested resource was not found.' },
  });
};

/**
 * Shape thrown by body-parser for malformed/oversized JSON. We only branch on
 * `type`; the rest of the error is never echoed.
 */
type BodyParserError = Error & { type?: string };

function zodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : 'payload';
    // Static tags we authored in our own schemas are safe; built-in codes are
    // used verbatim because their default messages may echo received values.
    if (issue.code === 'custom') return `${field}: ${sanitizeMessage(issue.message)}`;
    return `${field}: ${issue.code}`;
  });
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    if (res.headersSent) {
      // Cannot build a JSON body any more; end the response and let Express
      // tear down the socket rather than appending a second payload.
      res.end();
      return;
    }

    let status = 500;
    let code: ErrorCode = 'internal-error';
    let message = GENERIC_INTERNAL_MESSAGE;
    let issues: string[] | undefined;

    if (error instanceof ZodError) {
      // Reached only if some handler passes a raw ZodError to next();
      // services normally convert issues themselves.
      status = 400;
      code = 'validation-error';
      message = 'The request payload is invalid.';
      issues = zodIssues(error);
      logger.warn('validation error handled centrally', { issues });
    } else if (isAppError(error)) {
      status = error.statusCode;
      code = error.code;
      if (error.exposed) {
        message = sanitizeMessage(error.message);
        if (error.issues.length > 0) issues = [...error.issues];
      }
      const meta = { name: error.name, errorCode: error.code, status };
      if (status >= 500) {
        logger.error('request failed', meta);
      } else {
        logger.warn('request rejected', meta);
      }
    } else {
      const parserError = error as BodyParserError;
      if (parserError.type === 'entity.too.large') {
        status = 413;
        code = 'validation-error';
        message = 'The request payload is too large.';
        logger.warn('request body too large');
      } else if (parserError.type === 'entity.parse.failed') {
        status = 400;
        code = 'validation-error';
        message = 'The request body is not valid JSON.';
        logger.warn('request body was not valid json');
      } else {
        // Unexpected failure: real details are logged (redacted), never sent.
        logger.error('unhandled error', {
          name: error instanceof Error ? error.name : 'unknown',
          message: sanitizeMessage(error instanceof Error ? error.message : String(error)),
          stack: error instanceof Error && error.stack ? sanitizeMessage(error.stack) : undefined,
        });
      }
    }

    res.status(status).json({
      error: {
        code,
        message,
        ...(issues ? { issues } : {}),
      },
    });
  };
}