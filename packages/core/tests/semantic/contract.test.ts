import { describe, expect, it } from 'vitest';
import {
  applyAttributionRules,
  ContractError,
  locateQuote,
  modelOutputJsonSchema,
  normalizeModelOutput,
  parseModelOutput,
  validate,
  type ExtractorInfo,
  type PCODocument,
} from '../../src';
import { extractionInput, mi, NOW, out, STACK_MODEL_OUTPUT, STACK_TURNS } from './helpers';

const INFO: ExtractorInfo = { id: 'cira.semantic', version: '0.1.0', kind: 'semantic', locality: 'local', provider: 'test', model: 'scripted' };

function norm(turns: Parameters<typeof extractionInput>[0], output = STACK_MODEL_OUTPUT, evidencePolicy?: 'strict' | 'lenient') {
  const input = extractionInput(turns);
  return { input, r: normalizeModelOutput(output, input.conversation, { extractor: INFO, now: NOW, evidencePolicy }) };
}

describe('model output schema', () => {
  it('accepts valid output', () => {
    expect(parseModelOutput(JSON.stringify(STACK_MODEL_OUTPUT))).toEqual(STACK_MODEL_OUTPUT);
  });

  it('accepts output wrapped in a ```json fence', () => {
    expect(parseModelOutput('```json\n' + JSON.stringify(STACK_MODEL_OUTPUT) + '\n```').items).toHaveLength(7);
  });

  it('rejects non-JSON and schema violations without echoing content', () => {
    expect(() => parseModelOutput('Sure! Here is the context: ...')).toThrow(ContractError);
    const bad = { items: [{ ...STACK_MODEL_OUTPUT.items[0], type: 'opinion', content: 'SECRET-CONTENT' }], relations: [] };
    try {
      parseModelOutput(JSON.stringify(bad));
      throw new Error('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractError);
      const err = e as ContractError;
      expect(err.issues.join(' ')).toContain('items.0.type');
      expect(JSON.stringify(err.issues) + err.message).not.toContain('SECRET-CONTENT');
    }
    expect(() => parseModelOutput(JSON.stringify({ items: [{ ...STACK_MODEL_OUTPUT.items[0], confidence: 3 }], relations: [] }))).toThrow(ContractError);
    expect(() => parseModelOutput(JSON.stringify({ items: [] }))).toThrow(ContractError);
  });

  it('exports a strict JSON Schema (all properties required, no extras)', () => {
    const s = modelOutputJsonSchema() as { required: string[]; additionalProperties: boolean; properties: { items: { items: { required: string[]; additionalProperties: boolean } } } };
    expect(s.required).toEqual(['items', 'relations']);
    expect(s.additionalProperties).toBe(false);
    const item = s.properties.items.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(expect.arrayContaining(['ref', 'type', 'content', 'origin', 'assertion', 'confidence', 'evidence', 'strength']));
  });
});

describe('evidence location', () => {
  it('finds exact, whitespace/case/quote-insensitive and wrapped quotes; rejects missing ones', () => {
    const text = 'We’ll  use Postgres.\nThe API must be versioned.';
    const at = text.indexOf('The API');
    expect(locateQuote(text, 'The API must be versioned.')).toEqual({ start: at, end: at + 26 });
    expect(locateQuote(text, "we'll use postgres")).toEqual({ start: 0, end: 19 });
    expect(text.slice(0, 19)).toBe('We’ll  use Postgres');
    expect(locateQuote(text, '"The API must be versioned"')).toEqual({ start: at, end: at + 25 });
    expect(locateQuote(text, 'The API must be REST')).toBeUndefined();
    expect(locateQuote(text, 'x')).toBeUndefined();
  });
});

describe('normalisation: the TypeScript stack example', () => {
  it('separates user-owned context from assistant suggestions', () => {
    const { r } = norm(STACK_TURNS);
    const view = r.items.map((i) => {
      const a = r.annotations[i.id];
      return [i.type, i.content, a.origin, a.assertion, i.type === 'decision' ? i.status : i.type === 'constraint' ? i.strength : undefined];
    });
    expect(view).toEqual([
      ['fact', 'The project uses TypeScript', 'user', 'explicit', undefined],
      ['preference', 'Prefers React and Tailwind', 'user', 'explicit', undefined],
      ['constraint', 'Backend must use Django', 'user', 'explicit', 'must'],
      ['constraint', 'Authentication is required', 'user', 'explicit', 'must'],
      ['decision', 'Use Django REST Framework for the backend', 'assistant', 'suggested', 'proposed'],
      ['decision', 'Use JWT authentication', 'assistant', 'suggested', 'proposed'],
      ['decision', 'Use PostgreSQL for the database', 'assistant', 'suggested', 'proposed'],
    ]);
    // No assistant item is a user requirement or preference.
    for (const i of r.items) {
      if (r.annotations[i.id].origin === 'assistant') expect(['constraint', 'preference']).not.toContain(i.type);
    }
    expect(r.diagnostics).toEqual([]);
  });

  it('builds PCO provenance with conversation, turn, span, capture time and extractor', () => {
    const { input, r } = norm(STACK_TURNS);
    const django = r.items.find((i) => i.content === 'Backend must use Django')!;
    const turn = input.conversation.turns[0];
    expect(django.provenance).toEqual({
      source: input.conversation.source,
      conversation_id: input.conversation.id,
      turn_id: turn.id,
      span: { start: turn.content.indexOf('The backend'), end: turn.content.indexOf('The backend') + 'The backend must use Django.'.length },
      captured_at: input.conversation.captured_at,
      extracted_by: { method: 'model', agent: 'cira.semantic@0.1.0' },
    });
    expect(turn.content.slice(django.provenance.span!.start, django.provenance.span!.end)).toBe('The backend must use Django.');
    expect(r.annotations[django.id].evidence).toEqual([{ turn_id: turn.id, span: django.provenance.span }]);
  });

  it('produces items that pass PCO validation', () => {
    const { input, r } = norm(STACK_TURNS);
    const doc: PCODocument = {
      pco_version: '0.1',
      id: 'pco_x',
      metadata: { created_at: NOW, updated_at: NOW },
      conversations: [input.conversation],
      items: r.items,
    };
    expect(validate(doc).errors).toEqual([]);
  });
});

describe('attribution', () => {
  const django: Array<[ 'user' | 'assistant', string]> = [
    ['user', 'I need the backend to use Django.'],
    ['assistant', 'You could use FastAPI instead.'],
  ];

  it('user requirement stays a user constraint; assistant alternative is a suggestion', () => {
    const { r } = norm(
      django,
      out([
        mi({ ref: 'a', type: 'constraint', strength: 'must', content: 'Backend must use Django', evidence: [{ message: 'm0', quote: 'I need the backend to use Django.' }] }),
        mi({ ref: 'b', type: 'decision', status: 'proposed', origin: 'assistant', assertion: 'suggested', content: 'FastAPI could be used', evidence: [{ message: 'm1', quote: 'You could use FastAPI instead.' }] }),
      ]),
    );
    expect(r.items.map((i) => [i.type, i.content, r.annotations[i.id].origin, r.annotations[i.id].assertion])).toEqual([
      ['constraint', 'Backend must use Django', 'user', 'explicit'],
      ['decision', 'FastAPI could be used', 'assistant', 'suggested'],
    ]);
  });

  it('corrects a mislabelled origin from the evidence speaker (model claims an assistant idea is a user constraint)', () => {
    const { r } = norm(django, out([
      mi({ ref: 'x', type: 'constraint', strength: 'must', origin: 'user', content: 'Backend: FastAPI', evidence: [{ message: 'm1', quote: 'You could use FastAPI instead.' }] }),
    ]));
    const [item] = r.items;
    expect(item.type).toBe('decision');
    expect(item.type === 'decision' && item.status).toBe('proposed');
    expect(r.annotations[item.id]).toMatchObject({ origin: 'assistant', assertion: 'suggested' });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['origin_corrected', 'attribution_rule']);
  });

  it('an assistant cannot hold a preference or accept a decision', () => {
    const { r } = norm([['user', 'I prefer PostgreSQL.'], ['assistant', 'MongoDB may be easier. We will go with MongoDB.']], out([
      mi({ ref: 'u', type: 'preference', content: 'Prefers PostgreSQL', evidence: [{ message: 'm0', quote: 'I prefer PostgreSQL.' }] }),
      mi({ ref: 'p', type: 'preference', origin: 'assistant', content: 'MongoDB may be easier', evidence: [{ message: 'm1', quote: 'MongoDB may be easier.' }] }),
      mi({ ref: 'd', type: 'decision', status: 'accepted', origin: 'assistant', content: 'Go with MongoDB', evidence: [{ message: 'm1', quote: 'We will go with MongoDB.' }] }),
    ]));
    expect(r.items.map((i) => [i.type, i.type === 'decision' ? i.status : null, r.annotations[i.id].origin])).toEqual([
      ['preference', null, 'user'],
      ['decision', 'proposed', 'assistant'],
      ['decision', 'proposed', 'assistant'],
    ]);
  });

  it('user decisions and corrections stay user-owned', () => {
    const { r } = norm([['assistant', 'Use FastAPI.'], ['user', "No, let's use Django instead of FastAPI."]], out([
      mi({ ref: 'c', type: 'decision', status: 'accepted', content: 'Use Django instead of FastAPI', evidence: [{ message: 'm1', quote: "let's use Django instead of FastAPI" }] }),
    ]));
    expect(r.items[0]).toMatchObject({ type: 'decision', status: 'accepted' });
    expect(r.annotations[r.items[0].id].origin).toBe('user');
  });

  it('system messages can impose constraints; tool output becomes quoted facts', () => {
    const { r } = norm([['system', 'Always answer in English.'], ['tool', 'Build failed: must use Node 22.']], out([
      mi({ ref: 's', type: 'constraint', strength: 'must', origin: 'system', content: 'Answer in English', evidence: [{ message: 'm0', quote: 'Always answer in English.' }] }),
      mi({ ref: 't', type: 'constraint', strength: 'must', origin: 'tool', content: 'Must use Node 22', evidence: [{ message: 'm1', quote: 'must use Node 22' }] }),
    ]));
    expect(r.items.map((i) => [i.type, r.annotations[i.id].origin, r.annotations[i.id].assertion])).toEqual([
      ['constraint', 'system', 'explicit'],
      ['fact', 'tool', 'quoted'],
    ]);
  });

  it('keeps quoted content marked as quoted', () => {
    const { r } = norm([['user', 'The docs say: "tokens expire after one hour".']], out([
      mi({ ref: 'q', type: 'fact', assertion: 'quoted', content: 'Tokens expire after one hour (per the docs)', evidence: [{ message: 'm0', quote: 'tokens expire after one hour' }] }),
    ]));
    expect(r.annotations[r.items[0].id]).toMatchObject({ origin: 'user', assertion: 'quoted' });
  });

  it('applyAttributionRules is a pure, total function', () => {
    expect(applyAttributionRules({ type: 'fact', origin: 'assistant', assertion: 'explicit', status: null }).reason).toBeUndefined();
    expect(applyAttributionRules({ type: 'constraint', origin: 'assistant', assertion: 'explicit', status: null }).candidate.type).toBe('decision');
  });
});

