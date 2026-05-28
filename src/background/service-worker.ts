/**
 * MV3 service worker. Stateless message router + storage helpers.
 *
 * Content scripts can't share memory across tabs, so the relay payload is
 * persisted in chrome.storage.session and consumed by the target site's
 * content script when it loads.
 */
import { STORAGE_KEYS, type RuntimeMessage } from '@/shared/messaging';

async function stageRelay(target: 'claude' | 'chatgpt', payload: unknown): Promise<void> {
  const key = target === 'claude' ? STORAGE_KEYS.stagedClaude : STORAGE_KEYS.stagedChatgpt;
  await chrome.storage.session.set({ [key]: payload });
}

async function popStaged(
  target: 'claude' | 'chatgpt',
): Promise<unknown | null> {
  const key = target === 'claude' ? STORAGE_KEYS.stagedClaude : STORAGE_KEYS.stagedChatgpt;
  const result = await chrome.storage.session.get(key);
  const payload = result[key] ?? null;
  if (payload) await chrome.storage.session.remove(key);
  return payload;
}

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === 'CIRA/STAGE_RELAY') {
    void stageRelay(msg.target, msg.payload).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'CIRA/POP_STAGED') {
    void popStaged(msg.for).then((payload) => {
      const response: RuntimeMessage = {
        type: 'CIRA/POP_STAGED_RESPONSE',
        payload: payload as never,
      };
      sendResponse(response);
    });
    return true;
  }
  if (msg.type === 'CIRA/PING') {
    sendResponse({ type: 'CIRA/PONG' } satisfies RuntimeMessage);
    return false;
  }
  return false;
});
