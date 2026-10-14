/**
 * Error types for the alert persistence layer.
 *
 * Messages are intentionally generic and must never embed coordinates,
 * receipts, tokens, or other alert content.
 */

export class AlertStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Thrown when an operation references an alert id that is not stored. */
export class AlertNotFoundError extends AlertStorageError {}

/** Thrown when alert input or a status transition violates the model rules. */
export class AlertValidationError extends AlertStorageError {}
