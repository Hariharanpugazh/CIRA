/** UI-side helpers for the PCO pipeline running in the service worker. */
import type { SaveContextResponse } from '@/background/context-pipeline';
import type { RuntimeMessage } from './messaging';
import type { Conversation } from './schema';

export type { SaveContextResponse };

export async function saveContext(conversation: Conversation): Promise<SaveContextResponse> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'CIRA/SAVE_CONTEXT', conversation } satisfies RuntimeMessage)) as
      | SaveContextResponse
      | undefined;
    return res ?? { ok: false, error: 'No response from the CIRA service worker' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
