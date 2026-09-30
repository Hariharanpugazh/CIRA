import { describe, expect, it } from 'vitest';
import {
  createDeterministicExtractor,
  createScriptedProvider,
  createSemanticExtractor,
  reconcile,
  type ExtractionInput,
  type ExtractionResult,
  type ModelOutput,
} from '../../src';
import { extractionInput, mi, out } from './helpers';

async function run(input: ExtractionInput, model: ModelOutput): Promise<{ det: ExtractionResult; sem: ExtractionResult }> {
  const det = await createDeterministicExtractor().extract(input);
  const sem = await createSemanticExtractor({ provider: createScriptedProvider(JSON.stringify(model)) }).extract(input);
  return { det, sem };
}

describe('reconciliation', () => {
  it('merges the same statement from two extractors, keeping the higher-confidence one and both evidence/extractors', async () => {
    const input = extractionInput([['user', 'I prefer React and Tailwind.']]);
    const { det, sem } = await run(input, out([
      mi({ ref: 'p', type: 'preference', content: 'User prefers React and Tailwind', confidence: 0.95, evidence: [{ message: 'm0', quote: 'prefer React and Tailwind' }] }),
    ]));
    expect(det.items.map((i) => i.type)).toEqual(['preference']);

    const r = reconcile([det, sem]);
    expect(r.items).toHaveLength(1);
    const [item] = r.items;
    expect(item.content).toBe('User prefers React and Tailwind');
    expect(item.confidence).toBe(0.95);
    const a = r.annotations[item.id];
    expect(a.extractors).toEqual(['cira.semantic@0.1.0', 'cira.heuristic-statements@0.1.0']);
    expect(a.evidence).toHaveLength(2);
    expect(a.merged_from).toEqual([{ extractor: 'cira.deterministic@0.1.0', type: 'preference', content: 'I prefer React and Tailwind.', confidence: 0.6 }]);
    expect(r.report).toEqual({ candidates: 2, items: 1, merged: 1, by_extractor: { 'cira.deterministic@0.1.0': 1, 'cira.semantic@0.1.0': 1 } });
  });

  it('keeps the deterministic literal for code and links, whatever the confidence', async () => {
    const input = extractionInput([['assistant', 'See https://pnpm.io/workspaces\n```ts\nconst x = 1;\n```']]);
    const { det, sem } = await run(input, out([
      mi({ ref: 'r', type: 'reference', origin: 'assistant', uri: 'https://pnpm.io/workspaces/', title: 'pnpm', content: 'pnpm workspaces', evidence: [{ message: 'm0', quote: 'https://pnpm.io/workspaces' }] }),
      mi({ ref: 'c', type: 'code_artifact', origin: 'assistant', language: 'ts', content: 'const x = 1;', evidence: [{ message: 'm0', quote: 'const x = 1;' }] }),
    ]));
    const r = reconcile([det, sem]);
    expect(r.items.map((i) => [i.type, i.provenance.extracted_by.method])).toEqual([
      ['code_artifact', 'deterministic'],
      ['reference', 'deterministic'],
    ]);
    expect(r.report.merged).toBe(2);
  });

  it('never merges a user statement with an assistant suggestion on the same topic', async () => {
    const input = extractionInput([['user', 'I need the backend to use Django.'], ['assistant', 'You could use FastAPI instead of Django.']]);
    const { det, sem } = await run(input, out([
      mi({ ref: 'u', type: 'constraint', strength: 'must', content: 'Backend must use Django', evidence: [{ message: 'm0', quote: 'I need the backend to use Django.' }] }),
      mi({ ref: 'a', type: 'decision', status: 'proposed', origin: 'assistant', assertion: 'suggested', content: 'Backend: FastAPI', evidence: [{ message: 'm1', quote: 'You could use FastAPI instead of Django.' }] }),
    ]));
    const r = reconcile([sem]);
    expect(r.items.map((i) => [i.type, r.annotations[i.id].origin])).toEqual([
      ['constraint', 'user'],
      ['decision', 'assistant'],
    ]);
    // With the deterministic baseline too: still no user-owned FastAPI item.
    const both = reconcile([det, sem]);
    const fastapi = both.items.filter((i) => /fastapi/i.test(i.content));
    expect(fastapi.every((i) => both.annotations[i.id].origin === 'assistant')).toBe(true);
    expect(both.items.some((i) => i.type === 'constraint' && /django/i.test(i.content) && both.annotations[i.id].origin === 'user')).toBe(true);
  });

  it('keeps both sides of a conflict and records the supersession, without overwriting', async () => {
    const input = extractionInput([['user', 'I use React.'], ['assistant', 'Great.'], ['user', 'I switched to Vue.']]);
    const { sem } = await run(input, out(
      [
        mi({ ref: 'old', type: 'fact', content: 'Uses React', evidence: [{ message: 'm0', quote: 'I use React.' }] }),
        mi({ ref: 'new', type: 'fact', content: 'Uses Vue', evidence: [{ message: 'm2', quote: 'I switched to Vue.' }] }),
      ],
      [{ type: 'supersedes', from: 'new', to: 'old' }],
    ));
    const r = reconcile([sem]);
    expect(r.items.map((i) => i.content)).toEqual(['Uses React', 'Uses Vue']);
    expect(r.relations).toEqual([{ type: 'supersedes', from: r.items[1].id, to: r.items[0].id, source: 'cira.semantic@0.1.0' }]);
  });

  it('re-points relations at the canonical item after a merge', async () => {
    const input = extractionInput([['user', 'We decided to use Postgres.'], ['user', 'Actually we decided to use SQLite.']]);
    const { det, sem } = await run(input, out(
      [
        mi({ ref: 'a', type: 'decision', status: 'accepted', content: 'Use Postgres', confidence: 0.5, evidence: [{ message: 'm0', quote: 'We decided to use Postgres.' }] }),
        mi({ ref: 'b', type: 'decision', status: 'accepted', content: 'Use SQLite', confidence: 0.5, evidence: [{ message: 'm1', quote: 'we decided to use SQLite' }] }),
      ],
      [{ type: 'supersedes', from: 'b', to: 'a' }],
    ));
    const r = reconcile([det, sem]);
    expect(r.items).toHaveLength(2);
    const ids = new Set(r.items.map((i) => i.id));
    expect(r.relations).toHaveLength(1);
    expect(ids.has(r.relations[0].from) && ids.has(r.relations[0].to)).toBe(true);
    // Deterministic wins ties at 0.65 > 0.5; the semantic relation still points at the survivors.
    expect(r.items.map((i) => i.provenance.extracted_by.method)).toEqual(['heuristic', 'heuristic']);
  });

  it('links (but does not merge) different-type items that cite the same text', async () => {
    const input = extractionInput([['user', 'Authentication is required.']]);
    const { det, sem } = await run(input, out([
      mi({ ref: 'c', type: 'constraint', strength: 'must', content: 'Authentication is required', evidence: [{ message: 'm0', quote: 'Authentication is required.' }] }),
    ]));
    // The heuristic sees "required" as a constraint too → same type → merged.
    expect(reconcile([det, sem]).items).toHaveLength(1);

    const input2 = extractionInput([['user', 'We need to support offline mode.']]);
    const r2 = await run(input2, out([
      mi({ ref: 'c', type: 'constraint', strength: 'must', content: 'Offline mode must be supported', evidence: [{ message: 'm0', quote: 'We need to support offline mode.' }] }),
    ]));
    const rec = reconcile([r2.det, r2.sem]);
    expect(rec.items.map((i) => i.type).sort()).toEqual(['constraint', 'task']);
    expect(rec.relations).toEqual([expect.objectContaining({ type: 'same_evidence', source: 'cira.reconcile@0.1.0' })]);
  });

  it('is deterministic', async () => {
    const input = extractionInput([['user', 'I prefer React. The API must be versioned.']]);
    const { det, sem } = await run(input, out([
      mi({ ref: 'p', type: 'preference', content: 'Prefers React', evidence: [{ message: 'm0', quote: 'I prefer React.' }] }),
      mi({ ref: 'c', type: 'constraint', strength: 'must', content: 'API must be versioned', evidence: [{ message: 'm0', quote: 'The API must be versioned.' }] }),
    ]));
    expect(reconcile([det, sem])).toEqual(reconcile([det, sem]));
  });

  it('does not merge two items from the same extractor', async () => {
    const input = extractionInput([['user', 'The backend must use Django and auth is required.']]);
    const { sem } = await run(input, out([
      mi({ ref: 'a', type: 'constraint', strength: 'must', content: 'Backend must use Django', evidence: [{ message: 'm0', quote: 'The backend must use Django and auth is required.' }] }),
      mi({ ref: 'b', type: 'constraint', strength: 'must', content: 'Auth is required', evidence: [{ message: 'm0', quote: 'The backend must use Django and auth is required.' }] }),
    ]));
    expect(reconcile([sem]).items).toHaveLength(2);
  });
});
