import { Link, Redirect, router } from 'expo-router';
import { appConfig } from '@/config/app-config';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NoticeBanner } from '@/components/notice-banner';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { AppButton } from '@/components/ui/app-button';
import { FormField } from '@/components/ui/form-field';
import { LoadingView } from '@/components/ui/state-views';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/store/auth-provider';
import { hasErrors, validateLoginForm, type LoginFormErrors } from '@/utils/validation';

/**
 * Sign-in screen. Uses the auth store, which currently wraps a clearly
 * labelled development stub — no backend requests are made.
 */
export default function LoginScreen() {
  const { status, isSubmitting, authError, signIn, dismissAuthError } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<LoginFormErrors>({});
  const passwordInputRef = useRef<TextInput>(null);

  if (status === 'loading') {
    return <LoadingView label="Checking your session…" />;
  }
  if (status === 'authenticated') {
    return <Redirect href="/home" />;
  }

  const handleSubmit = () => {
    const nextErrors = validateLoginForm({ email, password });
    setErrors(nextErrors);

    if (hasErrors(nextErrors)) {
      if (nextErrors.password) {
        passwordInputRef.current?.focus();
      }
      return;
    }
    void submit();
  };

  const submit = async () => {
    dismissAuthError();
    const signedIn = await signIn({ email: email.trim(), password });
    if (signedIn) {
      router.replace('/home');
    }
  };

  return (
    <ThemedView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView style={styles.safeArea}>
          <ThemedText accessibilityRole="header" type="subtitle" style={styles.title}>
            Welcome back
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Sign in to continue to {appConfig.displayName}.
          </ThemedText>

          {authError ? (
            <NoticeBanner tone="error" title="Sign-in failed" message={authError} />
          ) : null}

          <View style={styles.form}>
            <FormField
              label="Email"
              value={email}
              onChangeText={(value) => {
                setEmail(value);
                if (errors.email) setErrors((previous) => ({ ...previous, email: undefined }));
              }}
              error={errors.email}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              onSubmitEditing={() => passwordInputRef.current?.focus()}
              editable={!isSubmitting}
            />

            <FormField
              ref={passwordInputRef}
              label="Password"
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                if (errors.password)
                  setErrors((previous) => ({ ...previous, password: undefined }));
              }}
              error={errors.password}
              placeholder="Your password"
              secureTextEntry={!showPassword}
              autoComplete="password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={handleSubmit}
              editable={!isSubmitting}
            />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
              onPress={() => setShowPassword((value) => !value)}
              style={styles.showPassword}>
              <ThemedText type="small" themeColor="textSecondary">
                {showPassword ? 'Hide password' : 'Show password'}
              </ThemedText>
            </Pressable>
          </View>

          <AppButton label="Sign in" onPress={handleSubmit} loading={isSubmitting} />

          <ThemedText type="small" themeColor="textSecondary" style={styles.footerText}>
            New to {appConfig.displayName}?{' '}
            <Link href="/register" replace>
              <ThemedText type="linkPrimary">Create an account</ThemedText>
            </Link>
          </ThemedText>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
    justifyContent: 'center',
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
  },
  form: {
    gap: Spacing.three,
    alignSelf: 'stretch',
  },
  showPassword: {
    alignSelf: 'flex-start',
    paddingVertical: Spacing.one,
  },
  footerText: {
    textAlign: 'center',
  },
});
