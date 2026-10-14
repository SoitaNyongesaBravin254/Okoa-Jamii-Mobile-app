import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NoticeBanner } from '@/components/notice-banner';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Collapsible } from '@/components/ui/collapsible';
import { appConfig } from '@/config/app-config';
import { MaxContentWidth, Spacing } from '@/constants/theme';

/**
 * About tab: what Okoa Jamii is, what this Phase 1 release actually contains,
 * and what is planned for later phases. Everything here reflects real status —
 * nothing is presented as working before it is.
 */
export default function AboutScreen() {
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content}>
          <ThemedText accessibilityRole="header" type="subtitle">
            About {appConfig.displayName}
          </ThemedText>
          <ThemedText>
            {appConfig.displayName} is a community protection platform: a place for people to report
            emergencies — including security threats — and coordinate help, even when connectivity
            is unreliable.
          </ThemedText>

          <NoticeBanner
            tone="development"
            title="Phase 1 — mobile foundation"
            message="This release restores the app foundation only. Sign-in is simulated on-device and no data leaves your phone."
          />

          <Collapsible title="What works in this release">
            <ThemedText type="small">
              {'•'} Clean, typed Expo Router app structure{'\n'}
              {'•'} Light/dark theme with shared UI components{'\n'}
              {'•'} Welcome, sign-in and registration screens with validation{'\n'}
              {'•'} On-device development sign-in (clearly labelled, no backend){'\n'}
              {'•'} Session tokens stored securely with the platform keystore{'\n'}
              {'•'} Offline/online awareness on the home screen
            </ThemedText>
          </Collapsible>

          <Collapsible title="Planned for later phases">
            <ThemedText type="small">
              {'•'} Emergency (SOS) reporting with real device location and permission handling{'\n'}
              {'•'} Offline storage of unsent alerts and safe synchronisation{'\n'}
              {'•'} Real authentication backend and API{'\n'}
              {'•'} Dashboard integration for responders
            </ThemedText>
          </Collapsible>

          <ThemedText type="small" themeColor="textSecondary" style={styles.version}>
            Version {appConfig.version} ({appConfig.environment})
          </ThemedText>
        </ScrollView>
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
    gap: Spacing.four,
  },
  version: {
    textAlign: 'center',
    marginTop: Spacing.three,
  },
});
