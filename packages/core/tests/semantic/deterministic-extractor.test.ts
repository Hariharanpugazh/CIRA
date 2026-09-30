import { describe, expect, it } from 'vitest';
import {
  buildConversation,
  createDeterministicExtractor,
  encode,
  fromLegacyConversation,
  type ContextExtractor,
  type ExtractionInput,
} from '../../src';
import { loadFixture } from '../helpers';

const NOW = '2026-09-29T12:00:00.000Z';
const FIXTURES = ['simple-conversation', 'technical-project', 'constraints', 'decisions', 'mixed-context', 'legacy/chatgpt-popup-export'];

function inputFor(name: string): ExtractionInput {
  const { input } = fromLegacyConversation(loadFixture(name));
  const conversation = buildConversation(input);
  return { conversation, source: conversation.source, now: NOW };
}

describe('DeterministicExtractor (Phase 01 rules behind ContextExtractor)', () => {
  it('implements the ContextExtractor interface', () => {
    const ex: ContextExtractor = createDeterministicExtractor();
    expect(ex.info).toEqual({ id: 'cira.deterministic', version: '0.1.0', kind: 'deterministic', locality: 'local' });
    expect(typeof ex.extract).toBe('function');
  });

  for (const name of FIXTURES) {
    it(`returns exactly the items encode() produces for ${name}`, async () => {
      const r = await createDeterministicExtractor().extract(inputFor(name));
      const { input } = fromLegacyConversation(loadFixture(name));
      expect(r.items).toEqual(encode(input, { now: NOW }).items);
    });
  }

  it('annotates every item with origin (turn role), evidence and extractor', async () => {
    const input = inputFor('technical-project');
    const r = await createDeterministicExtractor().extract(input);
    expect(Object.keys(r.annotations).sort()).toEqual(r.items.map((i) => i.id).sort());
    for (const item of r.items) {
      const a = r.annotations[item.id];
      const turn = input.conversation.turns.find((t) => t.id === item.provenance.turn_id)!;
      expect(a.origin).toBe(turn.role);
      expect(a.evidence).toEqual([{ turn_id: turn.id, span: item.provenance.span }]);
      expect(a.extractors).toEqual([item.provenance.extracted_by.agent]);
    }
  });

  it('marks literal copies explicit, assistant proposals suggested, other heuristics unknown', async () => {
    const r = await createDeterministicExtractor().extract(inputFor('technical-project'));
    const byContent = (s: string) => r.annotations[r.items.find((i) => i.content.startsWith(s))!.id];
    expect(byContent('export const router').assertion).toBe('explicit');
    expect(byContent("We'll use Fastify")).toMatchObject({ origin: 'assistant', assertion: 'suggested' });
    expect(byContent('Do not use Firebase')).toMatchObject({ origin: 'user', assertion: 'unknown' });
  });

  it('reports no diagnostics and no relations', async () => {
    const r = await createDeterministicExtractor().extract(inputFor('mixed-context'));
    expect(r.diagnostics).toEqual([]);
    expect(r.relations).toEqual([]);
  });
});
