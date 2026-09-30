// @vitest-environment happy-dom
/**
 * Side panel, Phase 02C (real React components, reducer, service-worker
 * extraction and save pipeline; chrome.* and the model endpoint are faked):
 *
 *   Select 4 of 10 → Semantic → Continue (permission, "Using semantic model…")
 *     → Review with origin badges → remove an item → Save & send → PCO + relay
 *
 * Also: Deterministic stays the default and never touches the provider;
 * failures offer Retry / Switch to Deterministic without losing the
 * selection; Hybrid fallback is announced; Edit reopens a semantic draft
 * without calling the model again.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryArea, getSemanticExtension, validate, validateSemanticExtension, type HttpTransport, type PCODocument } from '@cira/core';
import { resyncStoredPco, saveConversationAsPco } from '@/background/context-pipeline';
import { buildSemanticDraft } from '@/background/extraction';
import { API_KEY_STORAGE_KEY, normalizeSettings, OLLAMA_BASE_URL } from '@/shared/extraction-settings';
import type { RuntimeMessage } from '@/shared/messaging';
import type { Conversation } from '@/shared/schema';
import { ChromeContextStore } from '@/storage/chrome-context-store';
import { SidePanel } from '@/sidepanel/SidePanel';
import { ACTIVE_CONTEXT_KEY, SETTINGS_KEY } from '@/sidepanel/hooks/useWorkspace';
import { chatCompletion, fakeOpenAI, tenMessageConversation, type RecordedCall } from './helpers/fake-provider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLIENT = 'cira-browser-extension@0.1.0';
const TAB_ID = 9;

interface Fake {
  conversation: Conversation;
  transport: HttpTransport;
  calls: RecordedCall[];
  builds: Array<Extract<RuntimeMessage, { type: 'CIRA/BUILD_DRAFT' }>>;
  saves: Array<Extract<RuntimeMessage, { type: 'CIRA/SAVE_CONTEXT' }>>;
  staged: Array<Extract<RuntimeMessage, { type: 'CIRA/STAGE_RELAY' }>>;
  requested: string[];
  grant: boolean;
  local: Map<string, unknown>;
  session: Map<string, unknown>;
  store: ChromeContextStore;
}

let fake: Fake;
let root: Root;
let container: HTMLElement;

function useProvider(reply?: Parameters<typeof fakeOpenAI>[0]) {
  const f = fakeOpenAI(reply);
  fake.calls = f.calls;
  fake.transport = f.transport;
}

function area(map: Map<string, unknown>) {
  return {
    get: vi.fn(async (k: string) => (map.has(k) ? { [k]: map.get(k) } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) map.set(k, JSON.parse(JSON.stringify(v)));
    }),
    remove: vi.fn(async (k: string) => void map.delete(k)),
  };
}

function installChrome(): void {
  const f = fakeOpenAI();
  fake = {
    conversation: tenMessageConversation(),
    transport: f.transport,
    calls: f.calls,
    builds: [],
    saves: [],
    staged: [],
    requested: [],
    grant: true,
    local: new Map(),
    session: new Map(),
    store: new ChromeContextStore(createMemoryArea()),
  };
  const granted = new Set<string>();
  const listeners = { addListener: () => {}, removeListener: () => {} };
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ version: '0.1.0', content_scripts: [{ js: ['content.js'] }] }),
      sendMessage: vi.fn(async (msg: RuntimeMessage) => {
        switch (msg.type) {
          case 'CIRA/BUILD_DRAFT': {
            fake.builds.push(msg);
            // Same wiring as the service worker's handleBuildDraft, with the endpoint faked.
            const settings = normalizeSettings(fake.local.get(SETTINGS_KEY));
            const apiKey = fake.session.get(API_KEY_STORAGE_KEY) as string | undefined;
            return buildSemanticDraft(
              msg.conversation,
              { messageIndexes: msg.messageIndexes, mode: msg.mode },
              { client: CLIENT, provider: settings.provider, ...(apiKey ? { apiKey } : {}), transport: fake.transport, hasPermission: async (o) => granted.has(o) },
            );
          }
          case 'CIRA/SAVE_CONTEXT':
            fake.saves.push(msg);
            return saveConversationAsPco(msg.conversation, { store: fake.store, client: CLIENT }, msg.selection, msg.draft);
          case 'CIRA/SYNC_CONTEXT':
            return resyncStoredPco(msg.id, { store: fake.store });
          case 'CIRA/STAGE_RELAY':
            fake.staged.push(msg);
            return { ok: true };
          default:
            return undefined;
        }
      }),
    },
    permissions: {
      request: vi.fn(async ({ origins }: { origins: string[] }) => {
        fake.requested.push(...origins);
        if (fake.grant) for (const o of origins) granted.add(o);
        return fake.grant;
      }),
    },
    tabs: {
      query: vi.fn(async () => [{ id: TAB_ID, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000010' }]),
      get: vi.fn(async () => ({ id: TAB_ID, url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000010' })),
      sendMessage: vi.fn(async (_tab: number, msg: RuntimeMessage) => {
        if (msg.type === 'CIRA/PING') return { type: 'CIRA/PONG', source: 'chatgpt' };
        if (msg.type === 'CIRA/EXTRACT_REQUEST') return { type: 'CIRA/EXTRACT_RESPONSE', conversation: JSON.parse(JSON.stringify(fake.conversation)) };
        return undefined;
      }),
      create: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
      onActivated: listeners,
      onUpdated: listeners,
    },
    scripting: { executeScript: vi.fn(async () => []) },
    storage: { local: area(fake.local), session: area(fake.session) },
  });
}

// ------------------------------------------------------------------ DOM helpers
const $$ = <T extends Element = HTMLElement>(sel: string) => [...container.querySelectorAll<T>(sel)];
const text = () => container.textContent ?? '';
const button = (label: string | RegExp) =>
  $$<HTMLButtonElement>('button').find((b) => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? '')));

async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeout = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}\n${text().slice(0, 2000)}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}
async function click(el: Element | undefined | null, what = 'element') {
  if (!el) throw new Error(`missing ${what}\n${text().slice(0, 2000)}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
}
async function choose(select: HTMLSelectElement | null, value: string) {
  if (!select) throw new Error(`missing select\n${text().slice(0, 2000)}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function fill(input: HTMLInputElement | undefined | null, value: string) {
  if (!input) throw new Error(`missing input\n${text().slice(0, 2000)}`);
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.blur();
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}
const modeSelect = () => container.querySelector<HTMLSelectElement>('#cp-mode-select');
const messageRows = () => $$('ul[aria-label="Conversation messages"] > li');
const itemRows = () => $$('ul[aria-label="Extracted context items"] > li');
const rowFor = (n: number) => messageRows().find((li) => new RegExp(`#${n}(?!\\d)`).test(li.textContent ?? ''));
const checkboxOf = (li: Element | undefined) => li?.querySelector<HTMLInputElement>('input[type="checkbox"]');
const itemRow = (s: string) => itemRows().find((li) => li.textContent?.includes(s));

async function readChat() {
  await click(await waitFor(() => { const b = button('Read chat'); return b && !b.disabled ? b : null; }, 'Read chat button'), 'Read chat');
  await waitFor(() => messageRows().length === 10, 'message rows');
}

/** Messages #2, #5, #7, #9 (indexes 1, 4, 6, 8). */
async function selectFour() {
  await click(button('Clear all'));
  for (const n of [2, 5, 7, 9]) await click(checkboxOf(rowFor(n)), `#${n}`);
  await waitFor(() => text().includes('Selected 4 / 10 messages'), '4 selected');
}

