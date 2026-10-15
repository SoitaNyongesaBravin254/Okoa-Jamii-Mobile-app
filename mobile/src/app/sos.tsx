/**
 * SOS capture screen (authenticated stack route).
 *
 * Flow: pick an emergency category → confirm → capture a real device
 * location (foreground permission is requested here, only now) → persist
 * through the existing SQLite alert repository → show an honest result.
 *
 * Honesty rules:
 * - The confirmation and result copy state that the alert is saved on THIS
 *   DEVICE; nothing implies a response team received it.
 * - A saved result is only shown after the SQLite write succeeded.
 * - The submit button is disabled while a submission is in flight, and the
 *   orchestration layer rejects concurrent submissions, so double taps
 *   cannot create duplicate alerts.
 * - No coordinates or alert payloads are logged anywhere in this flow.
 */

import { router } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AuthenticatedStackGuard } from '@/components/auth-stack-guard';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { AppButton } from '@/components/ui/app-button';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { captureDeviceLocation } from '@/services/location/device-location';
import { getAlertRepository } from '@/services/alerts';
import { ALERT_CATEGORY_LABELS } from '@/services/alerts/alert-presenter';
import {
  createSosSubmission,
  type SosSubmission,
  type SosSubmissionResult,
} from '@/services/alerts/sos-submission';
import { ALERT_CATEGORIES } from '@/services/alerts/alert-model';
import { useAuth } from '@/store/auth-provider';
import type { AlertCategory } from '@/types/alert';

type Phase = 'compose' | 'confirming' | 'submitting' | 'result';

export default function SosScreen() {
  return (
    <AuthenticatedStackGuard>
      <SosFlow />
    </AuthenticatedStackGuard>
  );
}

