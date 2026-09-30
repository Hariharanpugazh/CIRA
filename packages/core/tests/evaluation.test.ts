/**
 * Evaluation harness (CIRA-Bench foundation).
 *
 * `reference/*.json` are hand-written CORRECT model outputs used to test the
 * harness end to end (contract → normalisation → reconciliation → scoring).
 * They are not measurements of any model. The deterministic baseline scores
 * are recorded as a snapshot so regressions (and improvements) are visible.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregateReports,
  createScriptedProvider,
  createSemanticExtractor,
  evaluateDocument,
  parseEvalFixture,
  runFixture,
  type EvalFixture,
  type ModelOutput,
} from '../src';
import { FIXTURES_DIR } from './helpers';

const EVAL_DIR = join(FIXTURES_DIR, 'eval');
const NOW = '2026-09-30T10:00:00.000Z';
const fixtures: EvalFixture[] = readdirSync(EVAL_DIR)
  .filter((f) => f.endsWith('.eval.json'))
  .sort()
  .map((f) => parseEvalFixture(JSON.parse(readFileSync(join(EVAL_DIR, f), 'utf8'))));
const reference = (id: string) => readFileSync(join(EVAL_DIR, 'reference', `${id}.json`), 'utf8');

const round = (n: number) => Math.round(n * 1000) / 1000;

describe('evaluation fixtures', () => {
  it('parse against the fixture schema and cover the attribution cases', () => {
    expect(fixtures.map((f) => f.id)).toEqual([
      'correction-react-vue',
      'django-vs-fastapi',
      'postgres-preference',
      'selection-boundary',
      'system-and-tasks',
      'typescript-stack',
    ]);
    const types = new Set(fixtures.flatMap((f) => f.expected.map((e) => e.type)));
    expect([...types].sort()).toEqual(['code_artifact', 'constraint', 'decision', 'fact', 'preference', 'question', 'reference', 'task']);
  });
});

describe('harness: correct semantic output scores perfectly', () => {
  for (const f of fixtures) {
    it(`${f.id}: semantic replay of the reference output`, async () => {
      const semantic = createSemanticExtractor({ provider: createScriptedProvider(reference(f.id)) });
      const { report } = await runFixture(f, { mode: 'semantic', semantic, now: NOW });
      expect(report.metrics).toEqual({ precision: 1, recall: 1, f1: 1, attribution_accuracy: 1, provenance_accuracy: 1 });
      expect(report.counts.unsupported).toBe(0);
      expect(report.forbidden).toEqual([]);
    });
  }

  it('hybrid replay keeps recall at 1 and never introduces forbidden items', async () => {
    const reports = [];
    for (const f of fixtures) {
      const semantic = createSemanticExtractor({ provider: createScriptedProvider(reference(f.id)) });
      reports.push((await runFixture(f, { mode: 'hybrid', semantic, now: NOW })).report);
    }
    const total = aggregateReports(reports);
    expect(total.metrics.recall).toBe(1);
    expect(total.counts.forbidden).toBe(0);
  });
});

describe('harness: scoring detects errors', () => {
  const f = fixtures.find((x) => x.id === 'django-vs-fastapi')!;

  it('counts a mis-attributed assistant suggestion as forbidden and lowers precision', async () => {
    // A sloppy model: FastAPI as the user's requirement, citing the USER message (evidence does not contain it → rejected)…
    const invented: ModelOutput = {
      items: [
        { ref: 'a', type: 'constraint', content: 'Backend must use FastAPI', origin: 'user', assertion: 'explicit', confidence: 0.9, strength: 'must', status: null, language: null, filename: null, uri: null, title: null, evidence: [{ message: 'm0', quote: 'the backend to use FastAPI' }] },
      ],
      relations: [],
    };
    const r1 = await runFixture(f, { mode: 'semantic', semantic: createSemanticExtractor({ provider: createScriptedProvider(JSON.stringify(invented)) }), now: NOW });
    expect(r1.report.counts.predicted).toBe(0); // unsupported evidence → rejected by the contract
    expect(r1.report.metrics.recall).toBe(0);

    // …or citing the assistant message (evidence exists): the contract re-attributes it to the assistant as a proposal.
    invented.items[0].evidence = [{ message: 'm1', quote: 'You could use FastAPI instead.' }];
    const r2 = await runFixture(f, { mode: 'semantic', semantic: createSemanticExtractor({ provider: createScriptedProvider(JSON.stringify(invented)) }), now: NOW });
    expect(r2.report.forbidden).toEqual([]);
    expect(r2.document.items[0]).toMatchObject({ type: 'decision', status: 'proposed' });
  });

  it('scores origin and provenance independently of the match', async () => {
    const { document } = await runFixture(f, { mode: 'semantic', semantic: createSemanticExtractor({ provider: createScriptedProvider(reference(f.id)) }), now: NOW });
    const wrongGold = { ...f, expected: [{ ...f.expected[0], origin: 'assistant' as const, message: 1 }] };
    const r = evaluateDocument(document, wrongGold);
    expect(r.counts.matched).toBe(1);
    expect(r.metrics.attribution_accuracy).toBe(0);
    expect(r.metrics.provenance_accuracy).toBe(0);
    expect(r.unmatched).toHaveLength(1);
    expect(r.metrics.precision).toBe(0.5);
  });

  it('flags forbidden items produced by any extractor', async () => {
    const { document } = await runFixture(f, { mode: 'semantic', semantic: createSemanticExtractor({ provider: createScriptedProvider(reference(f.id)) }), now: NOW });
    const tampered = { ...document, items: document.items.map((i) => (i.content.includes('FastAPI') ? { ...i, type: 'constraint' as const, strength: 'must' as const } : i)) };
    // With the extension removed, origin falls back to the turn role (assistant) → not the forbidden user constraint.
    expect(evaluateDocument({ ...tampered, extensions: undefined }, f).forbidden).toEqual([]);
    const userTurn = document.conversations[0].turns[0].id;
    const asUser = { ...tampered, extensions: undefined, items: tampered.items.map((i) => (i.content.includes('FastAPI') ? { ...i, provenance: { ...i.provenance, turn_id: userTurn, span: undefined } } : i)) };
    const r = evaluateDocument(asUser, f);
    expect(r.forbidden.map((x) => x.reason)).toEqual(["assistant alternative recorded as the user's backend requirement"]);
    expect(r.counts.unsupported).toBe(1);
  });
});

describe('deterministic baseline (Phase 01 rules)', () => {
  it('is recorded so changes are visible', async () => {
    const reports = [];
    for (const f of fixtures) reports.push((await runFixture(f, { mode: 'deterministic', now: NOW })).report);
    const total = aggregateReports(reports);
    const summary = {
      per_fixture: Object.fromEntries(reports.map((r) => [r.fixture, { ...r.counts, f1: round(r.metrics.f1) }])),
      total: { ...total.counts, precision: round(total.metrics.precision), recall: round(total.metrics.recall), f1: round(total.metrics.f1), attribution_accuracy: round(total.metrics.attribution_accuracy) },
    };
    await expect(JSON.stringify(summary, null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/eval-deterministic-baseline.json');
    // The baseline must never extract from unselected messages or mis-attribute.
    expect(total.counts.forbidden).toBe(0);
  });
});
