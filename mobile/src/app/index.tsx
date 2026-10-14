import { Redirect, router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NoticeBanner } from '@/components/notice-banner';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { AppButton } from '@/components/ui/app-button';
import { LoadingView } from '@/components/ui/state-views';
import { appConfig } from '@/config/app-config';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/store/auth-provider';

/**
 * Public welcome screen and app entry point.
 * Signed-in users are redirected into the authenticated tab area.
 */
export default function WelcomeScreen() {
  const { status } = useAuth();

  if (status === 'loading') {
    return <LoadingView label={`Starting ${appConfig.displayName}…`} />;
  }
  if (status === 'authenticated') {
    return <Redirect href="/home" />;
  }

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.hero}>
          <ThemedText accessibilityRole="header" type="title" style={styles.title}>
            {appConfig.displayName}
          </ThemedText>
          <ThemedText type="subtitle" themeColor="textSecondary" style={styles.tagline}>
            {appConfig.tagline}
          </ThemedText>
        </View>

        <ThemedText style={styles.description}>
          Report emergencies and help protect your community. Okoa Jamii is being rebuilt phase by
          phase — this release restores the application foundation only, with sign-in simulated on
          this device until the backend arrives.
        </ThemedText>

        <View style={styles.actions}>
          <AppButton label="Sign in" onPress={() => router.push('/login')} />
          <AppButton
            label="Create an account"
            variant="secondary"
            onPress={() => router.push('/register')}
          />
        </View>

        <NoticeBanner
          tone="development"
          title="Development mode"
          message="Sign-in is simulated on this device. No email or password is sent anywhere — there is no backend yet."
        />

        <ThemedText type="small" themeColor="textSecondary" style={styles.version}>
          Version {appConfig.version} · {appConfig.environment}
        </ThemedText>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    flexDirection: 'row',
  },
  safeArea: {
    flex: 1,
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    gap: Spacing.four,
  },
  hero: {
    gap: Spacing.two,
  },
  title: {
    textAlign: 'left',
  },
  tagline: {
    fontSize: 20,
    lineHeight: 28,
  },
  description: {
    gap: Spacing.two,
  },
  actions: {
    gap: Spacing.three,
    alignSelf: 'stretch',
  },
  version: {
    textAlign: 'center',
  },
});
