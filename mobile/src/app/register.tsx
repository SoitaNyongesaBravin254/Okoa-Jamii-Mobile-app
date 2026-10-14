import { Link, Redirect, router } from 'expo-router';
import { appConfig } from '@/config/app-config';
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NoticeBanner } from '@/components/notice-banner';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { AppButton } from '@/components/ui/app-button';
import { FormField } from '@/components/ui/form-field';
import { LoadingView } from '@/components/ui/state-views';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/store/auth-provider';
import {
  hasErrors,
  MIN_PASSWORD_LENGTH,
  validateRegisterForm,
  type RegisterFormErrors,
} from '@/utils/validation';

/**
 * Registration screen. On success the auth store signs the user in and the
 * app navigates into the authenticated area.
 */
export default function RegisterScreen() {
  const { status, isSubmitting, authError, signUp, dismissAuthError } = useAuth();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<RegisterFormErrors>({});
  const emailInputRef = useRef<TextInput>(null);
  const passwordInputRef = useRef<TextInput>(null);
  const confirmInputRef = useRef<TextInput>(null);

  if (status === 'loading') {
    return <LoadingView label="Checking your session…" />;
  }
  if (status === 'authenticated') {
    return <Redirect href="/home" />;
  }

  const clearFieldError = (field: keyof RegisterFormErrors) => {
    setErrors((previous) => ({ ...previous, [field]: undefined }));
  };

  const handleSubmit = () => {
    const nextErrors = validateRegisterForm({
      displayName,
      email,
      password,
      confirmPassword,
    });
    setErrors(nextErrors);

    if (hasErrors(nextErrors)) {
      if (nextErrors.password) passwordInputRef.current?.focus();
      else if (nextErrors.confirmPassword) confirmInputRef.current?.focus();
      else if (nextErrors.email) emailInputRef.current?.focus();
      return;
    }
    void submit();
  };

  const submit = async () => {
    dismissAuthError();
    const created = await signUp({
      displayName: displayName.trim(),
      email: email.trim(),
      password,
    });
    if (created) {
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
            Join {appConfig.displayName}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Create an account to start protecting your community.
          </ThemedText>

          {authError ? (
            <NoticeBanner tone="error" title="Registration failed" message={authError} />
          ) : null}

          <View style={styles.form}>
            <FormField
              label="Full name"
              value={displayName}
              onChangeText={(value) => {
                setDisplayName(value);
                clearFieldError('displayName');
              }}
              error={errors.displayName}
              placeholder="e.g. Amina Wanjiku"
              autoComplete="name"
              textContentType="name"
              returnKeyType="next"
              onSubmitEditing={() => emailInputRef.current?.focus()}
              editable={!isSubmitting}
            />

            <FormField
              ref={emailInputRef}
              label="Email"
              value={email}
              onChangeText={(value) => {
                setEmail(value);
                clearFieldError('email');
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
                clearFieldError('password');
              }}
              error={errors.password}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              returnKeyType="next"
              onSubmitEditing={() => confirmInputRef.current?.focus()}
              editable={!isSubmitting}
            />

            <FormField
              ref={confirmInputRef}
              label="Confirm password"
              value={confirmPassword}
              onChangeText={(value) => {
                setConfirmPassword(value);
                clearFieldError('confirmPassword');
              }}
              error={errors.confirmPassword}
              placeholder="Repeat your password"
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              returnKeyType="go"
              onSubmitEditing={handleSubmit}
              editable={!isSubmitting}
            />
          </View>

          <AppButton label="Create account" onPress={handleSubmit} loading={isSubmitting} />

          <ThemedText type="small" themeColor="textSecondary" style={styles.footerText}>
            Already have an account?{' '}
            <Link href="/login" replace>
              <ThemedText type="linkPrimary">Sign in</ThemedText>
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
  footerText: {
    textAlign: 'center',
  },
});
