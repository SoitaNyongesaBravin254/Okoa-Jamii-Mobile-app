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
    // Phase 1 has no backend. Set EXPO_PUBLIC_API_BASE_URL when one exists.
    baseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? null,
  },
  features: {
    // No backend exists yet, so sign-in runs through the development stub.
    devAuthStub: true,
  },
};
