/**
 * Side panel / popup ↔ content script connection logic.
 * The UI must report "connected" only when the content script answered.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeMessage } from '@/shared/messaging';
import {
  connectToTab,
  extractFromTab,
  NOT_CONNECTED_MESSAGE,
  waitForConnection,
  type TabApi,
} from '@/shared/tab-connection';

const NO_RECEIVER = new Error('Could not establish connection. Receiving end does not exist.');
const conversation = {
  source: 'chatgpt' as const,
  title: 't',
  url: 'https://chatgpt.com/c/x',
  capturedAt: '2026-09-29T00:00:00.000Z',
  messages: [{ role: 'user' as const, content: 'Do not use Firebase.' }],
};

/** A fake tab whose content script is alive when `alive()` is true. */
function fakeTab(opts: { alive: () => boolean; onInject?: () => void; extract?: () => RuntimeMessage }): TabApi & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async sendMessage(_tabId, msg) {
      sent.push(msg.type);
      if (!opts.alive()) throw NO_RECEIVER;
      if (msg.type === 'CIRA/PING') return { type: 'CIRA/PONG', source: 'chatgpt' };
      if (msg.type === 'CIRA/EXTRACT_REQUEST') return opts.extract?.() ?? { type: 'CIRA/EXTRACT_RESPONSE', conversation };
      return undefined;
    },
    injectContentScript: vi.fn(async () => opts.onInject?.()),
    sleep: async () => {},
  };
}

describe('connectToTab (handshake)', () => {
  it('is connected when the content script answers PING', async () => {
    const api = fakeTab({ alive: () => true });
    expect(await connectToTab(api, 1)).toEqual({ status: 'connected', source: 'chatgpt', injected: false });
    expect(api.injectContentScript).not.toHaveBeenCalled();
  });

  it('injects once and connects when the tab predates the extension', async () => {
    let alive = false;
    const api = fakeTab({ alive: () => alive, onInject: () => { alive = true; } });
    expect(await connectToTab(api, 1)).toEqual({ status: 'connected', source: 'chatgpt', injected: true });
    expect(api.injectContentScript).toHaveBeenCalledTimes(1);
  });

  it('is NOT connected when the content script never answers (the reported bug)', async () => {
    const api = fakeTab({ alive: () => false });
    const r = await connectToTab(api, 1);
    expect(r.status).toBe('not_connected');
  });

  it('waitForConnection picks up a content script that starts after a reload', async () => {
    let pings = 0;
    const api = fakeTab({ alive: () => ++pings > 3 });
    expect((await waitForConnection(api, 1, 5_000, 1)).status).toBe('connected');
  });
});

describe('extractFromTab (Read chat)', () => {
  it('reaches the content script and returns the conversation', async () => {
    const api = fakeTab({ alive: () => true });
    expect(await extractFromTab(api, 1)).toEqual({ ok: true, conversation });
    expect(api.sent).toEqual(['CIRA/PING', 'CIRA/EXTRACT_REQUEST']);
  });

  it('reports the activation message only when no content script is reachable', async () => {
    const r = await extractFromTab(fakeTab({ alive: () => false }), 1);
    expect(r).toEqual({ ok: false, reason: 'not_connected', message: NOT_CONNECTED_MESSAGE });
  });

  it('surfaces extraction errors instead of the activation message', async () => {
    const api = fakeTab({ alive: () => true, extract: () => ({ type: 'CIRA/EXTRACT_ERROR', error: 'boom' }) });
    const r = await extractFromTab(api, 1);
    expect(r).toMatchObject({ ok: false, reason: 'extract_failed' });
    expect(r.ok ? '' : r.message).not.toBe(NOT_CONNECTED_MESSAGE);
  });

  it('reports an empty page clearly', async () => {
    const api = fakeTab({ alive: () => true, extract: () => ({ type: 'CIRA/EXTRACT_RESPONSE', conversation: { ...conversation, messages: [] } }) });
    expect(await extractFromTab(api, 1)).toMatchObject({ ok: false, reason: 'empty' });
  });
});
