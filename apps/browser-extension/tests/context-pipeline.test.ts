/**
 * Browser connector pipeline: captured Conversation → PCO → validate →
 * safety scan → ContextStore → local sync. Runs outside Chrome with Core's
 * in-memory key/value area standing in for chrome.storage.local.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryArea, validate, type PCODocument } from '@cira/core';
import { resyncStoredPco, saveConversationAsPco } from '@/background/context-pipeline';
import { describeSaveResult } from '@/shared/context-client';
import { buildSelectedContext } from '@/shared/context-selection';
import { selectionConversation } from './helpers/selection-conversation';
import { ChromeContextStore } from '@/storage/chrome-context-store';
import type { Conversation } from '@/shared/schema';

const load = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../packages/core/tests/fixtures', `${name}.json`), 'utf8')) as Conversation;

const CLIENT = 'cira-browser-extension@0.1.0';

describe('browser capture → PCO pipeline', () => {
  it('encodes, validates, stores and syncs a captured conversation', async () => {
    const area = createMemoryArea();
    const store = new ChromeContextStore(area);
    const sync = vi.fn(async (doc: PCODocument) => ({ status: 'synced' as const, path: `/home/u/.cira/contexts/${doc.id}.pco.json` }));

    const r = await saveConversationAsPco(load('legacy/chatgpt-popup-export'), { store, sync, client: CLIENT, now: () => new Date('2026-09-29T12:00:00Z') });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validate(r.document).ok).toBe(true);
    expect(r.document.conversations[0].source).toEqual({ kind: 'browser', platform: 'chatgpt', client: CLIENT });
    expect(r.document.metadata.created_by).toEqual({ agent: CLIENT });
    expect(await store.get(r.id)).toEqual(r.document);
    expect((await store.list()).map((s) => s.id)).toEqual([r.id]);
    expect(Object.keys(area.dump())).toContain(`cira.pco.doc.${r.id}`);
    expect(sync).toHaveBeenCalledWith(r.document);
    expect(r.sync).toEqual({ status: 'synced', path: expect.stringContaining(r.id) });
    expect(describeSaveResult(r).text).toMatch(/^PCO saved to .+\.pco\.json · \d+ context items$/);
  });

  it('still saves in the browser when the local host is not installed', async () => {
    const store = new ChromeContextStore(createMemoryArea());
    const r = await saveConversationAsPco(load('decisions'), {
      store,
      client: CLIENT,
      sync: async () => ({ status: 'host_unavailable', message: 'Specified native messaging host not found.' }),
    });
    expect(r.ok && r.sync.status).toBe('host_unavailable');
    expect(await store.list()).toHaveLength(1);
    expect(describeSaveResult(r).text).toContain('cira native-host install');
  });

  it('warns explicitly when the conversation contains a potential secret', async () => {
    const conv = load('decisions');
    const token = ['ghp', '_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('');
    conv.messages.push({ role: 'user', content: `deploy with ${token}` });
    const r = await saveConversationAsPco(conv, { store: new ChromeContextStore(createMemoryArea()), client: CLIENT });
    expect(r.ok && r.safety.hasFindings).toBe(true);
    const status = describeSaveResult(r);
    expect(status.level).toBe('warn');
    expect(status.text).toMatch(/WARNING: \d+ potential secret/);
  });

  it('re-capturing the same chat updates the same PCO', async () => {
    const store = new ChromeContextStore(createMemoryArea());
    const conv = load('technical-project');
    const a = await saveConversationAsPco(conv, { store, client: CLIENT });
    conv.messages.push({ role: 'user', content: 'We decided to use Postgres for sessions.' });
    const b = await saveConversationAsPco({ ...conv, capturedAt: '2026-09-22T08:30:00.000Z' }, { store, client: CLIENT });
    expect(a.ok && b.ok && a.id === b.id).toBe(true);
    expect(await store.list()).toHaveLength(1);
    const stored = await store.get(a.ok ? a.id : '');
    expect(stored?.conversations[0].turns).toHaveLength(4);
  });

  it('with a selection: stores and syncs only the selected messages and items', async () => {
    const area = createMemoryArea();
    const store = new ChromeContextStore(area);
    const sync = vi.fn(async (doc: PCODocument) => ({ status: 'synced' as const, path: `/home/u/.cira/contexts/${doc.id}.pco.json` }));
    const conv = selectionConversation();
    const { draft } = buildSelectedContext(conv, { messageIndexes: [0, 2] }, { client: CLIENT });
    const itemIds = draft.items.filter((i) => i.content !== 'Do not use Firebase.').map((i) => i.id);

    const r = await saveConversationAsPco(conv, { store, sync, client: CLIENT }, { messageIndexes: [0, 2], itemIds });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validate(r.document).ok).toBe(true);
    expect(r.document.conversations[0].turns.map((t) => t.index)).toEqual([0, 2]);
    expect(r.document.items.map((i) => i.id)).toEqual(itemIds);
    expect(JSON.stringify(r.document.items)).not.toContain('Firebase');
    expect(sync).toHaveBeenCalledWith(r.document);
    expect(await store.get(r.id)).toEqual(r.document);
  });

  it('with a selection: reports empty selections and stale item IDs as failures', async () => {
    const store = new ChromeContextStore(createMemoryArea());
    const conv = selectionConversation();
    expect(await saveConversationAsPco(conv, { store, client: CLIENT }, { messageIndexes: [] })).toEqual({ ok: false, error: 'Select at least one message to continue.' });
    const stale = await saveConversationAsPco(conv, { store, client: CLIENT }, { messageIndexes: [0], itemIds: ['itm_gone'] });
    expect(stale.ok).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('retry sync re-sends the stored PCO to the local host', async () => {
    const store = new ChromeContextStore(createMemoryArea());
    const r = await saveConversationAsPco(load('decisions'), { store, client: CLIENT, sync: async () => ({ status: 'error', message: 'Failed to start native messaging host.' }) });
    expect(r.ok && r.sync.status).toBe('error');
    const sync = vi.fn(async (doc: PCODocument) => ({ status: 'synced' as const, path: `/x/${doc.id}.pco.json` }));
    expect(await resyncStoredPco(r.ok ? r.id : '', { store, sync })).toEqual({ status: 'synced', path: expect.stringContaining('.pco.json') });
    expect(await resyncStoredPco('pco_missing', { store, sync })).toMatchObject({ status: 'error' });
  });

  it('reports a failure instead of throwing on malformed input', async () => {
    const r = await saveConversationAsPco({ source: 'chatgpt' } as unknown as Conversation, { store: new ChromeContextStore(createMemoryArea()), client: CLIENT });
    expect(r.ok).toBe(false);
  });
});
