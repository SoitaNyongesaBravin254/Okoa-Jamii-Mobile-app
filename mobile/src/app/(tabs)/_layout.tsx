import { Redirect } from 'expo-router';

import AppTabs from '@/components/app-tabs';
import { LoadingView } from '@/components/ui/state-views';
import { useAuth } from '@/store/auth-provider';

/**
 * Layout for the authenticated area of the app (Home and About tabs).
 * Signed-out visitors are redirected to the public welcome screen.
 */
export default function TabsLayout() {
  const { status } = useAuth();

  if (status === 'loading') {
    return <LoadingView label="Checking your session…" />;
  }
  if (status !== 'authenticated') {
    return <Redirect href="/" />;
  }

  return <AppTabs />;
}
