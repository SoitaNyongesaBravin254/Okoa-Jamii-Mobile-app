/**
 * Secure session persistence.
 *
 * Tokens are sensitive, so on iOS/Android they are stored with
 * `expo-secure-store` (Keychain / Keystore) — never in AsyncStorage,
 * localStorage or plain text. Passwords are never stored at all.
 *
 * On web (and as a fallback when no secure keystore is available) the session
 * is kept in memory only: the user is asked to sign in again after a reload,
 * which is preferable to writing a token in plain text.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { isUserRole, type AuthSession, type UserProfile } from '@/types/auth';

export interface SessionStorage {
  /** Returns the stored session, or null when signed out / unavailable. */
  load(): Promise<AuthSession | null>;
  save(session: AuthSession): Promise<void>;
  clear(): Promise<void>;
}

const SESSION_KEY = 'okoa-jamii/session.v1';

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'okoa-jamii',
  // Requires the device to have been unlocked once after a restart; the
  // session is not migrated to a new device by backup/restore.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** In-memory fallback used when SecureStore is unavailable (e.g. web). */
let memorySession: AuthSession | null = null;

async function canUseSecureStore(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }
  try {
    return await SecureStore.isAvailableAsync();
  } catch (error) {
    console.warn('[session-storage] SecureStore availability check failed.', error);
    return false;
  }
}

export const sessionStore: SessionStorage = {
  async load(): Promise<AuthSession | null> {
    try {
      if (!(await canUseSecureStore())) {
        return memorySession;
      }

      const raw = await SecureStore.getItemAsync(SESSION_KEY, SECURE_OPTIONS);
      if (!raw) {
        return null;
      }

      const parsed: unknown = JSON.parse(raw);
      if (!isAuthSession(parsed)) {
        // Corrupted or outdated payload — drop it rather than trusting it.
        await sessionStore.clear();
        return null;
      }
      return parsed;
    } catch (error) {
      console.warn('[session-storage] Failed to load session; treating as signed out.', error);
      return null;
    }
  },

  async save(session: AuthSession): Promise<void> {
    memorySession = session;
    try {
      if (!(await canUseSecureStore())) {
        return;
      }
      await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), SECURE_OPTIONS);
    } catch (error) {
      console.warn(
        '[session-storage] Failed to persist session securely; keeping it in memory only.',
        error,
      );
    }
  },

  async clear(): Promise<void> {
    memorySession = null;
    try {
      if (!(await canUseSecureStore())) {
        return;
      }
      await SecureStore.deleteItemAsync(SESSION_KEY, SECURE_OPTIONS);
    } catch (error) {
      console.warn('[session-storage] Failed to delete stored session.', error);
    }
  },
};

/** Runtime shape check so we never trust whatever was persisted. */
function isAuthSession(value: unknown): value is AuthSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    accessToken?: unknown;
    provider?: unknown;
    user?: unknown;
    expiresAt?: unknown;
  };
  return (
    typeof candidate.accessToken === 'string' &&
    (candidate.provider === 'development-stub' || candidate.provider === 'http') &&
    isUserProfile(candidate.user) &&
    (candidate.expiresAt === null || typeof candidate.expiresAt === 'string')
  );
}

function isUserProfile(value: unknown): value is UserProfile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    displayName?: unknown;
    email?: unknown;
    role?: unknown;
  };
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.displayName === 'string' &&
    typeof candidate.email === 'string' &&
    isUserRole(candidate.role)
  );
}
