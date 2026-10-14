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
     * Base URL of the future backend API.
     * `null` means "no backend is configured" — Phase 1 runs without one.
     * Set the EXPO_PUBLIC_API_BASE_URL environment variable when a backend exists.
     */
    baseUrl: string | null;
  }>;
  features: Readonly<{
    /**
     * While `true`, authentication is handled by a clearly-labelled on-device
     * development stub (no network requests, no real accounts).
     * Must be switched off once a real auth API exists.
     */
    devAuthStub: boolean;
  }>;
}>;
