/**
 * Sync a PCO to `~/.cira/contexts` through the local CIRA host
 * (`cira native-host`), using Chrome native messaging.
 *
 * Native messaging only reaches hosts the user installed and allow-listed
 * for this extension ID (`cira native-host install --extension-id …`); it
 * opens no network port. When the host is not installed, capture still
 * succeeds and the PCO stays in chrome.storage.
 */
import { LOCAL_HOST_NAME, type HostResponse, type PCODocument } from '@cira/core';
import type { SyncResult } from './context-pipeline';

const NOT_INSTALLED = /not found|not exist|forbidden|Access to the specified native messaging host/i;

export async function syncToLocalHost(document: PCODocument): Promise<SyncResult> {
  if (!chrome.runtime.sendNativeMessage) {
    return { status: 'host_unavailable', message: 'nativeMessaging permission is not available' };
  }
  try {
    const res = (await chrome.runtime.sendNativeMessage(LOCAL_HOST_NAME, { type: 'save', document })) as HostResponse | undefined;
    if (res && res.ok && res.type === 'saved') return { status: 'synced', path: res.path };
    if (res && !res.ok) return { status: 'error', message: res.error };
    return { status: 'error', message: 'unexpected response from local host' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (NOT_INSTALLED.test(message)) return { status: 'host_unavailable', message };
    return { status: 'error', message };
  }
}
