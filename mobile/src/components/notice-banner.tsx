import { StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type NoticeTone = 'development' | 'warning' | 'error' | 'info';

type NoticeBannerProps = {
  tone?: NoticeTone;
  title: string;
  message: string;
};

/**
 * Inline banner used for development-mode notices, connectivity warnings and
 * error messages. Announced politely by screen readers.
 */
export function NoticeBanner({ tone = 'info', title, message }: NoticeBannerProps) {
  const theme = useTheme();
  const isAmber = tone === 'development' || tone === 'warning';
  const isError = tone === 'error';
  const accentColor = isError ? theme.danger : isAmber ? theme.warningText : theme.textSecondary;

  return (
    <ThemedView
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        styles.banner,
        {
          backgroundColor: isAmber ? theme.warningBackground : theme.backgroundElement,
          borderColor: isError ? theme.danger : isAmber ? theme.warningText : theme.border,
        },
      ]}>
      <ThemedText type="smallBold" style={{ color: accentColor }}>
        {title}
      </ThemedText>
      <ThemedText type="small" style={{ color: isError || isAmber ? accentColor : theme.textSecondary }}>
        {message}
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderWidth: 1,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.half,
    alignSelf: 'stretch',
  },
});
