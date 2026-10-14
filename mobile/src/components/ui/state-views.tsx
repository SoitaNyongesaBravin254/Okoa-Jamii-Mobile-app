import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Full-screen loading state (e.g. while the stored session is being restored). */
export function LoadingView({ label = 'Loading…' }: { label?: string }) {
  const theme = useTheme();

  return (
    <ThemedView
      style={styles.centered}
      accessibilityRole="progressbar"
      accessibilityLabel={label}>
      <ActivityIndicator size="large" color={theme.primary} />
      <ThemedText type="small" themeColor="textSecondary" style={styles.loadingLabel}>
        {label}
      </ThemedText>
    </ThemedView>
  );
}

/** Inline empty state for sections that have nothing to show yet. */
export function EmptyStateView({ title, description }: { title: string; description: string }) {
  return (
    <View style={styles.emptyState} accessibilityRole="summary">
      <ThemedText type="smallBold">{title}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {description}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  loadingLabel: {
    textAlign: 'center',
  },
  emptyState: {
    gap: Spacing.one,
    alignItems: 'flex-start',
  },
});
