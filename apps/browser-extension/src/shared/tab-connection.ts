/**
 * Extension UI ↔ content-script connection for one tab.
 *
 * `connectToTab()` is the single handshake used by the side panel and popup:
 *   CIRA/PING → (inject content script once if nobody answers) → CIRA/PING.
 * The UI reports "active" only when the content script actually answered.
 *
 * Chrome APIs are injected so the logic is unit-testable.
 */
import type { RuntimeMessage } from './messaging';
import type { Conversation } from './schema';

export interface TabApi {
  sendMessage(tabId: number, message: RuntimeMessage): Promise<unknown>;
  /** Inject the manifest's content script into the tab. */
  injectContentScript(tabId: number): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type ConnectionResult =
  | { status: 'connected'; source: string; injected: boolean }
  | { status: 'not_connected'; reason: string };

export type ExtractionResult =
  | { ok: true; conversation: Conversation }
  | { ok: false; reason: 'not_connected' | 'extract_failed' | 'empty'; message: string };

export const NOT_CONNECTED_MESSAGE = 'Reload this tab to activate CIRA.';

async function ping(api: TabApi, tabId: number): Promise<{ source: string } | null> {
  try {
    const reply = (await api.sendMessage(tabId, { type: 'CIRA/PING' })) as RuntimeMessage | undefined;
    if (reply && reply.type === 'CIRA/PONG') return { source: reply.source ?? 'unknown' };
  } catch {
    // "Receiving end does not exist": no content script in this tab.
  }
  return null;
}

export async function connectToTab(api: TabApi, tabId: number, opts: { inject?: boolean } = {}): Promise<ConnectionResult> {
  const first = await ping(api, tabId);
  if (first) return { status: 'connected', source: first.source, injected: false };
  if (opts.inject === false) return { status: 'not_connected', reason: 'content script did not respond' };

  try {
    await api.injectContentScript(tabId);
  } catch (err) {
    return { status: 'not_connected', reason: `could not inject content script: ${err instanceof Error ? err.message : String(err)}` };
  }
  // The content script loader imports its module asynchronously.
  for (let i = 0; i < 10; i++) {
    await api.sleep(150);
    const again = await ping(api, tabId);
    if (again) return { status: 'connected', source: again.source, injected: true };
  }
  return { status: 'not_connected', reason: 'content script did not respond after injection' };
}

/** Wait (bounded) for the content script to come up, e.g. after a tab reload. */
export async function waitForConnection(api: TabApi, tabId: number, timeoutMs = 10_000, stepMs = 250): Promise<ConnectionResult> {
  const deadline = timeoutMs / stepMs;
  for (let i = 0; i < deadline; i++) {
    const r = await ping(api, tabId);
    if (r) return { status: 'connected', source: r.source, injected: false };
    await api.sleep(stepMs);
  }
  return connectToTab(api, tabId);
}

export async function extractFromTab(api: TabApi, tabId: number): Promise<ExtractionResult> {
  const conn = await connectToTab(api, tabId);
  if (conn.status !== 'connected') return { ok: false, reason: 'not_connected', message: NOT_CONNECTED_MESSAGE };

  let reply: RuntimeMessage | undefined;
  try {
    reply = (await api.sendMessage(tabId, { type: 'CIRA/EXTRACT_REQUEST' })) as RuntimeMessage | undefined;
  } catch (err) {
    return { ok: false, reason: 'extract_failed', message: `Could not read this chat: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (reply?.type === 'CIRA/EXTRACT_ERROR') {
    return { ok: false, reason: 'extract_failed', message: `Could not read this chat: ${reply.error}` };
  }
  if (reply?.type !== 'CIRA/EXTRACT_RESPONSE') {
    return { ok: false, reason: 'extract_failed', message: 'Could not read this chat: no response from the page.' };
  }
  if (reply.conversation.messages.length === 0) {
    return { ok: false, reason: 'empty', message: 'No messages found on this page yet. Open a conversation, then try again.' };
  }
  return { ok: true, conversation: reply.conversation };
}

/** The real Chrome implementation. */
export const chromeTabApi: TabApi = {
  sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  async injectContentScript(tabId) {
    const file = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0];
    if (!file) throw new Error('manifest has no content script');
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
