import { describe, expect, it } from 'vitest';
import {
  encode,
  fromLegacyConversation,
  validate,
  type ContextItem,
  type ConversationInput,
  type ItemExtractor,
  type PCODocument,
} from '../src';
import { loadFixture } from './helpers';

const NOW = '2026-09-29T12:00:00.000Z';

function encodeFixture(name: string): PCODocument {
  const { input } = fromLegacyConversation(loadFixture(name));
  return encode(input, { now: NOW });
}

/** [type, content, turn index, extra] tuples for readable assertions. */
function summarize(doc: PCODocument) {
  const turnIndex = new Map(doc.conversations.flatMap((c) => c.turns.map((t) => [t.id, t.index] as const)));
  return doc.items.map((i: ContextItem) => {
    const extra =
      i.type === 'constraint' ? i.strength :
      i.type === 'code_artifact' ? i.language :
      i.type === 'reference' ? i.uri :
      i.type === 'decision' ? i.status :
      undefined;
    return [i.type, i.content, turnIndex.get(i.provenance.turn_id ?? ''), extra];
  });
}

const ofType = (doc: PCODocument, type: ContextItem['type']) => summarize(doc).filter((s) => s[0] === type);

describe('encoder: conversation → PCO', () => {
  it('produces a valid PCO for every fixture', () => {
    for (const name of ['simple-conversation', 'technical-project', 'constraints', 'decisions', 'mixed-context']) {
      const r = validate(encodeFixture(name));
      expect(r.errors, name).toEqual([]);
      expect(r.warnings, name).toEqual([]);
    }
  });

  it('keeps the transcript verbatim', () => {
    const raw = loadFixture<{ messages: Array<{ role: string; content: string }> }>('technical-project');
    const doc = encodeFixture('technical-project');
    expect(doc.conversations[0].turns.map((t) => [t.role, t.content])).toEqual(raw.messages.map((m) => [m.role, m.content]));
  });

  it('extracts facts', () => {
    expect(ofType(encodeFixture('technical-project'), 'fact')).toEqual([
      ['fact', "We're building a sync service for CIRA.", 0, undefined],
      ['fact', 'The backend is written in TypeScript on Node 22.', 0, undefined],
    ]);
    expect(ofType(encodeFixture('simple-conversation'), 'fact')).toEqual([
      ['fact', "I'm planning a weekend trip to Kyoto.", 0, undefined],
    ]);
  });

  it('extracts decisions (user = accepted, assistant = proposed)', () => {
    expect(ofType(encodeFixture('decisions'), 'decision')).toEqual([
      ['decision', "We've decided to use Postgres.", 2, 'accepted'],
      ['decision', 'We will use Prisma as the ORM.', 2, 'accepted'],
      ['decision', 'We chose pnpm for package management.', 2, 'accepted'],
    ]);
    expect(ofType(encodeFixture('technical-project'), 'decision')).toEqual([
      ['decision', "We'll use Fastify for the HTTP layer since it has first-class TypeScript types.", 1, 'proposed'],
      ['decision', 'Sounds good, we decided to use Fastify.', 2, 'accepted'],
    ]);
  });

  it('extracts constraints with strength, and ignores "I don\'t know"', () => {
    expect(ofType(encodeFixture('constraints'), 'constraint')).toEqual([
      ['constraint', 'Never commit secrets to the repository.', 0, 'must_not'],
      ['constraint', 'The app must work offline.', 0, 'must'],
      ['constraint', 'You should prefer small pull requests.', 0, 'should'],
      ['constraint', "Don't use class components in React.", 0, 'must_not'],
      ['constraint', 'Code should not depend on browser globals.', 0, 'should_not'],
    ]);
    expect(summarize(encodeFixture('constraints')).filter((s) => s[2] === 2)).toEqual([]);
  });

  it('extracts preferences', () => {
    expect(ofType(encodeFixture('simple-conversation'), 'preference')).toEqual([
      ['preference', 'I prefer quiet neighbourhoods over busy tourist areas.', 0, undefined],
    ]);
    expect(ofType(encodeFixture('mixed-context'), 'preference')).toEqual([
      ['preference', "I'd rather keep the UI minimal.", 0, undefined],
    ]);
  });

  it('extracts tasks', () => {
    expect(ofType(encodeFixture('simple-conversation'), 'task')).toEqual([
      ['task', 'I need to book a ryokan for two nights.', 2, undefined],
    ]);
    expect(ofType(encodeFixture('mixed-context'), 'task')).toEqual([
      ['task', 'Please implement a sync prototype.', 2, undefined],
    ]);
    expect(ofType(encodeFixture('decisions'), 'task')).toEqual([
      ['task', 'We need to pick a database.', 0, undefined],
    ]);
  });

  it('extracts questions', () => {
    expect(ofType(encodeFixture('technical-project'), 'question')).toEqual([
      ['question', 'Should we store sessions in Redis?', 2, undefined],
    ]);
    expect(ofType(encodeFixture('mixed-context'), 'question')).toEqual([
      ['question', "What's the best way to sync notes between devices?", 0, undefined],
    ]);
  });

  it('extracts code artifacts deterministically, with filename', () => {
    const doc = encodeFixture('technical-project');
    const code = doc.items.filter((i) => i.type === 'code_artifact');
    expect(code).toHaveLength(1);
    expect(code[0]).toMatchObject({
      type: 'code_artifact',
      language: 'ts',
      filename: 'src/router.ts',
      content: "export const router = createRouter({ prefix: '/v1' });",
      confidence: 1,
      provenance: { extracted_by: { method: 'deterministic' } },
    });
    // Code content must not leak into heuristic statements.
    expect(doc.items.some((i) => i.type !== 'code_artifact' && i.content.includes('createRouter'))).toBe(false);
  });

  it('extracts references (markdown links with title and bare URLs)', () => {
    expect(ofType(encodeFixture('mixed-context'), 'reference').map((r) => r[3])).toEqual([
      'https://automerge.org/',
      'https://crdt.tech',
    ]);
    const md = encodeFixture('mixed-context').items.find((i) => i.type === 'reference' && i.uri === 'https://automerge.org/');
    expect(md).toMatchObject({ title: 'Automerge' });
    expect(ofType(encodeFixture('simple-conversation'), 'reference').map((r) => r[3])).toEqual([
      'https://www.japan-guide.com/e/e3900.html',
    ]);
  });

  it('records method and confidence honestly', () => {
    const doc = encodeFixture('mixed-context');
    for (const item of doc.items) {
      const method = item.provenance.extracted_by.method;
      if (item.type === 'code_artifact' || item.type === 'reference') {
        expect(method).toBe('deterministic');
        expect(item.confidence).toBe(1);
      } else {
        expect(method).toBe('heuristic');
        expect(item.confidence).toBeLessThan(1);
      }
      expect(item.provenance.extracted_by.agent).toMatch(/^cira\.[a-z-]+@\d+\.\d+\.\d+$/);
    }
  });

  it('is deterministic: same input → same IDs', () => {
    expect(encodeFixture('mixed-context')).toEqual(encodeFixture('mixed-context'));
    const a = encodeFixture('mixed-context');
    const b = encode(fromLegacyConversation(loadFixture('mixed-context')).input, { now: '2030-01-01T00:00:00Z' });
    expect(b.id).toBe(a.id);
    expect(b.items.map((i) => i.id)).toEqual(a.items.map((i) => i.id));
  });

  it('derives the conversation ID from the URL, falling back to capture time', () => {
    const base: ConversationInput = {
      source: { kind: 'browser', platform: 'chatgpt' },
      url: 'https://chatgpt.com/c/abc',
      captured_at: '2026-01-01T00:00:00Z',
      turns: [{ role: 'user', content: 'hello world' }],
    };
    const again = { ...base, captured_at: '2026-02-01T00:00:00Z' };
    expect(encode(base).conversations[0].id).toBe(encode(again).conversations[0].id);
    const fresh = { ...base, url: 'https://chatgpt.com/' };
    expect(encode(fresh).conversations[0].id).not.toBe(encode({ ...fresh, captured_at: again.captured_at }).conversations[0].id);
  });

  it('de-duplicates repeated statements, keeping the first occurrence', () => {
    const doc = encode({
      source: { kind: 'cli', platform: 'test' },
      captured_at: NOW,
      turns: [
        { role: 'user', content: 'Do not use Firebase.' },
        { role: 'user', content: 'do not use firebase' },
      ],
    });
    const constraints = doc.items.filter((i) => i.type === 'constraint');
    expect(constraints).toHaveLength(1);
    expect(constraints[0].provenance.turn_id).toBe(doc.conversations[0].turns[0].id);
  });

  it('accepts custom extractors (pluggable)', () => {
    const manual: ItemExtractor = {
      id: 'test.pinned',
      version: '1.0.0',
      method: 'manual',
      extract: ({ turn }) => (turn.index === 0 ? [{ type: 'fact', content: 'Pinned fact', confidence: 1 }] : []),
    };
    const doc = encode(fromLegacyConversation(loadFixture('decisions')).input, { extractors: [manual], now: NOW });
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0].provenance.extracted_by).toEqual({ method: 'manual', agent: 'test.pinned@1.0.0' });
    expect(validate(doc).ok).toBe(true);
  });

  it('encodes multiple conversations into one document', () => {
    const inputs = ['decisions', 'constraints'].map((n) => fromLegacyConversation(loadFixture(n)).input);
    const doc = encode(inputs, { now: NOW, title: 'Combined' });
    expect(doc.conversations).toHaveLength(2);
    expect(doc.metadata.title).toBe('Combined');
    expect(validate(doc).ok).toBe(true);
  });

  it('keeps original turn indices when encoding a subset of a conversation', () => {
    const { input } = fromLegacyConversation(loadFixture('decisions'));
    const full = encode(input, { now: NOW });
    const subset = encode({ ...input, turns: input.turns.map((t, index) => ({ ...t, index })).filter((t) => t.index !== 0) }, { now: NOW });

    expect(subset.conversations[0].turns.map((t) => t.index)).toEqual(full.conversations[0].turns.slice(1).map((t) => t.index));
    expect(subset.conversations[0].turns.map((t) => t.id)).toEqual(full.conversations[0].turns.slice(1).map((t) => t.id));
    // Items from the kept turns are identical (same IDs, same provenance); items from turn 0 are gone.
    const t0 = full.conversations[0].turns[0].id;
    expect(subset.items).toEqual(full.items.filter((i) => i.provenance.turn_id !== t0));
    expect(validate(subset).ok).toBe(true);
  });
});