describe('evidence requirements', () => {
  const turns: Array<['user', string]> = [['user', 'The API must be versioned.']];

  it('rejects items without evidence', () => {
    const { r } = norm(turns, out([mi({ ref: 'n', type: 'fact', content: 'Uses GraphQL', evidence: [] })]));
    expect(r.items).toEqual([]);
    expect(r.diagnostics).toEqual([expect.objectContaining({ code: 'missing_evidence', ref: 'n' })]);
  });

  it('rejects invented items whose quote is not in the selected messages (strict)', () => {
    const { r } = norm(turns, out([mi({ ref: 'x', type: 'constraint', strength: 'must', content: 'Must use GraphQL', evidence: [{ message: 'm0', quote: 'The API must use GraphQL.' }] })]));
    expect(r.items).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({ code: 'unsupported_item' });
    expect(JSON.stringify(r.diagnostics)).not.toContain('GraphQL');
  });

  it('lenient policy keeps unlocated evidence at low confidence without a span', () => {
    const { r } = norm(turns, out([mi({ ref: 'x', type: 'fact', content: 'API is versioned', confidence: 0.9, evidence: [{ message: 'm0', quote: 'versioned API' }] })]), 'lenient');
    expect(r.items[0].confidence).toBe(0.4);
    expect(r.items[0].provenance.span).toBeUndefined();
    expect(r.annotations[r.items[0].id].evidence).toEqual([{ turn_id: r.items[0].provenance.turn_id }]);
  });

  it('rejects references to messages outside the selection', () => {
    const { r } = norm(turns, out([mi({ ref: 'o', type: 'fact', content: 'Something', evidence: [{ message: 'm7', quote: 'Something' }] })]));
    expect(r.items).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['unknown_message_ref', 'unsupported_item']);
  });

  it('rejects type-specific gaps (constraint without strength, reference without uri)', () => {
    const { r } = norm(turns, out([
      mi({ ref: 'c', type: 'constraint', content: 'API versioned', evidence: [{ message: 'm0', quote: 'The API must be versioned.' }] }),
      mi({ ref: 'r', type: 'reference', content: 'API docs', evidence: [{ message: 'm0', quote: 'The API' }] }),
    ]));
    expect(r.items).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['missing_field', 'missing_field']);
  });

  it('caps inferred confidence and keeps relations only between accepted items', () => {
    const { r } = norm([['user', 'I use React.'], ['user', 'I switched to Vue.']], out(
      [
        mi({ ref: 'old', type: 'fact', content: 'Uses React', evidence: [{ message: 'm0', quote: 'I use React.' }] }),
        mi({ ref: 'new', type: 'fact', content: 'Uses Vue', assertion: 'inferred', confidence: 0.99, evidence: [{ message: 'm1', quote: 'I switched to Vue.' }] }),
      ],
      [{ type: 'supersedes', from: 'new', to: 'old' }, { type: 'conflicts_with', from: 'new', to: 'ghost' }],
    ));
    expect(r.items.map((i) => i.confidence)).toEqual([0.9, 0.8]);
    expect(r.relations).toEqual([{ type: 'supersedes', from: r.items[1].id, to: r.items[0].id }]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['relation_dropped']);
  });
});

