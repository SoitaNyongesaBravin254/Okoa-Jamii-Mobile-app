import { ActivityIndicator, Pressable, StyleSheet, type PressableProps } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type AppButtonProps = Omit<PressableProps, 'children'> & {
  label: string;
  variant?: 'primary' | 'secondary';
  /** Shows a spinner and blocks presses while an action is in flight. */
  loading?: boolean;
};

/**
 * Accessible themed button used for all primary actions.
 * Exposes its disabled/busy state to screen readers and renders a loading
 * state without changing size, so forms stay stable while submitting.
 */
export function AppButton({
  label,
  variant = 'primary',
  loading = false,
  disabled,
  accessibilityLabel,
  style,
  ...rest
}: AppButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled === true || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary'
          ? { backgroundColor: theme.primary }
          : { backgroundColor: theme.backgroundElement, borderColor: theme.border, borderWidth: 1 },
        pressed && styles.pressed,
        isDisabled && styles.disabled,
        typeof style === 'function' ? undefined : style,
      ]}
      {...rest}>
      {loading ? (
        <ActivityIndicator size="small" color={variant === 'primary' ? '#FFFFFF' : theme.text} />
      ) : null}
      <ThemedText type="smallBold" style={variant === 'primary' ? styles.primaryLabel : undefined}>
        {loading ? 'Please wait…' : label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  primaryLabel: {
    color: '#FFFFFF',
  },
  pressed: {
    opacity: 0.8,
  },
  disabled: {
    opacity: 0.5,
  },
});
