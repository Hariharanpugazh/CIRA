/** UI-side helpers for the PCO pipeline running in the service worker. */
import type { SaveContextResponse, SyncResult } from '@/background/context-pipeline';
import type { ContextSelection } from './context-selection';
import type { RuntimeMessage } from './messaging';
import type { Conversation } from './schema';

export type { SaveContextResponse, SyncResult };

export async function saveContext(conversation: Conversation, selection?: ContextSelection): Promise<SaveContextResponse> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'CIRA/SAVE_CONTEXT', conversation, ...(selection ? { selection } : {}) } satisfies RuntimeMessage)) as
      | SaveContextResponse
      | undefined;
    return res ?? { ok: false, error: 'No response from the CIRA service worker' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Retry the local (~/.cira/contexts) sync of a stored context. */
export async function retrySync(id: string): Promise<SyncResult> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'CIRA/SYNC_CONTEXT', id } satisfies RuntimeMessage)) as SyncResult | undefined;
    return res ?? { status: 'error', message: 'No response from the CIRA service worker' };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** One-line status for the popup / side panel. */
export function describeSaveResult(r: SaveContextResponse): { text: string; level: 'info' | 'warn' | 'error' } {
  if (!r.ok) return { text: `PCO not saved: ${r.error}`, level: 'error' };
  const items = `${r.summary.item_count} context item${r.summary.item_count === 1 ? '' : 's'}`;
  let where: string;
  switch (r.sync.status) {
    case 'synced':
      where = `saved to ${r.sync.path}`;
      break;
    case 'host_unavailable':
      where = 'saved in browser (local sync not set up: run `cira native-host install`)';
      break;
    case 'error':
      where = `saved in browser; local sync failed: ${r.sync.message}`;
      break;
    default:
      where = 'saved in browser';
  }
  const text = `PCO ${where} · ${items}`;
  if (r.safety.hasFindings) {
    return { text: `${text} · WARNING: ${r.safety.findingCount} potential secret(s) included — review before sharing`, level: 'warn' };
  }
  return { text, level: r.sync.status === 'error' ? 'warn' : 'info' };
}

/** Friendly wording of where a context ended up (side panel status). */
export function describeSync(sync: SyncResult): { label: string; ok: boolean; detail?: string; retry: boolean } {
  switch (sync.status) {
    case 'synced':
      return { label: 'Saved locally', ok: true, detail: sync.path, retry: false };
    case 'host_unavailable':
      return { label: 'Saved in browser · local sync not set up', ok: false, detail: 'Run `cira native-host install` to save to ~/.cira/contexts.', retry: true };
    case 'error':
      return { label: 'Saved in browser · local sync unavailable', ok: false, detail: sync.message, retry: true };
    default:
      return { label: 'Saved in browser', ok: true, retry: false };
  }
}