describe('every context type', () => {
  it('normalises fact, decision, constraint, preference, task, question, code_artifact and reference', () => {
    const content = [
      "I'm on Node 22. We decided to use pnpm. Never use npm. I prefer tabs. Next: add CI. Should we use Docker?",
      'Use this:\n```ts\nconst x = 1;\n```\nSee https://pnpm.io/workspaces for details.',
    ];
    const { r } = norm([['user', content[0]], ['assistant', content[1]]], out([
      mi({ ref: '1', type: 'fact', content: 'Runs Node 22', evidence: [{ message: 'm0', quote: "I'm on Node 22." }] }),
      mi({ ref: '2', type: 'decision', status: 'accepted', content: 'Use pnpm', evidence: [{ message: 'm0', quote: 'We decided to use pnpm.' }] }),
      mi({ ref: '3', type: 'constraint', strength: 'must_not', content: 'Never use npm', evidence: [{ message: 'm0', quote: 'Never use npm.' }] }),
      mi({ ref: '4', type: 'preference', content: 'Prefers tabs', evidence: [{ message: 'm0', quote: 'I prefer tabs.' }] }),
      mi({ ref: '5', type: 'task', status: 'open', content: 'Add CI', evidence: [{ message: 'm0', quote: 'Next: add CI.' }] }),
      mi({ ref: '6', type: 'question', content: 'Should we use Docker?', evidence: [{ message: 'm0', quote: 'Should we use Docker?' }] }),
      mi({ ref: '7', type: 'code_artifact', origin: 'assistant', language: 'TS', content: 'const x = 1;', evidence: [{ message: 'm1', quote: 'const x = 1;' }] }),
      mi({ ref: '8', type: 'reference', origin: 'assistant', uri: 'https://pnpm.io/workspaces', title: 'pnpm workspaces', content: 'pnpm workspaces docs', evidence: [{ message: 'm1', quote: 'https://pnpm.io/workspaces' }] }),
    ]));
    expect(r.items.map((i) => i.type)).toEqual(['fact', 'decision', 'constraint', 'preference', 'task', 'question', 'code_artifact', 'reference']);
    expect(r.items[6]).toMatchObject({ type: 'code_artifact', language: 'ts' });
    expect(r.items[7]).toMatchObject({ type: 'reference', uri: 'https://pnpm.io/workspaces', title: 'pnpm workspaces' });
    expect(r.diagnostics).toEqual([]);
  });
});