function SosFlow() {
  const theme = useTheme();
  const { user } = useAuth();

  const [category, setCategory] = useState<AlertCategory>('other');
  const [phase, setPhase] = useState<Phase>('compose');
  const [result, setResult] = useState<SosSubmissionResult | null>(null);

  // One submission controller per screen; holds the orchestration-layer
  // in-flight guard. Cached as a promise so two quick taps share one
  // controller instead of building two (each with its own guard).
  const submissionRef = useRef<Promise<SosSubmission> | null>(null);
  const ensureSubmission = useCallback(() => {
    if (!submissionRef.current) {
      submissionRef.current = getAlertRepository().then((repository) =>
        createSosSubmission(repository, () => captureDeviceLocation()),
      );
    }
    return submissionRef.current;
  }, []);

  // Synchronous double-tap guard: React state updates are async, so `isBusy`
  // may not have re-rendered yet when a second tap lands.
  const inFlightRef = useRef(false);

  const onConfirm = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase('submitting');
    try {
      const submission = await ensureSubmission();
      const outcome = await submission.submit(category);
      setResult(outcome);
      setPhase('result');
    } catch {
      // The repository itself could not be opened (e.g. database failure).
      // Drop the cached controller so "Try again" re-attempts a fresh open.
      submissionRef.current = null;
      setResult({
        outcome: 'failed',
        message: 'Your alert could NOT be saved on this device. Please try again.',
        reason: null,
      });
      setPhase('result');
    } finally {
      inFlightRef.current = false;
    }
  }, [category, ensureSubmission]);

  const onReset = useCallback(() => {
    setResult(null);
    setPhase('compose');
  }, []);

  const isBusy = phase === 'submitting';
  const statusMessage = useMemo(() => {
    if (result?.outcome === 'saved' && result.notice) return result.notice;
    if (result?.outcome === 'failed') return result.message;
    return null;
  }, [result]);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled">
          <ThemedText accessibilityRole="header" type="subtitle" style={styles.title}>
            Emergency SOS
          </ThemedText>

          {phase === 'compose' || phase === 'confirming' ? (
            <>
              <ThemedText type="small" themeColor="textSecondary">
                {user
                  ? `Karibu ${user.displayName}. This saves an emergency alert on THIS DEVICE. In this release alerts are not sent to a response team — they stay here until secure delivery is available.`
                  : 'This saves an emergency alert on THIS DEVICE. In this release alerts are not sent to a response team — they stay here until secure delivery is available.'}
              </ThemedText>

              <ThemedText type="smallBold" style={styles.sectionLabel}>
                What kind of emergency?
              </ThemedText>
              <View style={styles.categoryGrid} accessibilityRole="radiogroup">
                {ALERT_CATEGORIES.map((value) => {
                  const selected = value === category;
                  return (
                    <Pressable
                      key={value}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`${ALERT_CATEGORY_LABELS[value]} emergency`}
                      disabled={isBusy}
                      onPress={() => setCategory(value)}
                      style={({ pressed }) => [
                        styles.categoryChip,
                        {
                          backgroundColor: selected ? theme.primary : theme.backgroundElement,
                          borderColor: selected ? theme.primary : theme.border,
                        },
                        pressed && styles.pressed,
                      ]}>
                      <ThemedText
                        type="small"
                        style={{ color: selected ? '#FFFFFF' : theme.text }}>
                        {ALERT_CATEGORY_LABELS[value]}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </View>

              {phase === 'confirming' ? (
                <ThemedView type="backgroundElement" style={styles.confirmCard}>
                  <ThemedText type="smallBold">Confirm: save a {ALERT_CATEGORY_LABELS[category].toLowerCase()} alert?</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    Next, Okoa Jamii will ask for your location so it can be attached to the alert.
                    The alert is stored on this device only — it is NOT delivered to anyone yet.
                  </ThemedText>
                  <AppButton
                    label="Yes, save alert on this device"
                    loading={isBusy}
                    onPress={() => void onConfirm()}
                  />
                  <AppButton
                    label="Cancel"
                    variant="secondary"
                    disabled={isBusy}
                    onPress={() => setPhase('compose')}
                  />
                </ThemedView>
              ) : (
                <AppButton
                  label="Start SOS"
                  loading={isBusy}
                  onPress={() => setPhase('confirming')}
                  accessibilityLabel="Start SOS. Asks for confirmation before saving an emergency alert on this device."
                />
              )}
            </>
          ) : null}

          {isBusy ? (
            <ThemedText
              type="small"
              themeColor="textSecondary"
              accessibilityLiveRegion="polite"
              style={styles.busyText}>
              Getting your location and saving the alert on this device…
            </ThemedText>
          ) : null}

          {phase === 'result' && result ? (
            <ThemedView type="backgroundElement" style={styles.resultCard}>
              {result.outcome === 'saved' ? (
                <>
                  <ThemedText accessibilityRole="header" type="smallBold" style={styles.resultTitle}>
                    ✅ Alert saved on this device
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    Your {ALERT_CATEGORY_LABELS[category].toLowerCase()} alert was stored in the
                    local database. Nothing has been sent to a response team — delivery is not
                    available in this release.
                  </ThemedText>
                </>
              ) : result.outcome === 'duplicate-ignored' ? (
                <ThemedText type="smallBold" accessibilityLiveRegion="polite">
                  This alert is already being saved — no duplicate was created.
                </ThemedText>
              ) : (
                <>
                  <ThemedText accessibilityRole="header" type="smallBold" style={styles.errorTitle}>
                    ⚠️ Alert not saved
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {result.message}
                  </ThemedText>
                </>
              )}

              {statusMessage ? (
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  accessibilityLiveRegion="polite"
                  style={styles.noticeText}>
                  {statusMessage}
                </ThemedText>
              ) : null}

              <AppButton
                label="View local alert history"
                variant="secondary"
                onPress={() => router.push('/alert-history')}
              />
              <AppButton
                label={result.outcome === 'saved' ? 'Done' : 'Try again'}
                variant={result.outcome === 'saved' ? 'secondary' : 'primary'}
                onPress={onReset}
              />
            </ThemedView>
          ) : null}
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
    gap: Spacing.three,
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
  },
  sectionLabel: {
    marginTop: Spacing.two,
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  categoryChip: {
    minHeight: 44,
    borderRadius: Spacing.three,
    borderWidth: 1,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.8,
  },
  confirmCard: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
    borderColor: '#C62828',
    borderWidth: 1,
  },
  busyText: {
    textAlign: 'center',
  },
  resultCard: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  resultTitle: {
    fontSize: 18,
    lineHeight: 24,
  },
  errorTitle: {
    fontSize: 18,
    lineHeight: 24,
  },
  noticeText: {
    marginTop: Spacing.one,
  },
});
