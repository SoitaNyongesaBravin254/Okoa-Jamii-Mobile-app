/**
 * Shared types describing the shape of the typed application configuration.
 * Keep this file free of runtime code so it can be imported anywhere.
 */

export type AppEnvironment = 'development' | 'production';

export type AppConfig = Readonly<{
  /** Human-readable app name shown in the UI. */
  displayName: string;
  /** Short description shown on the welcome screen. */
  tagline: string;
  /** App version, taken from app.json at build time. */
  version: string;
  environment: AppEnvironment;
  api: Readonly<{
    /**
     * Backend ORIGIN, not an API path: e.g. `https://api.okoa.example`.
     * Do not include `/api/v1`; the auth service appends it.
     * `null` means no backend is configured, and authentication then fails
     * with an explicit `unavailable` error instead of simulating success.
     */
    baseUrl: string | null;
  }>;
  features: Readonly<{
    /**
     * Isolated development/testing escape hatch only. While `true`, auth is
     * handled by a clearly-labelled on-device stub (no network requests, no
     * real accounts). The active app configuration sets this to `false`.
     */
    devAuthStub: boolean;
  }>;
}>;