function seedSettings(mode: 'deterministic' | 'semantic' | 'hybrid', model = 'qwen2.5:7b') {
  fake.local.set(SETTINGS_KEY, { extractionMode: mode, provider: { preset: 'ollama', baseUrl: OLLAMA_BASE_URL, model } });
}

async function mount() {
  await act(async () => {
    root.render(<SidePanel />);
  });
}

beforeEach(() => {
  installChrome();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('side panel semantic integration', () => {
  it('Deterministic is the default: no provider, no permission request, nothing sent', async () => {
    await mount();
    await readChat();
    expect(modeSelect()!.value).toBe('deterministic');
    expect(text()).toContain('Fast, private, no AI model required.');
    expect(text()).toContain('Nothing is sent to an AI provider.');
    expect(button('Model')).toBeUndefined(); // provider settings only for Semantic / Hybrid
    await click(button('Continue to Review'));
    await waitFor(() => itemRows().length > 0, 'items');
    expect(container.querySelector('.cp-origin')).toBeNull();
    expect(fake.builds).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(fake.requested).toHaveLength(0);
  });

  it('Semantic: 10 messages → select 4 → provider receives exactly 4 → review with badges → remove → save & send', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const good = fakeOpenAI();
    useProvider();
    fake.transport = async (req) => {
      await gate;
      return good.transport(req);
    };
    fake.calls = good.calls;
    await mount();
    await readChat();
    await selectFour();

    await choose(modeSelect(), 'semantic');
    expect(text()).toContain('Uses an AI model to identify important context.');
    expect(text()).toContain('Processing locally with Ollama.');
    expect((fake.local.get(SETTINGS_KEY) as { extractionMode: string }).extractionMode).toBe('semantic');
    expect(fake.builds).toHaveLength(0); // changing the mode never calls a model

    // No model configured yet: explicit, recoverable error; the model form opens.
    await click(button('Continue to Review'));
    await waitFor(() => text().includes('Semantic extraction unavailable.'), 'not-configured banner');
    expect(text()).toContain('Enter the model name');
    expect(fake.builds).toHaveLength(0);
    expect(text()).toContain('Selected 4 / 10 messages');

    await fill(container.querySelector<HTMLInputElement>('#cp-provider input[type="text"]'), 'qwen2.5:7b');
    expect((fake.local.get(SETTINGS_KEY) as { provider: { model: string } }).provider.model).toBe('qwen2.5:7b');

    await click(button('Continue to Review'));
    await waitFor(() => text().includes('Extracting context… Using semantic model…'), 'semantic loading label');
    expect(fake.requested).toEqual(['http://127.0.0.1/*']);
    release();
    await waitFor(() => itemRows().length > 0, 'semantic items');

    // Exactly the 4 selected messages reached the provider.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].sent.map((m) => m.content)).toEqual([1, 4, 6, 8].map((i) => fake.conversation.messages[i].content));
    const wire = JSON.stringify(fake.calls[0].body);
    for (const i of [0, 2, 3, 5, 7, 9]) expect(wire).not.toContain(fake.conversation.messages[i].content);

    // Origin badges: an assistant idea never looks like a user requirement.
    expect(itemRow('MongoDB')!.querySelector('.cp-origin')!.textContent).toBe('Assistant suggestion');
    expect(itemRow('Firebase')!.querySelector('.cp-origin')!.textContent).toBe('User');
    expect(itemRow('Firebase')!.textContent).toContain('model');
    expect(text()).toContain('Semantic extraction · qwen2.5:7b on 127.0.0.1:11434 (local)');

    // Remove one item; review cannot be skipped (Continue → Send step).
    await click(checkboxOf(itemRow('deadline')), 'deadline item');
    await click(button('Continue'));
    await click(await waitFor(() => container.querySelector('input[type="radio"][value="claude"]'), 'Claude'));
    await click(button(/Save & send to Claude/));
    await waitFor(() => text().includes('Context ready'), 'success');

    expect(fake.calls).toHaveLength(1); // saving and sending did not call the model again
    const [save] = fake.saves;
    expect(save.draft).toBeDefined();
    expect(save.selection?.messageIndexes).toEqual([1, 4, 6, 8]);
    const doc = (await fake.store.get((await fake.store.list())[0].id)) as PCODocument;
    expect(validate(doc).ok).toBe(true);
    expect(validateSemanticExtension(doc)).toEqual([]);
    expect(getSemanticExtension(doc)?.mode).toBe('semantic');
    expect(doc.items).toHaveLength(3);
    expect(JSON.stringify(doc.items)).not.toContain('deadline');
    expect(doc.conversations[0].turns.map((t) => t.index)).toEqual([1, 4, 6, 8]);

    const [staged] = fake.staged;
    expect(staged.payload.conversation.messages).toEqual([1, 4, 6, 8].map((i) => fake.conversation.messages[i]));
    expect(staged.payload.summary).toContain('PROPOSED: MongoDB may be easier for a document-heavy app (assistant suggestion, not confirmed by the user)');
    expect(staged.payload.summary).not.toContain('deadline');
    expect(staged.payload.summary).not.toContain('Fly.io');

    // Edit reopens the same semantic draft, without calling the model.
    await click(button('Start a new context'));
    await click(await waitFor(() => button('Edit'), 'Edit'));
    await waitFor(() => itemRows().length === 4, 'review from edit');
    expect(checkboxOf(itemRow('deadline'))!.checked).toBe(false);
    expect(itemRow('MongoDB')!.querySelector('.cp-origin')!.textContent).toBe('Assistant suggestion');
    expect(fake.calls).toHaveLength(1);
    expect((fake.local.get(ACTIVE_CONTEXT_KEY) as { mode: string }).mode).toBe('semantic');
  });

  it('failure: "Semantic extraction unavailable." with Retry and Switch to Deterministic; selection is kept', async () => {
    seedSettings('semantic');
    useProvider({ status: 503, body: '' });
    await mount();
    await readChat();
    await waitFor(() => modeSelect()?.value === 'semantic', 'stored mode');
    await selectFour();

    await click(button('Continue to Review'));
    await waitFor(() => text().includes('Semantic extraction unavailable.'), 'error banner');
    expect(text()).toContain('HTTP 503');
    expect(text()).toContain('Your message selection is unchanged.');
    expect(fake.calls).toHaveLength(1);
    expect(text()).toContain('Selected 4 / 10 messages');

    await click(button(/Retry/));
    await waitFor(() => fake.calls.length === 2, 'retry call');
    await waitFor(() => text().includes('Semantic extraction unavailable.'), 'still failing');

    await click(button('Switch to Deterministic'));
    await waitFor(() => itemRows().length > 0, 'deterministic review');
    expect(fake.calls).toHaveLength(2);
    expect(container.querySelector('.cp-origin')).toBeNull();
    expect(text()).toMatch(/Messages selected\s*4 \/ 10/);
    expect((fake.local.get(SETTINGS_KEY) as { extractionMode: string }).extractionMode).toBe('deterministic');
    expect(text()).not.toContain('Semantic extraction unavailable.');
  });

  it('permission denied: nothing is sent', async () => {
    seedSettings('semantic');
    fake.grant = false;
    await mount();
    await readChat();
    await waitFor(() => modeSelect()?.value === 'semantic', 'stored mode');
    await click(button('Continue to Review'));
    await waitFor(() => text().includes('Semantic extraction unavailable.'), 'error banner');
    expect(text()).toContain('was not granted, so nothing was sent');
    expect(fake.builds).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('Hybrid fallback is announced (never silent) and the deterministic items can still be saved', async () => {
    seedSettings('hybrid');
    useProvider(() => chatCompletion('not json at all'));
    await mount();
    await readChat();
    await waitFor(() => modeSelect()?.value === 'hybrid', 'stored mode');
    await selectFour();
    await click(button('Continue to Review'));
    await waitFor(() => itemRows().length > 0, 'fallback review');
    expect(text()).toContain('Semantic extraction unavailable: showing deterministic results only.');
    expect(text()).toContain("did not match CIRA's context schema");
    expect(button(/Retry semantic/)).toBeTruthy();

    await click(button('Continue'));
    await click(await waitFor(() => button('Save context'), 'Save context'));
    await waitFor(() => text().includes('Context ready'), 'success');
    const doc = (await fake.store.get((await fake.store.list())[0].id)) as PCODocument;
    expect(validate(doc).ok).toBe(true);
    expect(getSemanticExtension(doc)).toMatchObject({ mode: 'hybrid', fallback: true });
    expect(fake.calls).toHaveLength(1);
  });

  it('Retry semantic after a hybrid fallback calls the model again and replaces the draft', async () => {
    seedSettings('hybrid');
    let fail = true;
    const good = fakeOpenAI();
    useProvider();
    fake.transport = async (req) => (fail ? { status: 500, body: '' } : good.transport(req));
    await mount();
    await readChat();
    await waitFor(() => modeSelect()?.value === 'hybrid', 'stored mode');
    await selectFour();
    await click(button('Continue to Review'));
    await waitFor(() => text().includes('showing deterministic results only'), 'fallback');
    fail = false;
    await click(button(/Retry semantic/));
    await waitFor(() => !text().includes('showing deterministic results only') && itemRow('MongoDB'), 'hybrid items');
    expect(good.calls).toHaveLength(1);
    expect(itemRow('MongoDB')!.querySelector('.cp-origin')!.textContent).toBe('Assistant suggestion');
  });
});
