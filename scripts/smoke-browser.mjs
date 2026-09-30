// Real-browser smoke test of the BUILT extension (dist/) in Playwright Chromium.
//
// Serves fake chatgpt.com / claude.ai pages (no network, no login) and checks:
//   1. the content script starts on https://chatgpt.com/c/... and answers the PING handshake
//   2. Read chat (EXTRACT_REQUEST) returns the conversation
//   3. CIRA/SAVE_CONTEXT encodes + validates + stores a PCO (chrome.storage.local),
//      keeping Unicode code blocks (box drawing, arrows, CJK, emoji) unchanged
//   4. the legacy relay still stages and injects the handoff text into claude.ai
//
// The native host is NOT registered for Playwright's Chromium, so sync is expected
// to report `host_unavailable` here; the host itself is covered by smoke-e2e.mjs.
//
//   pnpm build:extension && node scripts/smoke-browser.mjs
// First run on a new machine: pnpm exec playwright install chromium
//
// Phase 02C adds a side-panel run (the real side panel page, driven by clicks):
//   5. Deterministic is the default and never contacts a model endpoint
//   6. Semantic without granted host access sends nothing (the permission prompt
//      stays pending; Playwright cannot answer browser permission prompts)
//   7. Semantic end to end against a fake OpenAI-compatible server on 127.0.0.1,
//      in a temporary copy of dist/ whose manifest pre-grants the loopback origin
//      (test-only; stands in for the user clicking "Allow"): 10 messages → select 4
//      → the endpoint receives exactly those 4 → review badges → remove an item →
//      save (cira.semantic kept) → relay into claude.ai; then Hybrid fallback.
import { chromium } from 'playwright';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'dist');
const profile = mkdtempSync(join(tmpdir(), 'cira-browser-'));
const CHAT_URL = 'https://chatgpt.com/c/6abbf296-f460-83e8-b7e5-9df7ad7ea3b1';
// Unicode that must survive DOM → Markdown → PCO → relay unchanged (box drawing, arrows, check marks, CJK, emoji).
const UNICODE_BLOCK = 'project/\n├── frontend/\n│   └── src/\n└── README.md\n  │\n  ▼\nlogin → token ✓ 日本語 😀';

const CHATGPT_HTML = `<!doctype html><html><head><title>Session storage - ChatGPT</title></head><body><main>
<div data-testid="conversation-turn-1"><div data-message-author-role="user"><div class="whitespace-pre-wrap">We're building a sync service. Do not use Firebase. How should we store sessions?</div></div></div>
<div data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown"><p>We'll use Postgres for sessions.</p><pre><code class="language-ts">const pool = new Pool();</code></pre><pre><code class="language-text">${UNICODE_BLOCK}</code></pre></div></div></div>
</main><div id="prompt-textarea" contenteditable="true"></div></body></html>`;
// Served like the real sites ("text/html; charset=utf-8"). Without a charset Chromium decodes the
// page as Windows-1252 and the DOM itself would hold "â”œâ”€â”€" before CIRA reads anything.
const HTML = 'text/html; charset=utf-8';
/** UTF-8 bytes of `s` read as Windows-1252: the mojibake from the Phase 01 report. */
const asWindows1252 = (s) => new TextDecoder('windows-1252').decode(new TextEncoder().encode(s));
const UNICODE_SAMPLES = ['├──', '│', '└──', '▼', '→', '✓', '日本語', '😀'];
const CLAUDE_HTML = `<!doctype html><html><head><title>Claude</title></head><body>
<div contenteditable="true" class="ProseMirror" role="textbox"></div></body></html>`;

// ── Phase 02C fixtures ────────────────────────────────────────────────────
const TEN_URL = 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000010';
const TEN = [
  ['user', 'I prefer PostgreSQL for the database.'],
  ['assistant', 'MongoDB may be easier for a document-heavy app.'],
  ['user', 'The API must use TypeScript.'],
  ['assistant', 'You could deploy it on Fly.io.'],
  ['user', 'Do not use Firebase.'],
  ['assistant', 'Consider Redis for caching.'],
  ['user', 'We need rate limiting on login.'],
  ['assistant', 'Maybe use GraphQL instead of REST.'],
  ['user', 'The deadline is next Friday.'],
  ['assistant', 'I can write the migration scripts.'],
];
const SELECT_NUMBERS = [2, 5, 7, 9]; // 1-based, as shown in the panel → indexes 1, 4, 6, 8
const TEN_HTML = `<!doctype html><html><head><title>Ten message planning chat - ChatGPT</title></head><body><main>
${TEN.map(([role, text], i) =>
  role === 'user'
    ? `<div data-testid="conversation-turn-${i + 1}"><div data-message-author-role="user"><div class="whitespace-pre-wrap">${text}</div></div></div>`
    : `<div data-testid="conversation-turn-${i + 1}"><div data-message-author-role="assistant"><div class="markdown"><p>${text}</p></div></div></div>`,
).join('\n')}
</main><div id="prompt-textarea" contenteditable="true"></div></body></html>`;

