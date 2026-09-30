// @vitest-environment happy-dom
/**
 * Side panel end to end (real React components, real reducer, real service
 * worker pipeline; chrome.* and the native host are faked):
 *
 *   Read chat → Select (deselect, search, back) → Review (remove an item) →
 *   Send (save + relay) → Context ready
 *
 * Checks that only the chosen messages reach the encoder, that removed items
 * never reach the saved PCO or the text injected into the target AI, and
 * that "select everything" matches the Phase 01 full capture.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryArea, migrateLegacyConversation, validate, type PCODocument } from '@cira/core';
import { resyncStoredPco, saveConversationAsPco, type SyncResult } from '@/background/context-pipeline';
import { buildPcoHandoff } from '@/shared/context-selection';
import type { RuntimeMessage } from '@/shared/messaging';
import type { Conversation } from '@/shared/schema';
import { ChromeContextStore } from '@/storage/chrome-context-store';
import { SidePanel } from '@/sidepanel/SidePanel';
import { ACTIVE_CONTEXT_KEY } from '@/sidepanel/hooks/useWorkspace';
import { selectionConversation } from './helpers/selection-conversation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLIENT = 'cira-browser-extension@0.1.0';
const TAB_ID = 7;

interface Fake {
  conversation: Conversation | null;
  extractError?: string;
  sync: () => Promise<SyncResult>;
  saves: Array<Extract<RuntimeMessage, { type: 'CIRA/SAVE_CONTEXT' }>>;
  staged: Array<Extract<RuntimeMessage, { type: 'CIRA/STAGE_RELAY' }>>;
  opened: string[];
  local: Map<string, unknown>;
  store: ChromeContextStore;
}

let fake: Fake;
let root: Root;
let container: HTMLElement;

function installChrome(): void {
  const store = new ChromeContextStore(createMemoryArea());
  fake = {
    conversation: selectionConversation(),
    sync: async () => ({ status: 'synced', path: 'C:\\Users\\u\\.cira\\contexts\\x.pco.json' }),
    saves: [],
    staged: [],
    opened: [],
    local: new Map(),
    store,
  };
  const listeners = { addListener: () => {}, removeListener: () => {} };
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ version: '0.1.0', content_scripts: [{ js: ['content.js'] }] }),
      sendMessage: vi.fn(async (msg: RuntimeMessage) => {
        switch (msg.type) {
          case 'CIRA/SAVE_CONTEXT':
            fake.saves.push(msg);
            // The real service-worker pipeline, with the native host faked.
            return saveConversationAsPco(msg.conversation, { store: fake.store, client: CLIENT, sync: () => fake.sync() }, msg.selection);
          case 'CIRA/SYNC_CONTEXT':
            return resyncStoredPco(msg.id, { store: fake.store, sync: () => fake.sync() });
          case 'CIRA/STAGE_RELAY':
            fake.staged.push(msg);
            return { ok: true };
          default:
            return undefined;
        }
      }),
    },
    tabs: {
      query: vi.fn(async () => [{ id: TAB_ID, url: 'https://chatgpt.com/c/7f3e2a10-5b4c-4d8e-9a61-0c2b3d4e5f60' }]),
      get: vi.fn(async () => ({ id: TAB_ID, url: 'https://chatgpt.com/c/7f3e2a10-5b4c-4d8e-9a61-0c2b3d4e5f60' })),
      sendMessage: vi.fn(async (_tab: number, msg: RuntimeMessage) => {
        if (msg.type === 'CIRA/PING') return { type: 'CIRA/PONG', source: 'chatgpt' };
        if (msg.type === 'CIRA/EXTRACT_REQUEST') {
          if (fake.extractError) return { type: 'CIRA/EXTRACT_ERROR', error: fake.extractError };
          return { type: 'CIRA/EXTRACT_RESPONSE', conversation: JSON.parse(JSON.stringify(fake.conversation)) };
        }
        return undefined;
      }),
      create: vi.fn(async ({ url }: { url: string }) => void fake.opened.push(url)),
      reload: vi.fn(async () => {}),
      onActivated: listeners,
      onUpdated: listeners,
    },
    scripting: { executeScript: vi.fn(async () => []) },
    storage: {
      local: {
        get: vi.fn(async (k: string) => (fake.local.has(k) ? { [k]: fake.local.get(k) } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) fake.local.set(k, JSON.parse(JSON.stringify(v)));
        }),
        remove: vi.fn(async (k: string) => void fake.local.delete(k)),
      },
    },
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
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}\n${text().slice(0, 1500)}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}
async function click(el: Element | undefined | null, what = 'element') {
  if (!el) throw new Error(`missing ${what}\n${text().slice(0, 1500)}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const messageRows = () => $$('ul[aria-label="Conversation messages"] > li');
const itemRows = () => $$('ul[aria-label="Extracted context items"] > li');
const rowFor = (n: number) => messageRows().find((li) => li.textContent?.includes(`#${n}`));
const checkboxOf = (li: Element | undefined) => li?.querySelector<HTMLInputElement>('input[type="checkbox"]');
const checkedNumbers = () => messageRows().filter((li) => checkboxOf(li)!.checked).map((li) => Number(/#(\d+)/.exec(li.textContent ?? '')![1]));

async function readChat() {
  await click(await waitFor(() => { const b = button('Read chat'); return b && !b.disabled ? b : null; }, 'Read chat button'), 'Read chat');
  await waitFor(() => messageRows().length > 0, 'message rows');
}

beforeEach(async () => {
  installChrome();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SidePanel />);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('side panel context workspace', () => {
  it('select → search → review → remove an item → save & send: only the chosen context is saved and injected', async () => {
    const conv = selectionConversation();
    await readChat();
    expect(fake.saves).toHaveLength(0); // Read chat no longer saves anything
    expect(text()).toContain('Selected 6 / 6 messages');
    expect(text()).toContain('TypeScript React Django Stack');

    // Deselect message 4 (login code) and 6 (Redis).
    await click(checkboxOf(rowFor(4)), '#4');
    await click(checkboxOf(rowFor(6)), '#6');
    expect(checkedNumbers()).toEqual([1, 2, 3, 5]);
    expect(text()).toContain('Selected 4 / 6 messages');

    // Search filters rows without touching the selection.
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await type(search, 'django');
    await waitFor(() => messageRows().length === 1, 'filtered rows');
    expect(rowFor(2)).toBeTruthy();
    expect(text()).toContain('Selected 4 / 6 messages');
    await type(search, '');
    await waitFor(() => messageRows().length === 6, 'all rows again');
    expect(checkedNumbers()).toEqual([1, 2, 3, 5]);

    // Review, then Back keeps the message selection.
    await click(button('Continue to Review'));
    await waitFor(() => itemRows().length > 0, 'context items');
    await click(button(/Back/));
    await waitFor(() => messageRows().length === 6, 'select step');
    expect(checkedNumbers()).toEqual([1, 2, 3, 5]);
    await click(button('Continue to Review'));
    await waitFor(() => itemRows().length > 0, 'context items');

    const items = itemRows().map((li) => li.textContent ?? '');
    expect(items.some((t) => t.includes('Firebase'))).toBe(true);
    expect(items.some((t) => t.includes('Redis') || t.includes('login('))).toBe(false); // deselected messages
    const n = itemRows().length;
    expect(text()).toContain(`Selected ${n} / ${n} context items`);
    expect(text()).toMatch(/Messages selected\s*4 \/ 6/);

    // Remove the Firebase constraint.
    await click(checkboxOf(itemRows().find((li) => li.textContent?.includes('Firebase'))), 'Firebase item');
    expect(text()).toContain(`Selected ${n - 1} / ${n} context items`);

    // Send → Back → Review keeps the removal.
    await click(button('Continue'));
    await waitFor(() => container.querySelector('[role="radiogroup"]'), 'targets');
    await click(button(/Back/));
    await waitFor(() => itemRows().length > 0, 'review again');
    expect(checkboxOf(itemRows().find((li) => li.textContent?.includes('Firebase')))!.checked).toBe(false);
    await click(button('Continue'));
    await waitFor(() => container.querySelector('[role="radiogroup"]'), 'targets');

    expect(fake.saves).toHaveLength(0); // still nothing saved without confirmation
    await click(container.querySelector('input[type="radio"][value="claude"]'), 'Claude');
    await click(button(/Save & send to Claude/));
    await waitFor(() => text().includes('Context ready'), 'success');

    // Saved PCO: only messages 1,2,3,5 (indexes 0,1,2,4) and no Firebase item.
    const [save] = fake.saves;
    expect(save.selection?.messageIndexes).toEqual([0, 1, 2, 4]);
    const stored = (await fake.store.list()).map((s) => s.id);
    expect(stored).toHaveLength(1);
    const doc = (await fake.store.get(stored[0])) as PCODocument;
    expect(validate(doc).ok).toBe(true);
    expect(doc.conversations[0].turns.map((t) => t.index)).toEqual([0, 1, 2, 4]);
    expect(doc.items.every((i) => /_t[0124]$/.test(i.provenance.turn_id ?? ''))).toBe(true);
    expect(JSON.stringify(doc.items)).not.toContain('Firebase');
    expect(doc.items).toHaveLength(n - 1);

    // Relay: the injected text is the reviewed context, never the whole chat.
    const [staged] = fake.staged;
    expect(staged.target).toBe('claude');
    expect(staged.payload.conversation.messages).toEqual([0, 1, 2, 4].map((i) => conv.messages[i]));
    expect(staged.payload.summary).toBe(buildPcoHandoff(doc, { source: 'chatgpt', title: conv.title, capturedAt: staged.payload.conversation.capturedAt }));
    expect(staged.payload.summary).toContain("We'll use Django for the backend.");
    expect(staged.payload.summary).not.toMatch(/Firebase|Redis|login\(/);
    expect(fake.opened).toEqual(['https://claude.ai/new']);

    expect(text()).toContain('4 messages selected');
    expect(text()).toContain(`${n - 1} context items`);
    expect(text()).toContain('Saved locally');
    expect(text()).toContain('Sent to Claude');
    expect((fake.local.get(ACTIVE_CONTEXT_KEY) as { id: string; itemCount: number }).itemCount).toBe(n - 1);
  });

  it('select all → review → continue → save & send matches the Phase 01 full capture', async () => {
    const conv = selectionConversation();
    await readChat();
    await click(button('Continue to Review'));
    await waitFor(() => itemRows().length > 0, 'items');
    await click(button('Continue'));
    await click(await waitFor(() => container.querySelector('input[type="radio"][value="claude"]'), 'Claude'));
    await click(button(/Save & send to Claude/));
    await waitFor(() => text().includes('Context ready'), 'success');

    const doc = (await fake.store.get((await fake.store.list())[0].id))!;
    const legacy = migrateLegacyConversation(conv, { client: CLIENT, createdBy: CLIENT, now: new Date(doc.metadata.created_at) }).document;
    expect(doc.items).toEqual(legacy.items);
    expect(doc.conversations).toEqual(legacy.conversations);
    expect(fake.staged[0].payload.conversation.messages).toEqual(conv.messages);
    for (const item of legacy.items.filter((i) => i.type !== 'code_artifact')) expect(fake.staged[0].payload.summary).toContain(item.content);
  });

  it('save only (no target) stores the context and does not relay', async () => {
    await readChat();
    await click(button('Continue to Review'));
    await waitFor(() => itemRows().length > 0, 'items');
    await click(button('Continue'));
    await click(await waitFor(() => button('Save context'), 'Save context'));
    await waitFor(() => text().includes('Context ready'), 'success');
    expect(fake.staged).toHaveLength(0);
    expect(fake.opened).toHaveLength(0);
    expect(await fake.store.list()).toHaveLength(1);
  });

  it('empty selection and empty extraction block Continue with a clear message', async () => {
    await readChat();
    await click(button('Clear all'));
    expect(button('Continue to Review')!.disabled).toBe(true);
    expect(text()).toContain('Select at least one message to continue.');

    await click(checkboxOf(rowFor(5)), '#5'); // "Can you also add rate limiting?" → a question
    await click(button('Continue to Review'));
    await waitFor(() => itemRows().length === 1, 'one item');
    await click(checkboxOf(itemRows()[0]));
    expect(button('Continue')!.disabled).toBe(true);
    expect(text()).toContain('Select at least one context item.');

    // A message with nothing transferable.
    fake.conversation = { ...selectionConversation(), messages: [{ role: 'assistant', content: 'Sure, happy to help.' }] };
    await click(button(/Back/));
    await click(button('Read chat again') ?? container.querySelector('[aria-label="Menu"]'));
    await click(await waitFor(() => button('Read chat again'), 'menu item'));
    await waitFor(() => messageRows().length === 1, 'new capture');
    await click(button('Continue to Review'));
    await waitFor(() => text().includes('No context items'), 'empty extraction');
    expect(text()).toContain('No transferable context was found in the selected messages.');
    expect(button('Continue')!.disabled).toBe(true);
  });

  it('shows capture errors, and local sync failures with a working Retry', async () => {
    fake.extractError = 'No messages found on this page yet.';
    await click(await waitFor(() => { const b = button('Read chat'); return b && !b.disabled ? b : null; }, 'Read chat'));
    await waitFor(() => container.querySelector('[role="alert"]'), 'error banner');
    expect(text()).toContain('No messages found on this page yet.');

    fake.extractError = undefined;
    fake.sync = async () => ({ status: 'error', message: 'Failed to start native messaging host.' });
    await readChat();
    await click(button('Continue to Review'));
    await waitFor(() => itemRows().length > 0, 'items');
    await click(button('Continue'));
    await click(await waitFor(() => button('Save context'), 'Save context'));
    await waitFor(() => text().includes('Context ready'), 'success');
    expect(text()).toContain('Local sync unavailable');
    expect(text()).toContain('Saved in browser');
    expect(text()).toContain('Failed to start native messaging host.');

    fake.sync = async () => ({ status: 'synced', path: 'C:\\Users\\u\\.cira\\contexts\\x.pco.json' });
    await click(button(/Retry/));
    await waitFor(() => text().includes('Saved locally'), 'retry success');
    expect(text()).not.toContain('Local sync unavailable');
  });

  it('shows the active context card with View / Edit / Clear', async () => {
    await readChat();
    await click(button('Continue to Review'));
    await waitFor(() => itemRows().length > 0, 'items');
    const firstItemText = itemRows()[0].textContent;
    await click(checkboxOf(itemRows()[0]));
    await click(button('Continue'));
    await click(await waitFor(() => button('Save context'), 'Save context'));
    await waitFor(() => text().includes('Context ready'), 'success');

    await click(button('Start a new context'));
    await waitFor(() => container.querySelector('[aria-label="Active context"]'), 'active card');
    expect(text()).toMatch(/Active context.*TypeScript React Django Stack/s);

    await click(button('View'));
    expect(container.querySelector('.cp-active-items')?.children.length).toBeGreaterThan(0);

    await click(button('Edit'));
    await waitFor(() => itemRows().length > 0, 'review from edit');
    expect(checkboxOf(itemRows().find((li) => li.textContent === firstItemText))!.checked).toBe(false);

    await click(button('Clear'));
    await waitFor(() => !container.querySelector('[aria-label="Active context"]'), 'card cleared');
    expect(fake.local.has(ACTIVE_CONTEXT_KEY)).toBe(false);
  });
});
