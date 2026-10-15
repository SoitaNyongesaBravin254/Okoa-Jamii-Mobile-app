/**
 * Local alert history screen (authenticated stack route).
 *
 * Reads directly from the existing SQLite alert repository. Rows show
 * category, creation time, delivery status and whether a location was
 * attached — never precise coordinates. Status labels clearly separate
 * "saved on this device" from server-confirmed delivery. The list refreshes
 * every time the screen regains focus (e.g. after returning from SOS).
 */

import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AuthenticatedStackGuard } from '@/components/auth-stack-guard';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { AppButton } from '@/components/ui/app-button';
import { EmptyStateView, LoadingView } from '@/components/ui/state-views';
import { NoticeBanner } from '@/components/notice-banner';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { getAlertRepository } from '@/services/alerts';
import {
  presentAlertHistoryItem,
  type AlertHistoryItem,
} from '@/services/alerts/alert-presenter';

type HistoryPhase = 'loading' | 'ready' | 'error';

export default function AlertHistoryScreen() {
  return (
    <AuthenticatedStackGuard>
      <AlertHistoryContent />
    </AuthenticatedStackGuard>
  );
}

function AlertHistoryContent() {
  const theme = useTheme();
  const [phase, setPhase] = useState<HistoryPhase>('loading');
  const [items, setItems] = useState<AlertHistoryItem[]>([]);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const repository = await getAlertRepository();
      // listAlerts() returns records newest-first; presentation drops coordinates.
      const alerts = await repository.listAlerts();
      setItems(alerts.map(presentAlertHistoryItem));
      setPhase('ready');
    } catch {
      // No alert content in state on error — a failed read is never shown as success.
      setItems([]);
      setPhase('error');
    }
  }, []);

  // Reload whenever the screen (re)gains focus, e.g. after SOS capture.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.content}>
          <ThemedText accessibilityRole="header" type="subtitle" style={styles.title}>
            Local alert history
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Alerts stored on this device. &quot;Saved on this device&quot; means the alert has NOT
            been delivered to anyone yet.
          </ThemedText>

          {phase === 'loading' ? <LoadingView label="Loading alerts…" /> : null}

          {phase === 'error' ? (
            <>
              <NoticeBanner
                tone="error"
                title="Could not read local alerts"
                message="The local alert database could not be read. Nothing was changed. Please try again."
              />
              <AppButton label="Retry" onPress={() => void load()} />
            </>
          ) : null}

          {phase === 'ready' && items.length === 0 ? (
            <EmptyStateView
              title="No alerts yet"
              description="Emergency alerts you save from the SOS screen will appear here."
            />
          ) : null}

          {phase === 'ready' && items.length > 0 ? (
            <ScrollView contentContainerStyle={styles.list} accessibilityRole="list">
              {items.map((item) => (
                <ThemedView key={item.id} type="backgroundElement" style={styles.row}>
                  <View style={styles.rowHeader}>
                    <ThemedText type="smallBold">{item.categoryLabel}</ThemedText>
                    <ThemedText
                      type="small"
                      accessibilityLabel={`Status: ${item.status.label}`}
                      style={{
                        color:
                          item.status.tone === 'success'
                            ? theme.primary
                            : item.status.tone === 'warning'
                              ? theme.warningText
                              : theme.textSecondary,
                      }}>
                      {item.status.label}
                    </ThemedText>
                  </View>
                  <ThemedText type="small" themeColor="textSecondary">
                    {item.createdLabel}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {item.locationLabel}
                  </ThemedText>
                  {item.retryCount > 0 ? (
                    <ThemedText type="small" themeColor="textSecondary">
                      Retry attempts recorded: {item.retryCount}
                    </ThemedText>
                  ) : null}
                </ThemedView>
              ))}
            </ScrollView>
          ) : null}

          <AppButton
            label="Refresh"
            variant="secondary"
            loading={phase === 'loading'}
            onPress={() => void load()}
            accessibilityLabel="Refresh local alert history"
          />
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
  title: {
    fontSize: 28,
    lineHeight: 34,
  },
  list: {
    gap: Spacing.two,
  },
  row: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.two,
    flexWrap: 'wrap',
  },
});
