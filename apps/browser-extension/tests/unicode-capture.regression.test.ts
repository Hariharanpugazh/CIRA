// @vitest-environment happy-dom
/**
 * Regression: Unicode in ChatGPT Markdown and code blocks (box-drawing trees,
 * arrows, check marks, multilingual text, emoji) must reach the PCO unchanged.
 *
 * Phase 01 report: a captured PCO showed `â”œâ”€â”€ frontend/` where ChatGPT
 * showed `├── frontend/`. That string is the UTF-8 bytes of `├──` decoded as
 * Windows-1252. A byte-level trace of the built extension and host showed every
 * CIRA stage keeps the text; the mojibake appeared when the (correct,
 * BOM-less UTF-8) file was read with Windows PowerShell 5.1 `Get-Content`,
 * which assumes the ANSI code page unless given `-Encoding UTF8`.
 *
 * This file runs the browser half of the capture path with the real code:
 *   ChatGPT DOM or /backend-api JSON bytes → content script (ChatGPT adapter +
 *   DOM→Markdown serializer) → runtime message (JSON, as Chrome passes it) →
 *   context pipeline (legacy migration, encoder, validation, chrome.storage
 *   round trip) → the document handed to native messaging.
 * cli/tests/unicode.regression.test.ts covers the host half byte for byte.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMemoryArea, validate, type PCODocument } from '@cira/core';
import { saveConversationAsPco } from '@/background/context-pipeline';
import { buildRelaySummary } from '@/shared/relay';
import type { RuntimeMessage } from '@/shared/messaging';
import type { Conversation } from '@/shared/schema';
import { ChromeContextStore } from '@/storage/chrome-context-store';

/** What the extension must emit for the page below (shared with the CLI test). */
const EXPECTED = JSON.parse(
  readFileSync(resolve(__dirname, '../../../packages/core/tests/fixtures/legacy/chatgpt-unicode-capture.json'), 'utf8'),
) as Conversation;

const USER = "I'm building a TypeScript project. I prefer React and Tailwind. The backend should use Django. The project needs authentication.";
const TREE = ['project/', '├── frontend/', '│   ├── src/', '│   └── App.tsx', '└── README.md'].join('\n');
const FLOW = ['Browser (React)', '      │', '      ▼', 'Django /api/auth/login → JWT ✓ 🔐 connexion réussie · ログイン成功'].join('\n');
const PROSE = 'Multilingual: Café naïve façade — 日本語 · Ελληνικά · हिन्दी · русский · 😀';
const CLIENT = 'cira-browser-extension@0.1.0';

const SAMPLES = ['├──', '│', '└──', '▼', '→', '✓', 'é', '—', '·', '日本語', 'Ελληνικά', 'हिन्दी', 'русский', 'ログイン', '😀', '🔐'];
/** The exact corruption from the report: UTF-8 bytes read as Windows-1252. */
const asWindows1252 = (s: string) => new TextDecoder('windows-1252').decode(new TextEncoder().encode(s));

function expectUnicodeIntact(text: string): void {
  for (const s of SAMPLES) {
    expect(text, `missing ${s}`).toContain(s);
    expect(text, `mojibake of ${s}`).not.toContain(asWindows1252(s));
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Shaped like a current ChatGPT code block: language label, copy button, then <code>. */
const codeBlock = (lang: string, body: string) =>
  `<pre class="overflow-visible!"><div class="contain-inline-size rounded-2xl">` +
  `<div class="flex items-center px-4 py-2 text-xs">${lang}</div>` +
  `<div class="sticky top-9"><button aria-label="Copy">Copy code</button></div>` +
  `<div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre! language-${lang}"><span>${esc(body)}</span></code></div>` +
  `</div></pre>`;

const CHATGPT_DOM =
  `<main>` +
  `<article data-testid="conversation-turn-1"><div data-message-author-role="user"><div class="whitespace-pre-wrap">${esc(USER)}</div></div></article>` +
  `<article data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown prose">` +
  `<h2>Project structure</h2>${codeBlock('text', TREE)}` +
  `<h2>Authentication flow</h2>` +
  `<table><thead><tr><th>Step</th><th>Result</th></tr></thead><tbody><tr><td>Login → token</td><td>✓</td></tr></tbody></table>` +
  `${codeBlock('text', FLOW)}<p>${esc(PROSE)}</p>` +
  `</div></div></article>` +
  `</main><div id="prompt-textarea" contenteditable="true"></div>`;

/** Same conversation as ChatGPT's /backend-api/conversation/{id} returns it. */
const API_CONVERSATION = {
  title: EXPECTED.title,
  current_node: 'n2',
  mapping: {
    root: { children: ['n1'] },
    n1: { parent: 'root', children: ['n2'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: [EXPECTED.messages[0].content] } } },
    n2: { parent: 'n1', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [EXPECTED.messages[1].content] } } },
  },
};