/** Fake OpenAI-compatible server on 127.0.0.1: records requests, answers like a well-behaved model. */
const model = { requests: [], mode: 'good' };
function goodAnswer(sent) {
  const items = sent.map((m, i) => {
    const user = m.role === 'user';
    const constraint = user && /must|do not/i.test(m.content);
    return {
      ref: `i${i + 1}`,
      type: user ? (constraint ? 'constraint' : 'fact') : 'decision',
      content: m.content.replace(/\.$/, ''),
      origin: user ? 'user' : 'assistant',
      assertion: user ? 'explicit' : 'suggested',
      confidence: 0.9,
      strength: constraint ? (/do not/i.test(m.content) ? 'must_not' : 'must') : null,
      status: user ? null : 'proposed',
      language: null, filename: null, uri: null, title: null,
      evidence: [{ message: m.ref, quote: m.content }],
    };
  });
  return JSON.stringify({ items, relations: [] });
}
const server = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let sent = [];
    try {
      const user = JSON.parse(body).messages.find((m) => m.role === 'user').content;
      sent = JSON.parse(user.slice(user.indexOf('\n') + 1));
    } catch { /* recorded as-is */ }
    model.requests.push({ url: req.url, origin: req.headers.origin, body, sent });
    if (model.mode === 'fail') return res.writeHead(503, { 'content-type': 'application/json', ...cors }).end('{"error":{"message":"model loading"}}');
    const payload = { choices: [{ message: { role: 'assistant', content: goodAnswer(sent) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(JSON.stringify(payload));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const MODEL_BASE = `http://127.0.0.1:${server.address().port}/v1`;

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

async function fakeSites(context) {
  await context.route('https://chatgpt.com/**', (route) => {
    const url = route.request().url();
    if (/\/(api|backend-api)\//.test(url)) return route.fulfill({ status: 401, body: '{}' });
    return route.fulfill({ status: 200, contentType: HTML, body: url.startsWith(TEN_URL) ? TEN_HTML : CHATGPT_HTML });
  });
  await context.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: HTML, body: CLAUDE_HTML }));
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
}

async function extensionId(context) {
  // The worker can start before a waitForEvent listener exists; poll as well.
  for (let i = 0; i < 150; i++) {
    const sw = context.serviceWorkers()[0];
    if (sw) return new URL(sw.url()).host;
    await Promise.race([context.waitForEvent('serviceworker', { timeout: 200 }).catch(() => {}), new Promise((r) => setTimeout(r, 200))]);
  }
  throw new Error('extension service worker did not start');
}

const launch = (dir, userDir, extraArgs = []) =>
  chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, ...extraArgs],
  });

