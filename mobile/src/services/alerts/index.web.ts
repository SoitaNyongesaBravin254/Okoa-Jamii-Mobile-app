/**
 * Web entry point for the alert persistence layer.
 *
 * Metro resolves this file (instead of `index.ts`) for the web platform, so
 * `expo-sqlite` — and its WebAssembly worker — is never reachable from the
 * web bundle. Native platforms keep using the SQLite entry point.
 */

import { IndexedDbAlertStore } from './indexeddb-alert-store';
import { WebAlertRepository } from './web-alert-repository';
import type { AlertRepository } from './alert-repository';

let instancePromise: Promise<AlertRepository> | null = null;

/**
 * Returns the app-wide web alert repository. The IndexedDB connection is
 * opened lazily on first use, so importing this module during static
 * rendering never touches browser-only APIs.
 */
export function getAlertRepository(): Promise<AlertRepository> {
  if (!instancePromise) {
    instancePromise = Promise.resolve(new WebAlertRepository(new IndexedDbAlertStore()));
  }
  return instancePromise;
}

export { AlertNotFoundError, AlertStorageError, AlertValidationError } from './alert-errors';
export { createAlertRecord } from './alert-model';
export { createSosSubmission } from './sos-submission';
export type { SosSubmission, SosSubmissionResult, LocationCapture } from './sos-submission';
export type { AlertRepository, UpdateStatusOptions } from './alert-repository';
