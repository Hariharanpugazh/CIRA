import { describe, expect, it } from 'vitest';
import {
  createScriptedProvider,
  createSemanticExtractor,
  decode,
  encode,
  extractContext,
  ExtractionError,
  fromLegacyConversation,
  getSemanticExtension,
  renderMarkdown,
  selectTurns,
  TurnSelectionError,
  validate,
  validateSemanticExtension,
  type ConversationInput,
  type ContextExtractor,
  type ExtractionInput,
} from '../../src';
import { loadFixture } from '../helpers';
import { conversationInput, NOW, STACK_MODEL_OUTPUT, STACK_TURNS } from './helpers';

const scripted = (json: unknown) => {
  const provider = createScriptedProvider(typeof json === 'string' ? json : JSON.stringify(json));
  return { provider, extractor: createSemanticExtractor({ provider }) };
};

describe('extraction modes', () => {
  it('deterministic (default) is byte-identical to Phase 01 encode() for every fixture', async () => {
    for (const name of ['simple-conversation', 'technical-project', 'constraints', 'decisions', 'mixed-context', 'legacy/chatgpt-popup-export']) {
      const { input } = fromLegacyConversation(loadFixture(name));
      const r = await extractContext(input, { now: NOW });
      expect(r.mode).toBe('deterministic');
      expect(r.document, name).toEqual(encode(input, { now: NOW }));
      expect(r.document.extensions).toBeUndefined();
    }
  });

  it('deterministic mode never touches a semantic extractor, even if one is configured', async () => {
    const { provider, extractor } = scripted(STACK_MODEL_OUTPUT);
    await extractContext(conversationInput(STACK_TURNS), { semantic: extractor, now: NOW });
    expect(provider.requests).toHaveLength(0);
  });

  it('semantic mode: only semantic items, annotated, valid PCO + valid extension', async () => {
    const { extractor } = scripted(STACK_MODEL_OUTPUT);
    const r = await extractContext(conversationInput(STACK_TURNS), { mode: 'semantic', semantic: extractor, now: NOW });
    expect(validate(r.document).ok).toBe(true);
    expect(validateSemanticExtension(r.document)).toEqual([]);
    expect(r.document.items.every((i) => i.provenance.extracted_by.method === 'model')).toBe(true);
    const ext = getSemanticExtension(r.document)!;
    expect(ext.mode).toBe('semantic');
    expect(ext.extractors).toEqual([{ id: 'cira.semantic', version: '0.1.0', kind: 'semantic', locality: 'local', provider: 'scripted', model: 'scripted' }]);
    expect(Object.keys(ext.items).sort()).toEqual(r.document.items.map((i) => i.id).sort());
  });

  it('hybrid mode: deterministic + semantic, reconciled, both extractors recorded', async () => {
    const { extractor } = scripted(STACK_MODEL_OUTPUT);
    const r = await extractContext(conversationInput(STACK_TURNS), { mode: 'hybrid', semantic: extractor, now: NOW });
    expect(r.fallback).toBe(false);
    expect(validateSemanticExtension(r.document)).toEqual([]);
    const ext = getSemanticExtension(r.document)!;
    expect(ext.extractors.map((e) => e.id)).toEqual(['cira.deterministic', 'cira.semantic']);
    expect(r.reconciliation!.merged).toBeGreaterThan(0);
    // No duplicates of the user's Django constraint.
    const django = r.document.items.filter((i) => i.type === 'constraint' && /django/i.test(i.content));
    expect(django).toHaveLength(1);
    expect(ext.items[django[0].id].extractors.length).toBeGreaterThan(1);
    // Every assistant-origin item is a proposal, never a constraint/preference.
    for (const i of r.document.items) {
      if (ext.items[i.id].origin === 'assistant') expect(['constraint', 'preference']).not.toContain(i.type);
    }
  });

  it('hybrid mode falls back to deterministic when the semantic provider fails', async () => {
    const { extractor } = scripted('the model is having a bad day');
    const r = await extractContext(conversationInput(STACK_TURNS), { mode: 'hybrid', semantic: extractor, now: NOW });
    expect(r.fallback).toBe(true);
    expect(r.diagnostics.map((d) => d.code)).toContain('semantic_fallback');
    const ext = getSemanticExtension(r.document)!;
    expect(ext.fallback).toBe(true);
    expect(ext.extractors.map((e) => e.id)).toEqual(['cira.deterministic']);
    expect(r.document.items.length).toBeGreaterThan(0);
    expect(validate(r.document).ok).toBe(true);
  });

  it('semantic mode fails loudly (no silent fallback) and requires an extractor', async () => {
    const { extractor } = scripted('nope');
    await expect(extractContext(conversationInput(STACK_TURNS), { mode: 'semantic', semantic: extractor })).rejects.toBeInstanceOf(ExtractionError);
    await expect(extractContext(conversationInput(STACK_TURNS), { mode: 'semantic' })).rejects.toThrow(/requires a semantic extractor/);
    await expect(extractContext(conversationInput(STACK_TURNS), { mode: 'hybrid' })).rejects.toThrow(/requires a semantic extractor/);
  });

  it('renders attribution in Markdown for semantic documents', async () => {
    const { extractor } = scripted(STACK_MODEL_OUTPUT);
    const r = await extractContext(conversationInput(STACK_TURNS), { mode: 'semantic', semantic: extractor, now: NOW });
    const md = renderMarkdown(decode(r.document));
    expect(md).toContain('- **MUST:** Backend must use Django');
    expect(md).toMatch(/Use JWT authentication \[proposed\] _\(chatgpt · "Semantic test" · turn 1 \(assistant\) · model 0\.90 · suggested by assistant\)_/);
    expect(md).toContain('Items marked "suggested by assistant" are proposals, not user requirements.');
    // User-owned view.
    const userOnly = decode(r.document, { origins: ['user'] });
    expect(userOnly.sections.flatMap((s) => s.items).every((d) => d.annotation?.origin === 'user')).toBe(true);
    expect(userOnly.total_items).toBe(4);
  });

  it('origin filter works for Phase 01 documents too (falls back to the turn role)', () => {
    const { input } = fromLegacyConversation(loadFixture('technical-project'));
    const doc = encode(input, { now: NOW });
    const assistant = decode(doc, { origins: ['assistant'] }).sections.flatMap((s) => s.items);
    expect(assistant.length).toBeGreaterThan(0);
    expect(assistant.every((d) => d.provenance.role === 'assistant')).toBe(true);
  });
});

