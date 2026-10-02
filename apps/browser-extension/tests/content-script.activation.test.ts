// @vitest-environment happy-dom
/**
 * Regression: "Reload this tab to activate CIRA." on chatgpt.com.
 *
 * Root cause: Chrome content scripts run in an isolated world where
 * `window.customElements` is null. Any import-time code that touched the
 * custom-element registry threw and aborted the whole content script before
 * its message listener was registered, so every PING / EXTRACT_REQUEST from
 * the side panel failed with "Receiving end does not exist".
 *
 * This test loads the real content-script entry under the same conditions
 * (customElements === null, chatgpt.com URL, mocked chrome.*) and checks
 * that the handshake and Read chat work.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RuntimeMessage } from '@/shared/messaging';

type Listener = (msg: RuntimeMessage, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void;
const listeners: Listener[] = [];

function send(msg: RuntimeMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const [listener] = listeners;
    if (!listener) return reject(new Error('Could not establish connection. Receiving end does not exist.'));
    const keepOpen = listener(msg, {}, resolve);
    if (keepOpen !== true) setTimeout(() => resolve(undefined), 0);
  });
}

beforeAll(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(
    'https://chatgpt.com/c/6abbf296-f460-83e8-b7e5-9df7ad7ea3b1',
  );
  document.title = 'Rate limits - ChatGPT';
  document.body.innerHTML = `
    <main>
      <div data-testid="conversation-turn-1"><div data-message-author-role="user"><div class="whitespace-pre-wrap">Do not use Firebase. How should we store sessions?</div></div></div>
      <div data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown"><p>We'll use Postgres for sessions.</p></div></div></div>
    </main>
    <div id="prompt-textarea" contenteditable="true"></div>`;

  // Chrome isolated-world condition that triggered the bug.
  Object.defineProperty(window, 'customElements', { value: null, configurable: true });
  // The ChatGPT adapter tries the API first; make it fall back to the DOM.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
  Element.prototype.scrollIntoView = () => {};

  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: (l: Listener) => listeners.push(l) },
      sendMessage: vi.fn(async () => undefined),
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  });

  await import('@/content/universal');
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('content script activation on chatgpt.com', () => {
  it('registers its message listener even though customElements is null', () => {
    expect(window.customElements).toBeNull();
    expect(listeners).toHaveLength(1);
  });

  it('answers the side panel handshake with the detected source', async () => {
    expect(await send({ type: 'CIRA/PING' })).toEqual({ type: 'CIRA/PONG', source: 'chatgpt' });
  });

  it('does not inject the removed relay pill', () => {
    expect(document.querySelector('cira-relay-pill')).toBeNull();
  });

  it('answers Read chat (EXTRACT_REQUEST) with the conversation', async () => {
    const reply = (await send({ type: 'CIRA/EXTRACT_REQUEST' })) as Extract<RuntimeMessage, { type: 'CIRA/EXTRACT_RESPONSE' }>;
    expect(reply.type).toBe('CIRA/EXTRACT_RESPONSE');
    expect(reply.conversation.source).toBe('chatgpt');
    expect(reply.conversation.url).toBe('https://chatgpt.com/c/6abbf296-f460-83e8-b7e5-9df7ad7ea3b1');
    expect(reply.conversation.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Do not use Firebase. How should we store sessions?'],
      ['assistant', "We'll use Postgres for sessions."],
    ]);
  });
});
