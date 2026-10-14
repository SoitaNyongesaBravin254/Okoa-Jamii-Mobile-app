/**
 * Network connectivity abstraction.
 *
 * Screens should never import `expo-network` directly — go through this module
 * so the app has a single, typed notion of connectivity that later phases
 * (offline queueing, alert synchronisation) can build on.
 */

import * as Network from 'expo-network';

export type ConnectivityStatus = 'online' | 'offline' | 'unknown';

/** Maps an expo-network state to our simplified status. */
export function toConnectivityStatus(state: Network.NetworkState | null | undefined): ConnectivityStatus {
  if (!state || state.isConnected === null || state.isConnected === undefined) {
    return 'unknown';
  }
  if (state.isConnected === false) {
    return 'offline';
  }
  if (state.isInternetReachable === false) {
    return 'offline';
  }
  return 'online';
}

/** One-shot connectivity check (useful before network-bound work). */
export async function getConnectivityStatus(): Promise<ConnectivityStatus> {
  return toConnectivityStatus(await Network.getNetworkStateAsync());
}

/**
 * Reactive connectivity status for UI. Re-renders when the device's
 * connectivity changes (for example when the user toggles airplane mode).
 */
export function useConnectivityStatus(): ConnectivityStatus {
  return toConnectivityStatus(Network.useNetworkState());
}
