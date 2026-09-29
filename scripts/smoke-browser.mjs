// Real-browser smoke test of the BUILT extension (dist/) in Playwright Chromium.
//
// Serves fake chatgpt.com / claude.ai pages (no network, no login) and checks:
//   1. the content script starts on https://chatgpt.com/c/... and answers the PING handshake
//   2. Read chat (EXTRACT_REQUEST) returns the conversation
//   3. CIRA/SAVE_CONTEXT encodes + validates + stores a PCO (chrome.storage.local)
//   4. the legacy relay still stages and injects the handoff text into claude.ai
//
// The native host is NOT registered for Playwright's Chromium, so sync is expected
// to report `host_unavailable` here; the host itself is covered by smoke-e2e.mjs.
//
//   pnpm build:extension && node scripts/smoke-browser.mjs
// First run on a new machine: pnpm exec playwright install chromium
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'dist');
const profile = mkdtempSync(join(tmpdir(), 'cira-browser-'));
const CHAT_URL = 'https://chatgpt.com/c/6abbf296-f460-83e8-b7e5-9df7ad7ea3b1';

const CHATGPT_HTML = `<!doctype html><html><head><title>Session storage - ChatGPT</title></head><body><main>
<div data-testid="conversation-turn-1"><div data-message-author-role="user"><div class="whitespace-pre-wrap">We're building a sync service. Do not use Firebase. How should we store sessions?</div></div></div>
<div data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown"><p>We'll use Postgres for sessions.</p><pre><code class="language-ts">const pool = new Pool();</code></pre></div></div></div>
</main><div id="prompt-textarea" contenteditable="true"></div></body></html>`;
const CLAUDE_HTML = `<!doctype html><html><head><title>Claude</title></head><body>
<div contenteditable="true" class="ProseMirror" role="textbox"></div></body></html>`;

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  await ctx.route('https://chatgpt.com/**', (route) =>
    /\/(api|backend-api)\//.test(route.request().url())
      ? route.fulfill({ status: 401, body: '{}' })
      : route.fulfill({ status: 200, contentType: 'text/html', body: CHATGPT_HTML }),
  );
  await ctx.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: CLAUDE_HTML }));
  await ctx.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  console.log(`extension ${extId}`);

  const chat = await ctx.newPage();
  const pageErrors = [];
  chat.on('console', (m) => m.type() === 'error' && /chrome-extension:/.test(m.text() + (m.location()?.url ?? '')) && pageErrors.push(m.text()));
  chat.on('pageerror', (e) => pageErrors.push(e.message));
  await chat.goto(CHAT_URL);
  await chat.waitForTimeout(1500);
  check('content script loads without errors on chatgpt.com', pageErrors.length === 0, pageErrors);

  // An extension page behaves like the side panel / popup (same chrome.* APIs).
  const ui = await ctx.newPage();
  await ui.goto(`chrome-extension://${extId}/src/popup/index.html`);
  const r = await ui.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    const out = { tabUrl: tab?.url };
    try { out.pong = await chrome.tabs.sendMessage(tab.id, { type: 'CIRA/PING' }); } catch (e) { out.pingError = String(e); }
    try { out.extract = await chrome.tabs.sendMessage(tab.id, { type: 'CIRA/EXTRACT_REQUEST' }); } catch (e) { out.extractError = String(e); }
    if (out.extract?.conversation) {
      out.save = await chrome.runtime.sendMessage({ type: 'CIRA/SAVE_CONTEXT', conversation: out.extract.conversation });
      out.list = await chrome.runtime.sendMessage({ type: 'CIRA/LIST_CONTEXTS' });
      out.stage = await chrome.runtime.sendMessage({ type: 'CIRA/STAGE_RELAY', target: 'claude', payload: { conversation: out.extract.conversation, summary: '' } });
    }
    return out;
  }, CHAT_URL);

  check('tab URL is chatgpt.com', r.tabUrl === CHAT_URL, r.tabUrl);
  check('handshake: PING → PONG (source chatgpt)', r.pong?.type === 'CIRA/PONG' && r.pong?.source === 'chatgpt', r.pong ?? r.pingError);
  const msgs = r.extract?.conversation?.messages ?? [];
  check('Read chat: EXTRACT_REQUEST returns 2 messages', r.extract?.type === 'CIRA/EXTRACT_RESPONSE' && msgs.length === 2, r.extract ?? r.extractError);
  check('capture → PCO saved in chrome.storage', r.save?.ok === true && r.save.summary.item_count > 0 && r.list?.length === 1, r.save);
  check('PCO provenance points at chatgpt.com', r.save?.document?.conversations?.[0]?.url === CHAT_URL && r.save?.document?.conversations?.[0]?.source?.platform === 'chatgpt');
  check('local sync status reported (host not registered for test Chromium)', ['host_unavailable', 'synced'].includes(r.save?.sync?.status), r.save?.sync);
  check('legacy relay staged', r.stage?.ok === true, r.stage);

  const claude = await ctx.newPage();
  await claude.goto('https://claude.ai/new');
  await claude.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.textContent?.length > 0, null, { timeout: 8000 }).catch(() => {});
  const injected = await claude.evaluate(() => document.querySelector('[contenteditable="true"]')?.innerText ?? '');
  check('legacy relay injected handoff into claude.ai', injected.startsWith('# Context handoff from CHATGPT') && injected.includes('Title: Session storage'), injected.slice(0, 120));
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures ? `\nBROWSER SMOKE FAILED (${failures})` : '\nBROWSER SMOKE OK');
process.exitCode = failures ? 1 : 0;