type Listener = (msg: RuntimeMessage, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void;
const listeners: Listener[] = [];
let apiAvailable = false;

/** Deliver a message to the content script, then pass the reply through JSON as Chrome does. */
function send(msg: RuntimeMessage): Promise<unknown> {
  return new Promise((resolveReply, reject) => {
    const [listener] = listeners;
    if (!listener) return reject(new Error('Could not establish connection. Receiving end does not exist.'));
    const keepOpen = listener(msg, {}, (r) => resolveReply(r === undefined ? r : JSON.parse(JSON.stringify(r))));
    if (keepOpen !== true) setTimeout(() => resolveReply(undefined), 0);
  });
}

async function readChat(): Promise<Conversation> {
  const reply = (await send({ type: 'CIRA/EXTRACT_REQUEST' })) as RuntimeMessage;
  if (reply.type !== 'CIRA/EXTRACT_RESPONSE') throw new Error(`unexpected reply ${JSON.stringify(reply)}`);
  return reply.conversation;
}

/** A UTF-8 byte body, so `Response.json()` performs the same decode as on chatgpt.com. */
const jsonResponse = (body: unknown) =>
  new Response(new TextEncoder().encode(JSON.stringify(body)), { status: 200, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(EXPECTED.url);
  document.title = `${EXPECTED.title} - ChatGPT`;
  document.body.innerHTML = CHATGPT_DOM;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!apiAvailable) return new Response('{}', { status: 401 });
      if (url.endsWith('/api/auth/session')) return jsonResponse({ accessToken: 'test-token' });
      if (url.includes('/backend-api/conversation/')) return jsonResponse(API_CONVERSATION);
      return new Response('{}', { status: 404 });
    }),
  );
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

describe('Unicode survives browser capture → PCO', () => {
  it('uses the real characters (guards this file and the fixture against re-encoding)', () => {
    expect([...'├─│└▼→✓'].map((c) => c.codePointAt(0))).toEqual([0x251c, 0x2500, 0x2502, 0x2514, 0x25bc, 0x2192, 0x2713]);
    expect(asWindows1252('├──')).toBe('â”œâ”€â”€');
    expect(EXPECTED.messages[1].content).toContain(`\`\`\`text\n${TREE}\n\`\`\``);
    expectUnicodeIntact(JSON.stringify(EXPECTED));
  });

  it('Read chat, DOM path: ChatGPT adapter + DOM→Markdown serializer keep every character', async () => {
    apiAvailable = false;
    const conv = await readChat();
    expect(conv.messages).toEqual(EXPECTED.messages);
    const assistant = conv.messages[1].content;
    expect(assistant).toContain(`## Project structure\n\n\`\`\`text\n${TREE}\n\`\`\``);
    expect(assistant).toContain(`\`\`\`text\n${FLOW}\n\`\`\``);
    expect(assistant).toContain('| Login → token | ✓ |');
    expect(assistant).toContain(PROSE);
    expectUnicodeIntact(JSON.stringify(conv));
  });

  it('Read chat, API path: /backend-api UTF-8 JSON keeps every character', async () => {
    apiAvailable = true;
    try {
      const conv = await readChat();
      expect(conv.title).toBe(EXPECTED.title);
      expect(conv.messages).toEqual(EXPECTED.messages);
      expectUnicodeIntact(JSON.stringify(conv));
    } finally {
      apiAvailable = false;
    }
  });

  it('context pipeline: transcript, code artifacts, chrome.storage copy and the native-messaging document are unchanged', async () => {
    const conv = await readChat();
    const area = createMemoryArea();
    let sentToHost: PCODocument | undefined;
    const r = await saveConversationAsPco(conv, {
      store: new ChromeContextStore(area),
      client: CLIENT,
      sync: async (doc) => {
        sentToHost = doc;
        return { status: 'synced', path: `C:\\Users\\u\\.cira\\contexts\\${doc.id}.pco.json` };
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = r.document;
    expect(validate(doc).ok).toBe(true);

    const [turnUser, turnAssistant] = doc.conversations[0].turns;
    expect(turnUser.content).toBe(USER);
    expect(turnAssistant.content).toBe(EXPECTED.messages[1].content);

    // Phase 01 extraction is unchanged: 4 heuristic user statements + 2 deterministic code blocks.
    expect(doc.items.map((i) => [i.type, i.content])).toEqual([
      ['fact', "I'm building a TypeScript project."],
      ['preference', 'I prefer React and Tailwind.'],
      ['constraint', 'The backend should use Django.'],
      ['fact', 'The project needs authentication.'],
      ['code_artifact', TREE],
      ['code_artifact', FLOW],
    ]);
    for (const item of doc.items) {
      const p = item.provenance;
      expect(p.source).toEqual({ kind: 'browser', platform: 'chatgpt', client: CLIENT });
      expect(p.conversation_id).toBe(doc.conversations[0].id);
      expect(p.captured_at).toBe(doc.conversations[0].captured_at);
      expect(p.extracted_by.method).toBe(item.type === 'code_artifact' ? 'deterministic' : 'heuristic');
      // Spans are UTF-16 offsets; they must still line up after astral characters (emoji).
      const turn = doc.conversations[0].turns.find((t) => t.id === p.turn_id)!;
      const excerpt = turn.content.slice(p.span!.start, p.span!.end);
      expect(excerpt).toBe(item.type === 'code_artifact' ? `\`\`\`text\n${item.content}\n\`\`\`` : item.content);
    }

    expect(area.dump()[`cira.pco.doc.${doc.id}`]).toEqual(doc);
    expect(sentToHost).toEqual(doc);
    expectUnicodeIntact(JSON.stringify(sentToHost));
  });

  it('legacy relay text carries the same characters', async () => {
    const relay = buildRelaySummary(await readChat());
    expect(relay).toContain(`\`\`\`text\n${TREE}\n\`\`\``);
    expect(relay).toContain(`\`\`\`text\n${FLOW}\n\`\`\``);
    for (const s of ['├──', '│', '└──', '▼', '→', '✓']) expect(relay).not.toContain(asWindows1252(s));
  });
});
