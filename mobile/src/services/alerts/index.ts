/**
 * Public entry point for the alert persistence layer.
 * Screens/services should use `getAlertRepository()` and never build SQL.
 */

import { openExpoSqliteDriver } from './expo-sqlite-driver';
import { SqliteAlertRepository } from './sqlite-alert-repository';

let instancePromise: Promise<SqliteAlertRepository> | null = null;

/**
 * Returns the app-wide alert repository, opening the SQLite database on first
 * use. Repeated calls share one connection and one initialization.
 */
export function getAlertRepository(): Promise<SqliteAlertRepository> {
  if (!instancePromise) {
    instancePromise = openExpoSqliteDriver().then((driver) => new SqliteAlertRepository(driver));
  }
  return instancePromise;
}

export { SqliteAlertRepository } from './sqlite-alert-repository';
export { AlertNotFoundError, AlertStorageError, AlertValidationError } from './alert-errors';
export { createAlertRecord } from './alert-model';
export type { UpdateStatusOptions } from './sqlite-alert-repository';
