import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { useAlertSync } from '@/hooks/use-alert-sync';
import { AuthProvider } from '@/store/auth-provider';

SplashScreen.preventAutoHideAsync();

/**
 * Root layout: theming + the auth store wrap a stack containing the public
 * welcome/auth screens (`index`, `login`, `register`) and the authenticated
 * tab area (`(tabs)`). The `(tabs)` layout redirects signed-out users.
 */
export default function RootLayout() {
  const colorScheme = useColorScheme();

  // One app-wide sync trigger: connectivity regained and foreground return.
  useAlertSync();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AuthProvider>
        <AnimatedSplashOverlay />
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ title: 'Sign in' }} />
          <Stack.Screen name="register" options={{ title: 'Create account' }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="sos" options={{ title: 'Emergency SOS' }} />
          <Stack.Screen name="alert-history" options={{ title: 'Alert history' }} />
        </Stack>
      </AuthProvider>
    </ThemeProvider>
  );
}
