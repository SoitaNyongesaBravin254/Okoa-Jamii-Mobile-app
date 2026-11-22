/**
 * App wiring for pending-alert synchronisation.
 *
 * Holds the single alert-sync service instance so the in-flight guard is
 * shared by every trigger (post-SOS save, connectivity regained, app
 * foreground). Screens and hooks call `runAlertSync()`; they never touch
 * network code or the SQLite queue directly.
 *
 * Errors are reduced to a typed result — this function never rejects, so a
 * failed sync can never break SOS activation or startup.
 */

import { appConfig } from '@/config/app-config';
import { getAlertRepository } from '@/services/alerts';
import { sessionStore } from '@/services/auth/session-storage';
import { getConnectivityStatus } from '@/services/network/connectivity';
import {
  createAlertSyncService,
  type AlertSyncResult,
  type AlertSyncService,
} from './alert-sync';

let servicePromise: Promise<AlertSyncService> | null = null;

function getAlertSyncService(): Promise<AlertSyncService> {
  if (!servicePromise) {
    servicePromise = getAlertRepository()
      .then((repository) =>
        createAlertSyncService({
          baseUrl: appConfig.api.baseUrl,
          getConnectivity: getConnectivityStatus,
          getSession: () => sessionStore.load(),
          listPendingAlerts: () => repository.listPendingAlerts(),
          markAlertSent: async (id, serverReceipt) => {
            await repository.updateStatus(id, 'sent', { serverReceipt });
          },
        }),
      )
      .catch((error: unknown) => {
        // Do not poison later attempts: a failed database open can be retried.
        servicePromise = null;
        throw error;
      });
  }
  return servicePromise;
}

/** Runs one sync pass. Safe to call from any trigger; never rejects. */
export async function runAlertSync(): Promise<AlertSyncResult> {
  try {
    const service = await getAlertSyncService();
    return await service.sync();
  } catch {
    return {
      outcome: 'stopped',
      submitted: 0,
      pendingRemaining: 0,
      error: {
        code: 'storage',
        message: 'Pending alerts could not be read on this device.',
      },
    };
  }
}
