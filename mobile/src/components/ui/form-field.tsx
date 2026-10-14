import { useState, type Ref } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type FormFieldProps = TextInputProps & {
  label: string;
  /** When set, the field shows an accessible inline error message. */
  error?: string;
  containerStyle?: StyleProp<ViewStyle>;
  /** Forwarded to the underlying TextInput (e.g. to focus the next field). */
  ref?: Ref<TextInput>;
};

/**
 * Labelled text input with focus highlight and accessible inline errors.
 * Errors are announced by screen readers via a polite live region.
 */
export function FormField({ label, error, containerStyle, ref, ...inputProps }: FormFieldProps) {
  const theme = useTheme();
  const [isFocused, setIsFocused] = useState(false);

  const handleFocus: NonNullable<TextInputProps['onFocus']> = (event) => {
    setIsFocused(true);
    inputProps.onFocus?.(event);
  };
  const handleBlur: NonNullable<TextInputProps['onBlur']> = (event) => {
    setIsFocused(false);
    inputProps.onBlur?.(event);
  };

  return (
    <View style={[styles.field, containerStyle]}>
      <ThemedText type="smallBold" themeColor="textSecondary">
        {label}
      </ThemedText>
      <TextInput
        {...inputProps}
        ref={ref}
        accessibilityLabel={label}
        placeholderTextColor={theme.textSecondary}
        onFocus={handleFocus}
        onBlur={handleBlur}
        style={[
          styles.input,
          {
            color: theme.text,
            backgroundColor: theme.backgroundElement,
            borderColor: error ? theme.danger : isFocused ? theme.primary : theme.border,
          },
        ]}
      />
      {error ? (
        <ThemedText
          accessibilityLiveRegion="polite"
          themeColor="danger"
          type="small"
          style={styles.error}>
          {error}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: Spacing.one,
    alignSelf: 'stretch',
  },
  input: {
    minHeight: 48,
    borderRadius: Spacing.two,
    borderWidth: 1,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  error: {
    marginTop: Spacing.half,
  },
});
