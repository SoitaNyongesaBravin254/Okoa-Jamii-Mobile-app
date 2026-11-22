import Constants from 'expo-constants';

import type { AppConfig } from '@/types/config';

/**
 * The single source of truth for app-wide configuration.
 *
 * Values come from app.json (name/version) and EXPO_PUBLIC_* environment
 * variables, which Expo inlines into the bundle at build time. Anything added
 * here must also be added to the `AppConfig` type in `src/types/config.ts`.
 */
export const appConfig: AppConfig = {
  displayName: 'Okoa Jamii',
  tagline: 'Offline-first emergency response and community protection',
  version: Constants.expoConfig?.version ?? '1.0.0',
  environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  api: {
    // Backend ORIGIN only (e.g. https://api.okoa.example); the auth service
    // appends /api/v1 itself. Null when the build has no backend configured.
    baseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? null,
  },
  features: {
    // Real HTTP authentication is active. The development stub can be used
    // from isolated tests, but it is never selected by the app configuration
    // so simulated credentials cannot silently succeed.
    devAuthStub: false,
  },
};
