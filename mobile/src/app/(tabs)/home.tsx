import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NoticeBanner } from '@/components/notice-banner';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { AppButton } from '@/components/ui/app-button';
import { EmptyStateView } from '@/components/ui/state-views';
import { appConfig } from '@/config/app-config';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useConnectivityStatus } from '@/services/network/connectivity';
import { useAuth } from '@/store/auth-provider';

/**
 * Home tab (authenticated). Phase 1 shows the signed-in user their session
 * status, connectivity awareness and an honest empty state for emergency
 * alerts — reporting arrives in a later phase.
 */
export default function HomeScreen() {
  const { user, provider, signOut } = useAuth();
  const connectivity = useConnectivityStatus();

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.content}>
          <ThemedText accessibilityRole="header" type="subtitle" style={styles.greeting}>
            {user ? `Karibu, ${user.displayName}` : 'Karibu'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {appConfig.tagline}
          </ThemedText>

          {connectivity === 'offline' ? (
            <NoticeBanner
              tone="warning"
              title="You are offline"
              message="Okoa Jamii is designed offline-first: your data stays on this device and is built to sync once a backend and a connection are available."
            />
          ) : null}

          <ThemedView type="backgroundElement" style={styles.card}>
            <ThemedText type="smallBold">Your session</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {user ? `Signed in as ${user.email}` : 'No user'}
            </ThemedText>
            {provider === 'development-stub' ? (
              <NoticeBanner
                tone="development"
                title="Simulated sign-in"
                message="This session comes from the on-device development stub, not a real account."
              />
            ) : null}
          </ThemedView>

          <ThemedView type="backgroundElement" style={styles.card}>
            <ThemedText type="smallBold">Emergency alerts</ThemedText>
            <EmptyStateView
              title="Save an emergency alert"
              description="The SOS flow attaches your real device location (if you allow it) and stores the alert privately on this device. Alerts are not yet delivered to a response team."
            />
            <AppButton
              label="Open SOS"
              onPress={() => router.push('/sos')}
              accessibilityLabel="Open the SOS screen to save an emergency alert on this device"
            />
            <AppButton
              label="Local alert history"
              variant="secondary"
              onPress={() => router.push('/alert-history')}
            />
          </ThemedView>

          <AppButton label="Sign out" variant="secondary" onPress={() => void signOut()} />
        </View>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    width: '100%',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
    gap: Spacing.three,
  },
  greeting: {
    fontSize: 28,
    lineHeight: 34,
  },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
});