/** Open the ten-message chat and the REAL side panel page pinned to that tab; read the chat. */
async function openPanel(context, id) {
  const chat = await context.newPage();
  await chat.goto(TEN_URL);
  await chat.waitForTimeout(1200);
  const probe = await context.newPage();
  await probe.goto(`chrome-extension://${id}/src/popup/index.html`);
  const tabId = await probe.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0]?.id, TEN_URL);
  await probe.close();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/src/sidepanel/index.html?tab=${tabId}`);
  await panel.getByRole('button', { name: 'Read chat', exact: true }).click();
  await panel.locator('ul[aria-label="Conversation messages"] > li').nth(9).waitFor({ timeout: 8000 });
  return panel;
}

async function selectFour(panel) {
  await panel.getByRole('button', { name: 'Clear all' }).click();
  const rows = panel.locator('ul[aria-label="Conversation messages"] > li');
  for (const n of SELECT_NUMBERS) await rows.nth(n - 1).locator('input[type="checkbox"]').check();
  await panel.getByText('Selected 4 / 10 messages').waitFor({ timeout: 4000 });
}

async function configureModel(panel, mode) {
  await panel.locator('#cp-mode-select').selectOption(mode);
  await panel.getByRole('button', { name: 'Model', exact: true }).click();
  await panel.locator('#cp-provider input[type="url"]').fill(MODEL_BASE);
  await panel.locator('#cp-provider input[type="url"]').press('Tab');
  await panel.locator('#cp-provider input[type="text"]').fill('fake-model');
  await panel.locator('#cp-provider input[type="text"]').press('Tab');
}

const itemRow = (panel, text) => panel.locator('ul[aria-label="Extracted context items"] > li', { hasText: text });

const ctx = await launch(ext, profile);
try {
  await fakeSites(ctx);
  const extId = await extensionId(ctx);
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
  const pcoJson = JSON.stringify(r.save?.document ?? {});
  const codeItems = (r.save?.document?.items ?? []).filter((i) => i.type === 'code_artifact').map((i) => i.content);
  check(
    'PCO keeps Unicode code blocks exactly (box drawing, arrows, check marks, CJK, emoji)',
    codeItems.includes(UNICODE_BLOCK) &&
      (r.save?.document?.conversations?.[0]?.turns?.[1]?.content ?? '').includes(UNICODE_BLOCK) &&
      UNICODE_SAMPLES.every((s) => !pcoJson.includes(asWindows1252(s))),
    codeItems,
  );
  check('local sync status reported (host not registered for test Chromium)', ['host_unavailable', 'synced'].includes(r.save?.sync?.status), r.save?.sync);
  check('legacy relay staged', r.stage?.ok === true, r.stage);

  const claude = await ctx.newPage();
  await claude.goto('https://claude.ai/new');
  await claude.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.textContent?.length > 0, null, { timeout: 8000 }).catch(() => {});
  const injected = await claude.evaluate(() => document.querySelector('[contenteditable="true"]')?.innerText ?? '');
  check('legacy relay injected handoff into claude.ai', injected.startsWith('# Context handoff from CHATGPT') && injected.includes('Title: Session storage'), injected.slice(0, 120));
  const relayed = injected.replace(/\u00a0/g, ' ');
  check(
    'legacy relay carries the Unicode code block into claude.ai',
    UNICODE_SAMPLES.every((s) => relayed.includes(s) && !relayed.includes(asWindows1252(s))),
    relayed.slice(relayed.indexOf('project/'), relayed.indexOf('project/') + 160),
  );

  // ── 5. Deterministic default (real side panel page) ─────────────────────
  const panel = await openPanel(ctx, extId);
  const defaultMode = await panel.locator('#cp-mode-select').inputValue();
  const detHint = await panel.getByText('Nothing is sent to an AI provider.').count();
  await panel.getByRole('button', { name: 'Continue to Review' }).click();
  await panel.locator('ul[aria-label="Extracted context items"] > li').first().waitFor({ timeout: 6000 });
  const detBadges = await panel.locator('.cp-origin').count();
  check('side panel: Deterministic is the default and contacts no model', defaultMode === 'deterministic' && detHint === 1 && detBadges === 0 && model.requests.length === 0, { defaultMode, detHint, detBadges, requests: model.requests.length });

  // ── 6. Semantic without host access: the prompt stays pending, nothing is sent ─
  await panel.getByRole('button', { name: /Back/ }).click();
  await selectFour(panel);
  await configureModel(panel, 'semantic');
  const localHint = await panel.getByText(/Processing locally .*Selected messages stay on this machine/).count();
  await panel.getByRole('button', { name: 'Continue to Review' }).click();
  await panel.waitForTimeout(2000);
  check('side panel: Semantic asks for host access first; nothing sent before it is granted', localHint === 1 && model.requests.length === 0, { localHint, requests: model.requests.length });
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}

// ── 7. Semantic / Hybrid end to end, loopback access pre-granted (test-only copy of dist/) ─
const grantedExt = mkdtempSync(join(tmpdir(), 'cira-ext-granted-'));
const profile2 = mkdtempSync(join(tmpdir(), 'cira-browser2-'));
cpSync(ext, grantedExt, { recursive: true });
const manifestPath = join(grantedExt, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = [...manifest.host_permissions, 'http://127.0.0.1/*'];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
// Tabs opened by the extension (chrome.tabs.create) bypass Playwright routing, so the
// real claude.ai must be unreachable here; the relay is received by a routed page below.
const ctx2 = await launch(grantedExt, profile2, ['--host-resolver-rules=MAP claude.ai ~NOTFOUND']);
try {
  await fakeSites(ctx2);
  const id2 = await extensionId(ctx2);
  const panel = await openPanel(ctx2, id2);
  await selectFour(panel);
  await configureModel(panel, 'semantic');
  await panel.getByRole('button', { name: 'Continue to Review' }).click();
  await itemRow(panel, 'MongoDB').waitFor({ timeout: 15000 }).catch(() => {});

  const sentTexts = (model.requests[0]?.sent ?? []).map((m) => m.content);
  const expected = SELECT_NUMBERS.map((n) => TEN[n - 1][1]);
  const unselectedLeaked = TEN.filter((_, i) => !SELECT_NUMBERS.includes(i + 1)).some(([, t]) => (model.requests[0]?.body ?? '').includes(t));
  check(
    'semantic: 10 messages, 4 selected → the endpoint received exactly those 4 (from the service worker)',
    model.requests.length === 1 && JSON.stringify(sentTexts) === JSON.stringify(expected) && !unselectedLeaked && model.requests[0].url === '/v1/chat/completions' && /^chrome-extension:\/\//.test(model.requests[0].origin ?? ''),
    { count: model.requests.length, sentTexts, origin: model.requests[0]?.origin },
  );
  const badge = async (t) => (await itemRow(panel, t).locator('.cp-origin').textContent().catch(() => null));
  const [mongoBadge, firebaseBadge] = [await badge('MongoDB'), await badge('Firebase')];
  check('semantic review: origin badges (assistant suggestion vs user)', mongoBadge === 'Assistant suggestion' && firebaseBadge === 'User', { mongoBadge, firebaseBadge });

  await itemRow(panel, 'deadline').locator('input[type="checkbox"]').uncheck();
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await panel.locator('input[type="radio"][value="claude"]').check({ force: true });
  const claudePage = ctx2.waitForEvent('page', { timeout: 10000 });
  await panel.getByRole('button', { name: /Save & send to Claude/ }).click();
  await panel.locator('.cp-banner-title', { hasText: 'Context ready' }).waitFor({ timeout: 10000 });

  const stored = await panel.evaluate(async () => {
    const [summary] = await chrome.runtime.sendMessage({ type: 'CIRA/LIST_CONTEXTS' });
    return summary ? chrome.runtime.sendMessage({ type: 'CIRA/GET_CONTEXT', id: summary.id }) : null;
  });
  const sem = stored?.extensions?.['cira.semantic'];
  check(
    'semantic save: reviewed draft stored (no re-extraction), removed item gone, cira.semantic kept',
    model.requests.length === 1 &&
      stored?.pco_version === '0.1' &&
      stored.items.length === 3 &&
      !JSON.stringify(stored.items).includes('deadline') &&
      sem?.mode === 'semantic' &&
      Object.keys(sem.items).length === 3 &&
      JSON.stringify(stored.conversations[0].turns.map((t) => t.index)) === '[1,4,6,8]',
    { requests: model.requests.length, items: stored?.items?.length, mode: sem?.mode },
  );

  // The extension opened https://claude.ai/new itself (unresolvable here, so it stays an
  // error page and leaves the staged relay alone). A routed claude.ai page receives it.
  const opened = await claudePage.catch(() => null);
  await opened?.waitForLoadState('domcontentloaded').catch(() => {});
  const openedUrl = opened?.url() ?? '';
  const claude = await ctx2.newPage();
  await claude.goto('https://claude.ai/new');
  await claude.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.textContent?.length > 0, null, { timeout: 8000 }).catch(() => {});
  const injected2 = (await claude.evaluate(() => document.querySelector('[contenteditable="true"]')?.innerText ?? '')).replace(/\u00a0/g, ' ');
  check('semantic send opened the target tab (claude.ai/new)', /claude\.ai\/new|chrome-error:/.test(openedUrl), openedUrl);
  check(
    'semantic relay into claude.ai: final PCO only, assistant idea marked as a proposal',
    injected2.startsWith('# Context handoff from CHATGPT') &&
      injected2.includes('PROPOSED: MongoDB may be easier for a document-heavy app (assistant suggestion, not confirmed by the user)') &&
      !injected2.includes('deadline') &&
      !injected2.includes('Fly.io'),
    injected2.slice(0, 400),
  );

  // Hybrid with the model failing: explicit fallback banner, deterministic items.
  model.mode = 'fail';
  await panel.bringToFront();
  await panel.getByRole('button', { name: 'Start a new context' }).click();
  await panel.locator('ul[aria-label="Conversation messages"] > li').nth(9).waitFor({ timeout: 8000 });
  await selectFour(panel);
  await panel.locator('#cp-mode-select').selectOption('hybrid');
  await panel.getByRole('button', { name: 'Continue to Review' }).click();
  const fallbackShown = await panel.getByText('Semantic extraction unavailable: showing deterministic results only.').waitFor({ timeout: 10000 }).then(() => true, () => false);
  const fallbackItems = await panel.locator('ul[aria-label="Extracted context items"] > li').count();
  check('hybrid: model failure is announced and falls back to deterministic items', fallbackShown && fallbackItems > 0 && model.requests.length === 2, { fallbackShown, fallbackItems, requests: model.requests.length });
} finally {
  await ctx2.close();
  server.close();
  rmSync(profile2, { recursive: true, force: true });
  rmSync(grantedExt, { recursive: true, force: true });
}

console.log(failures ? `\nBROWSER SMOKE FAILED (${failures})` : '\nBROWSER SMOKE OK');
process.exitCode = failures ? 1 : 0;