describe('selection boundary', () => {
  const TEN: ConversationInput = conversationInput(
    Array.from({ length: 10 }, (_, i) => [i % 2 ? 'assistant' : 'user', `MESSAGE-${i}-MARKER. The backend must use service ${i}.`] as ['user' | 'assistant', string]),
  );

  it('10 messages, 4 selected: only those 4 reach the semantic provider, the deterministic rules and the PCO', async () => {
    const seen: ExtractionInput[] = [];
    const spyDeterministic: ContextExtractor = {
      info: { id: 'spy', version: '1', kind: 'deterministic', locality: 'local' },
      async extract(input) {
        seen.push(input);
        return { extractor: this.info, items: [], annotations: {}, relations: [], diagnostics: [] };
      },
    };
    const { provider, extractor } = scripted({ items: [], relations: [] });
    const selection = [1, 4, 5, 8];

    const r = await extractContext(TEN, { mode: 'hybrid', semantic: extractor, deterministic: spyDeterministic, selection, now: NOW });

    // Semantic provider: exactly the selected messages, nothing else.
    expect(provider.requests).toHaveLength(1);
    const prompt = provider.requests[0].system + provider.requests[0].user;
    for (let i = 0; i < 10; i++) {
      if (selection.includes(i)) expect(prompt).toContain(`MESSAGE-${i}-MARKER`);
      else expect(prompt).not.toContain(`MESSAGE-${i}-MARKER`);
    }
    const sent = JSON.parse(provider.requests[0].user.slice(provider.requests[0].user.indexOf('[')));
    expect(sent.map((m: { ref: string }) => m.ref)).toEqual(['m1', 'm4', 'm5', 'm8']);

    // Deterministic extractor: same 4 turns.
    expect(seen[0].conversation.turns.map((t) => t.index)).toEqual(selection);
    // PCO: only the 4 selected turns, with original indices.
    expect(r.selectedMessages).toBe(4);
    expect(r.document.conversations[0].turns.map((t) => t.index)).toEqual(selection);
    expect(JSON.stringify(r.document)).not.toContain('MESSAGE-0-MARKER');
  });

  it('deterministic mode respects the selection too, with the same turn IDs as a full encode', async () => {
    const r = await extractContext(TEN, { selection: [2, 3], now: NOW });
    const full = encode(TEN, { now: NOW });
    expect(r.document.conversations[0].turns.map((t) => t.id)).toEqual(full.conversations[0].turns.slice(2, 4).map((t) => t.id));
    const allowed = new Set(r.document.conversations[0].turns.map((t) => t.id));
    expect(r.document.items.length).toBeGreaterThan(0);
    expect(r.document.items.every((i) => allowed.has(i.provenance.turn_id!))).toBe(true);
  });

  it('selectTurns keeps original indices and rejects empty or out-of-range selections', () => {
    expect(selectTurns(TEN, [7, 2, 2]).turns.map((t) => t.index)).toEqual([2, 7]);
    expect(() => selectTurns(TEN, [])).toThrow(TurnSelectionError);
    expect(() => selectTurns(TEN, [10])).toThrow(/out of range/);
    expect(() => selectTurns(TEN, [-1])).toThrow(/out of range/);
  });
});

describe('backward compatibility', () => {
  it('Phase 01 documents (no extension) still validate and decode unchanged', () => {
    const { input } = fromLegacyConversation(loadFixture('mixed-context'));
    const doc = encode(input, { now: NOW });
    expect(validate(doc).ok).toBe(true);
    expect(validateSemanticExtension(doc)).toEqual([]);
    expect(decode(doc).sections.flatMap((s) => s.items).some((d) => d.annotation)).toBe(false);
  });

  it('semantic documents are plain PCO v0.1 to readers that ignore extensions', async () => {
    const { extractor } = scripted(STACK_MODEL_OUTPUT);
    const r = await extractContext(conversationInput(STACK_TURNS), { mode: 'hybrid', semantic: extractor, now: NOW });
    const { extensions: _drop, ...plain } = r.document;
    expect(validate(plain).ok).toBe(true);
    expect(r.document.pco_version).toBe('0.1');
  });

  it('flags a tampered extension', async () => {
    const { extractor } = scripted(STACK_MODEL_OUTPUT);
    const r = await extractContext(conversationInput(STACK_TURNS), { mode: 'semantic', semantic: extractor, now: NOW });
    const doc = structuredClone(r.document);
    const ext = doc.extensions!['cira.semantic'] as { items: Record<string, { origin: string }>; relations: unknown[] };
    const firstId = Object.keys(ext.items)[0];
    ext.items[firstId].origin = 'assistant';
    ext.relations.push({ type: 'supersedes', from: 'itm_nope', to: firstId, source: 'x' });
    expect(validateSemanticExtension(doc).map((i) => i.code).sort()).toEqual(['origin_mismatch', 'unknown_relation_target']);
    expect(validateSemanticExtension({ ...doc, extensions: { 'cira.semantic': { version: 9 } } })[0].code).toBe('invalid_extension');
  });
});
