/**
 * Route guard for authenticated stack screens outside the `(tabs)` group
 * (e.g. SOS and alert history). Mirrors the tabs layout behaviour: while the
 * stored session is hydrating we show a loading state, and signed-out
 * visitors are redirected to the public welcome screen.
 */

import { Redirect } from 'expo-router';
import type { PropsWithChildren } from 'react';

import { LoadingView } from '@/components/ui/state-views';
import { useAuth } from '@/store/auth-provider';

export function AuthenticatedStackGuard({ children }: PropsWithChildren) {
  const { status } = useAuth();

  if (status === 'loading') {
    return <LoadingView label="Checking your session…" />;
  }
  if (status !== 'authenticated') {
    return <Redirect href="/" />;
  }

  return <>{children}</>;
}
