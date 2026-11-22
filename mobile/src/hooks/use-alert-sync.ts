/**
 * Single app-wide trigger for pending-alert synchronisation.
 *
 * Mounted once by the root layout so there is exactly one connectivity
 * subscription and one AppState listener. It runs a sync pass when:
 *  - connectivity becomes `online`, and
 *  - the app returns to the foreground.
 *
 * The service itself refuses concurrent runs, so overlapping triggers (for
 * example foreground + connectivity in the same moment) cannot double-submit.
 * SOS activation additionally calls `runAlertSync()` after a successful local
 * save, which covers the "already online, queue just changed" case.
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';

import { runAlertSync } from '@/services/alerts/alert-sync-runner';
import { useConnectivityStatus } from '@/services/network/connectivity';

export function useAlertSync(): void {
  const connectivity = useConnectivityStatus();

  useEffect(() => {
    if (connectivity !== 'online') return;
    void runAlertSync();
  }, [connectivity]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void runAlertSync();
      }
    });
    return () => subscription.remove();
  }, []);
}
