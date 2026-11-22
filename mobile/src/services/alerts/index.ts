/**
 * Public entry point for the alert persistence layer.
 * Screens/services should use `getAlertRepository()` and never build SQL.
 */

import type { AlertRepository } from './alert-repository';
import { openExpoSqliteDriver } from './expo-sqlite-driver';
import { SqliteAlertRepository } from './sqlite-alert-repository';

let instancePromise: Promise<AlertRepository> | null = null;

/**
 * Returns the app-wide alert repository, opening the SQLite database on first
 * use. Repeated calls share one connection and one initialization.
 */
export function getAlertRepository(): Promise<AlertRepository> {
  if (!instancePromise) {
    instancePromise = openExpoSqliteDriver()
      .then((driver) => new SqliteAlertRepository(driver))
      .catch((error: unknown) => {
        // A failed open must not poison every later attempt: clear the cached
        // promise so the caller's "try again" can re-open the database.
        instancePromise = null;
        throw error;
      });
  }
  return instancePromise;
}

export { SqliteAlertRepository } from './sqlite-alert-repository';
export type { AlertRepository } from './alert-repository';
export { AlertNotFoundError, AlertStorageError, AlertValidationError } from './alert-errors';
export { createAlertRecord } from './alert-model';
export { createSosSubmission } from './sos-submission';
export type { SosSubmission, SosSubmissionResult, LocationCapture } from './sos-submission';
export type { UpdateStatusOptions } from './alert-repository';
