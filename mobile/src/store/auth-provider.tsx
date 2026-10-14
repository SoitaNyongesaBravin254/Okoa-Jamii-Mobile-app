/**
 * Typed authentication state store (React Context — no extra dependencies).
 *
 * Responsibilities:
 * - Track whether a session is loading, authenticated or unauthenticated.
 * - Persist the session through the secure storage abstraction.
 * - Surface submit state and auth errors to the forms.
 *
 * Screens read this store via `useAuth()`; they never talk to the auth
 * service or storage directly.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type PropsWithChildren,
} from 'react';

import { authService } from '@/services/auth/auth-service';
import { sessionStore } from '@/services/auth/session-storage';
import type {
  AuthProviderKind,
  AuthSession,
  LoginCredentials,
  RegistrationInput,
  UserProfile,
} from '@/types/auth';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

type AuthState = Readonly<{
  status: AuthStatus;
  user: UserProfile | null;
  /** Which auth implementation signed the user in (dev stub in Phase 1). */
  provider: AuthProviderKind | null;
  /** True while a sign-in/sign-up request is in flight. */
  isSubmitting: boolean;
  /** Error message from the last failed sign-in/sign-up attempt. */
  authError: string | null;
}>;

type AuthAction =
  | Readonly<{ type: 'hydrated'; session: AuthSession | null }>
  | Readonly<{ type: 'signed-in'; session: AuthSession }>
  | Readonly<{ type: 'signed-out' }>
  | Readonly<{ type: 'submit-started' }>
  | Readonly<{ type: 'submit-failed'; message: string }>
  | Readonly<{ type: 'error-dismissed' }>;

const initialState: AuthState = {
  status: 'loading',
  user: null,
  provider: null,
  isSubmitting: false,
  authError: null,
};

function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'hydrated':
      return {
        ...state,
        status: action.session ? 'authenticated' : 'unauthenticated',
        user: action.session?.user ?? null,
        provider: action.session?.provider ?? null,
      };
    case 'signed-in':
      return {
        ...state,
        status: 'authenticated',
        user: action.session.user,
        provider: action.session.provider,
        isSubmitting: false,
        authError: null,
      };
    case 'signed-out':
      return { ...initialState, status: 'unauthenticated' };
    case 'submit-started':
      return { ...state, isSubmitting: true, authError: null };
    case 'submit-failed':
      return { ...state, isSubmitting: false, authError: action.message };
    case 'error-dismissed':
      return { ...state, authError: null };
  }
}

export type AuthContextValue = AuthState & {
  /** Returns true when the user was signed in successfully. */
  signIn(credentials: LoginCredentials): Promise<boolean>;
  /** Returns true when the account was created and the user is signed in. */
  signUp(input: RegistrationInput): Promise<boolean>;
  signOut(): Promise<void>;
  dismissAuthError(): void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(authReducer, initialState);

  // Restore a previously stored session when the app starts.
  useEffect(() => {
    let isActive = true;
    sessionStore.load().then((session) => {
      if (isActive) {
        dispatch({ type: 'hydrated', session });
      }
    });
    return () => {
      isActive = false;
    };
  }, []);

  const signIn = useCallback(async (credentials: LoginCredentials): Promise<boolean> => {
    dispatch({ type: 'submit-started' });
    try {
      const result = await authService.login(credentials);
      if (!result.ok) {
        dispatch({ type: 'submit-failed', message: result.error.message });
        return false;
      }
      await sessionStore.save(result.session);
      dispatch({ type: 'signed-in', session: result.session });
      return true;
    } catch (error) {
      console.warn('[auth] Sign-in failed unexpectedly.', error);
      dispatch({
        type: 'submit-failed',
        message: 'Something went wrong while signing in. Please try again.',
      });
      return false;
    }
  }, []);

  const signUp = useCallback(async (input: RegistrationInput): Promise<boolean> => {
    dispatch({ type: 'submit-started' });
    try {
      const result = await authService.register(input);
      if (!result.ok) {
        dispatch({ type: 'submit-failed', message: result.error.message });
        return false;
      }
      await sessionStore.save(result.session);
      dispatch({ type: 'signed-in', session: result.session });
      return true;
    } catch (error) {
      console.warn('[auth] Registration failed unexpectedly.', error);
      dispatch({
        type: 'submit-failed',
        message: 'Something went wrong while creating your account. Please try again.',
      });
      return false;
    }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await sessionStore.clear();
    } finally {
      dispatch({ type: 'signed-out' });
    }
  }, []);

  const dismissAuthError = useCallback(() => {
    dispatch({ type: 'error-dismissed' });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, signIn, signUp, signOut, dismissAuthError }),
    [state, signIn, signUp, signOut, dismissAuthError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an <AuthProvider>.');
  }
  return context;
}
