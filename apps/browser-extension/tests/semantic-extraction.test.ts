/**
 * Phase 02C: semantic / hybrid drafts built by the service worker, and saving
 * a reviewed draft without re-extracting.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryArea,
  getSemanticExtension,
  ProviderError,
  SEMANTIC_EXTENSION,
  validate,
  validateSemanticExtension,
  type PCODocument,
} from '@cira/core';
import { saveConversationAsPco } from '@/background/context-pipeline';
import { buildSemanticDraft, type BuildDraftSuccess, type DraftDeps } from '@/background/extraction';
import { applyItemSelection, buildPcoHandoff, buildSelectedContext, SELECTION_EXTENSION } from '@/shared/context-selection';
import { OLLAMA_BASE_URL, providerOriginPattern, type ProviderSettings } from '@/shared/extraction-settings';
import { ChromeContextStore } from '@/storage/chrome-context-store';
import { chatCompletion, fakeOpenAI, tenMessageConversation } from './helpers/fake-provider';

const CLIENT = 'cira-browser-extension@0.1.0';
const NOW = () => new Date('2026-09-30T12:00:00.000Z');
const OLLAMA: ProviderSettings = { preset: 'ollama', baseUrl: OLLAMA_BASE_URL, model: 'qwen2.5:7b' };
const REMOTE: ProviderSettings = { preset: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'gpt-x' };
const SELECTED = [1, 4, 6, 8];

function deps(over: Partial<DraftDeps> = {}): DraftDeps {
  return { client: CLIENT, provider: OLLAMA, now: NOW, ...over };
}

async function okDraft(mode: 'semantic' | 'hybrid', over: Partial<DraftDeps> = {}) {
  const conv = tenMessageConversation();
  const fake = fakeOpenAI();
  const r = await buildSemanticDraft(conv, { messageIndexes: SELECTED, mode }, deps({ transport: fake.transport, ...over }));
  if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
  return { conv, fake, r };
}

describe('semantic draft (service worker)', () => {
  it('10 messages, 4 selected: the provider receives exactly those 4 and nothing else', async () => {
    const { conv, fake, r } = await okDraft('semantic');
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(call.sent.map((m) => m.ref)).toEqual(['m1', 'm4', 'm6', 'm8']);
    expect(call.sent.map((m) => m.content)).toEqual(SELECTED.map((i) => conv.messages[i].content));
    const wire = JSON.stringify(call.body);
    conv.messages.forEach((m, i) => {
      if (!SELECTED.includes(i)) expect(wire).not.toContain(m.content);
    });
    expect(wire).not.toContain(conv.title); // title and URL are not sent either
    expect(wire).not.toContain(conv.url);
    expect(call.headers.authorization).toBeUndefined(); // no key configured

    expect(r.selectedMessages).toBe(4);
    expect(r.fallback).toBe(false);
    expect(r.provider).toEqual({ host: '127.0.0.1:11434', locality: 'local', model: 'qwen2.5:7b' });
  });

  it('returns a valid PCO v0.1 draft with origin-annotated, evidence-backed items from the selected turns only', async () => {
    const { r } = await okDraft('semantic');
    const doc = r.draft;
    expect(validate(doc).ok).toBe(true);
    expect(validateSemanticExtension(doc)).toEqual([]);
    expect(doc.conversations[0].turns.map((t) => t.index)).toEqual(SELECTED);
    const ext = getSemanticExtension(doc)!;
    expect(ext.mode).toBe('semantic');
    expect(ext.extractors.map((e) => e.kind)).toEqual(['semantic']);
    expect(ext.extractors[0].locality).toBe('local');
    expect(doc.items.length).toBe(4);
    const suggestion = doc.items.find((i) => i.content.includes('MongoDB'))!;
    expect(ext.items[suggestion.id]).toMatchObject({ origin: 'assistant', assertion: 'suggested' });
    expect(suggestion).toMatchObject({ type: 'decision', status: 'proposed' });
    const firebase = doc.items.find((i) => i.content.includes('Firebase'))!;
    expect(ext.items[firebase.id]).toMatchObject({ origin: 'user', assertion: 'explicit' });
    expect(doc.extensions?.[SELECTION_EXTENSION]).toEqual({
      selection: { message_indexes: SELECTED, total_messages: 10, extracted_items: 4, selected_items: 4 },
    });
  });

  it('hybrid reconciles rules + model and records both extractors', async () => {
    const { r } = await okDraft('hybrid');
    const ext = getSemanticExtension(r.draft)!;
    expect(ext.mode).toBe('hybrid');
    expect(ext.extractors.map((e) => e.kind).sort()).toEqual(['deterministic', 'semantic']);
    expect(ext.fallback).toBeUndefined();
    expect(validate(r.draft).ok).toBe(true);
  });

  it('hybrid falls back to deterministic explicitly (fallback flag + reason), with the same items as Deterministic', async () => {
    const conv = tenMessageConversation();
    const fake = fakeOpenAI({ status: 500, body: '{"error":{"message":"model crashed"}}' });
    const r = (await buildSemanticDraft(conv, { messageIndexes: SELECTED, mode: 'hybrid' }, deps({ transport: fake.transport }))) as BuildDraftSuccess;
    expect(r.ok).toBe(true);
    expect(r.fallback).toBe(true);
    expect(r.fallbackReason).toContain('HTTP 500');
    expect(getSemanticExtension(r.draft)?.fallback).toBe(true);
    const det = buildSelectedContext(conv, { messageIndexes: SELECTED }, { client: CLIENT, now: NOW() }).draft;
    expect(r.draft.items.map((i) => [i.type, i.content])).toEqual(det.items.map((i) => [i.type, i.content]));
  });

  const failures: Array<[string, Parameters<typeof fakeOpenAI>[0] | 'throw-timeout' | 'throw-network', string, RegExp]> = [
    ['timeout', 'throw-timeout', 'timeout', /did not answer/],
    ['provider unavailable', 'throw-network', 'unreachable', /Is Ollama .* running/],
    ['401', { status: 401, body: '{"error":{"message":"bad key"}}' }, 'unauthorized', /Check the API key/],
    ['403 from local Ollama', { status: 403, body: '' }, 'forbidden', /OLLAMA_ORIGINS/],
    ['non-JSON HTTP body', { status: 200, body: '<html>oops</html>' }, 'invalid_output', /did not match/],
    ['model returned invalid JSON', chatCompletion('{"items": [ oops'), 'invalid_output', /did not match/],
    ['model output fails the schema', chatCompletion('{"items":[{"ref":"i1","type":"wish"}],"relations":[]}'), 'invalid_output', /did not match/],
  ];
  for (const [name, reply, code, message] of failures) {
    it(`semantic mode reports "${name}" as ${code} without conversation text`, async () => {
      const conv = tenMessageConversation();
      const fake =
        reply === 'throw-timeout' || reply === 'throw-network'
          ? {
              transport: async () => {
                throw new ProviderError(reply === 'throw-timeout' ? 'timeout' : 'network', 'x');
              },
            }
          : fakeOpenAI(reply);
      const r = await buildSemanticDraft(conv, { messageIndexes: SELECTED, mode: 'semantic' }, deps({ transport: fake.transport }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe(code);
      expect(r.error).toMatch(message);
      for (const m of conv.messages) expect(r.error).not.toContain(m.content);
    });
  }

  it('refuses without contacting anyone when the provider is not configured or access was not granted', async () => {
    const conv = tenMessageConversation();
    const fake = fakeOpenAI();
    const noModel = await buildSemanticDraft(conv, { messageIndexes: SELECTED, mode: 'semantic' }, deps({ provider: { ...OLLAMA, model: '' }, transport: fake.transport }));
    expect(noModel).toMatchObject({ ok: false, code: 'not_configured' });
    const plainHttpRemote = await buildSemanticDraft(conv, { messageIndexes: SELECTED, mode: 'hybrid' }, deps({ provider: { ...REMOTE, baseUrl: 'http://api.example.com/v1' }, transport: fake.transport }));
    expect(plainHttpRemote).toMatchObject({ ok: false, code: 'not_configured' });
    const asked: string[] = [];
    const denied = await buildSemanticDraft(conv, { messageIndexes: SELECTED, mode: 'semantic' }, deps({ transport: fake.transport, hasPermission: async (o) => (asked.push(o), false) }));
    expect(denied).toMatchObject({ ok: false, code: 'permission' });
    expect(asked).toEqual(['http://127.0.0.1/*']);
    const empty = await buildSemanticDraft(conv, { messageIndexes: [], mode: 'semantic' }, deps({ transport: fake.transport }));
    expect(empty).toMatchObject({ ok: false, code: 'selection' });
    expect(fake.calls).toHaveLength(0);
  });

  it('remote providers: sends the API key only as a header, and never receives selected messages that look like secrets', async () => {
    const conv = tenMessageConversation();
    const fake = fakeOpenAI();
    const r = await buildSemanticDraft(conv, { messageIndexes: SELECTED, mode: 'semantic' }, deps({ provider: REMOTE, apiKey: 'sk-test-key', transport: fake.transport, hasPermission: async () => true }));
    expect(r.ok).toBe(true);
    expect(fake.calls[0].url).toBe('https://api.example.com/v1/chat/completions');
    expect(fake.calls[0].headers.authorization).toBe('Bearer sk-test-key');
    expect(JSON.stringify((r as BuildDraftSuccess).draft)).not.toContain('sk-test-key');
    expect((r as BuildDraftSuccess).provider.locality).toBe('remote');

    conv.messages[4].content = 'My token is ghp_Zq7rT2mW9xK4vB8nL3pY6cH1sD5fG0jA2eRu, do not use Firebase.';
    const blocked = await buildSemanticDraft(conv, { messageIndexes: SELECTED, mode: 'semantic' }, deps({ provider: REMOTE, transport: fake.transport, hasPermission: async () => true }));
    expect(blocked).toMatchObject({ ok: false, code: 'secrets' });
    expect(fake.calls).toHaveLength(1);
  });

  it('asks for exactly one origin (ports ignored by match patterns)', () => {
    expect(providerOriginPattern('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1/*');
    expect(providerOriginPattern('http://localhost:1234/v1')).toBe('http://localhost/*');
    expect(providerOriginPattern('https://api.example.com/v1')).toBe('https://api.example.com/*');
    expect(providerOriginPattern('not a url')).toBeNull();
  });
});

describe('saving a reviewed semantic draft', () => {
  async function save(draft: PCODocument, conv = tenMessageConversation(), itemIds?: string[], messageIndexes = SELECTED) {
    const store = new ChromeContextStore(createMemoryArea());
    const r = await saveConversationAsPco(conv, { store, client: CLIENT, now: NOW }, { messageIndexes, ...(itemIds ? { itemIds } : {}) }, draft);
    return { r, store };
  }

  it('keeps the reviewed items (no re-extraction), drops removed items with their annotations, keeps cira.semantic', async () => {
    const { r: built, fake } = await okDraft('semantic');
    const draft = built.draft;
    const removed = draft.items.find((i) => i.content.includes('MongoDB'))!;
    const kept = draft.items.filter((i) => i.id !== removed.id).map((i) => i.id);
    const { r, store } = await save(draft, undefined, kept);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fake.calls).toHaveLength(1); // saving did not call the model again
    const doc = (await store.get(r.id))!;
    expect(validate(doc).ok).toBe(true);
    expect(validateSemanticExtension(doc)).toEqual([]);
    expect(doc.items.map((i) => i.id)).toEqual(kept);
    const ext = getSemanticExtension(doc)!;
    expect(Object.keys(ext.items).sort()).toEqual([...kept].sort());
    // The turn stays (it was selected); the removed item and its annotation are gone.
    expect(JSON.stringify(doc.items)).not.toContain('MongoDB');
    expect(ext.items[removed.id]).toBeUndefined();
    expect((doc.extensions?.[SELECTION_EXTENSION] as { selection: { selected_items: number } }).selection.selected_items).toBe(3);
  });

  it('rejects a draft that does not match the selection or contains unselected messages', async () => {
    const { r: built } = await okDraft('semantic');
    const other = await save(built.draft, undefined, undefined, [1, 4, 6]);
    expect(other.r).toMatchObject({ ok: false });
    expect((other.r as { error: string }).error).toMatch(/does not match the selected messages/);

    const tampered: PCODocument = JSON.parse(JSON.stringify(built.draft));
    tampered.conversations[0].turns[0] = { ...tampered.conversations[0].turns[0], index: 0 };
    const bad = await save(tampered);
    expect(bad.r).toMatchObject({ ok: false });

    const unknown = await save(built.draft, undefined, ['nope']);
    expect((unknown.r as { error: string }).error).toMatch(/Unknown context item/);
  });

  it('the relay text marks assistant suggestions so they never read as user requirements', async () => {
    const { conv, r } = await okDraft('semantic');
    const text = buildPcoHandoff(applyItemSelection(r.draft, r.draft.items.map((i) => i.id)), { source: conv.source, title: conv.title });
    expect(text).toMatch(/PROPOSED: MongoDB may be easier for a document-heavy app \(assistant suggestion, not confirmed by the user\)/);
    expect(text).toMatch(/MUST NOT: Do not use Firebase(?! \()/);
    expect(text).toContain('were ideas from the previous assistant');
    expect(r.draft.extensions?.[SEMANTIC_EXTENSION]).toBeDefined();
  });

  it('deterministic handoff text is unchanged (no attribution markers)', () => {
    const conv = tenMessageConversation();
    const { document } = buildSelectedContext(conv, { messageIndexes: SELECTED }, { client: CLIENT, now: NOW() });
    const text = buildPcoHandoff(document, { source: conv.source });
    expect(text).not.toMatch(/assistant suggestion|PROPOSED|previous assistant/);
  });
});
