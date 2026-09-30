/**
 * Evaluation harness (foundation for CIRA-Bench).
 *
 *   fixture (conversation + selection + gold context)
 *     → extractor (any mode) → PCO
 *     → compare with gold → precision / recall / F1, attribution accuracy,
 *       provenance accuracy, unsupported items, forbidden (mis-attributed) items
 *
 * Matching is deliberately simple and transparent: a predicted item matches a
 * gold item when the TYPE is equal and every gold keyword appears in the
 * predicted content (case/whitespace-insensitive). One-to-one, greedy, in
 * gold order. This rewards the right type and the right key terms; it does
 * not judge wording.
 */
import { z } from 'zod';
import { CONTEXT_ITEM_TYPES } from '../pco/schema';
import { resolveProvenance } from '../provenance';
import { fromLegacyConversation } from '../migration/legacy-v0';
import { getSemanticExtension, OriginSchema, type Origin } from '../semantic/annotations';
import { extractContext, type ExtractContextOptions } from '../semantic/pipeline';
import type { ContextItem, PCODocument } from '../types';

export const GoldItemSchema = z.object({
  type: z.enum(CONTEXT_ITEM_TYPES),
  origin: OriginSchema,
  /** 0-based position of the message the information comes from. */
  message: z.number().int().nonnegative(),
  /** Every keyword must appear in the predicted content. */
  match: z.array(z.string().min(1)).min(1),
  note: z.string().optional(),
});

export const ForbiddenItemSchema = z.object({
  type: z.enum(CONTEXT_ITEM_TYPES),
  origin: OriginSchema,
  match: z.array(z.string().min(1)).min(1),
  reason: z.string(),
});

export const EvalFixtureSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  /** Legacy CIRA conversation (what the browser captures). */
  conversation: z.unknown(),
  /** 0-based message positions the "user" selected. Omit for all. */
  selection: z.array(z.number().int().nonnegative()).optional(),
  expected: z.array(GoldItemSchema),
  /** Items that must NOT be produced (e.g. an assistant suggestion recorded as a user constraint). */
  forbidden: z.array(ForbiddenItemSchema).default([]),
});

export type GoldItem = z.infer<typeof GoldItemSchema>;
export type ForbiddenItem = z.infer<typeof ForbiddenItemSchema>;
export type EvalFixture = z.infer<typeof EvalFixtureSchema>;

export interface MatchDetail {
  gold: GoldItem;
  item?: { id: string; type: string; content: string; origin: Origin; message?: number };
  originCorrect?: boolean;
  provenanceCorrect?: boolean;
}

export interface EvaluationCounts {
  gold: number;
  predicted: number;
  matched: number;
  origin_correct: number;
  provenance_correct: number;
  /** Predicted items with no locatable evidence (no turn or no span). */
  unsupported: number;
  /** Predicted items matching a `forbidden` spec. */
  forbidden: number;
}

export interface EvaluationMetrics {
  precision: number;
  recall: number;
  f1: number;
  /** Of matched items: origin equals gold origin. */
  attribution_accuracy: number;
  /** Of matched items: evidence points at the gold message with a valid span. */
  provenance_accuracy: number;
}

export interface EvaluationReport {
  fixture: string;
  counts: EvaluationCounts;
  metrics: EvaluationMetrics;
  matches: MatchDetail[];
  unmatched: Array<{ id: string; type: string; content: string; origin: Origin }>;
  forbidden: Array<{ id: string; reason: string }>;
}

const norm = (s: string) => s.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
/** Text a gold keyword may match: the content plus type-specific identifying fields. */
function matchText(item: ContextItem): string {
  const extra = item.type === 'reference' ? [item.uri, item.title] : item.type === 'code_artifact' ? [item.filename] : [];
  return norm([item.content, ...extra].filter(Boolean).join(' '));
}
const matches = (item: ContextItem, spec: { type: string; match: string[] }) =>
  item.type === spec.type && spec.match.every((k) => matchText(item).includes(norm(k)));
const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);

function itemOrigin(doc: PCODocument, item: ContextItem): Origin {
  return getSemanticExtension(doc)?.items[item.id]?.origin ?? resolveProvenance(doc, item).role ?? 'unknown';
}

export function evaluateDocument(doc: PCODocument, fixture: Pick<EvalFixture, 'id' | 'expected' | 'forbidden'>): EvaluationReport {
  const used = new Set<string>();
  const details: MatchDetail[] = [];
  const turnById = new Map(doc.conversations.flatMap((c) => c.turns.map((t) => [t.id, t] as const)));

  for (const gold of fixture.expected) {
    const item = doc.items.find((i) => !used.has(i.id) && matches(i, gold));
    if (!item) {
      details.push({ gold });
      continue;
    }
    used.add(item.id);
    const origin = itemOrigin(doc, item);
    const turn = item.provenance.turn_id ? turnById.get(item.provenance.turn_id) : undefined;
    const span = item.provenance.span;
    details.push({
      gold,
      item: { id: item.id, type: item.type, content: item.content, origin, ...(turn ? { message: turn.index } : {}) },
      originCorrect: origin === gold.origin,
      provenanceCorrect: !!turn && turn.index === gold.message && !!span && span.end <= turn.content.length,
    });
  }

  const unsupported = doc.items.filter((i) => !i.provenance.turn_id || !i.provenance.span).length;
  const forbidden = doc.items.flatMap((i) => {
    const f = fixture.forbidden.find((spec) => matches(i, spec) && itemOrigin(doc, i) === spec.origin);
    return f ? [{ id: i.id, reason: f.reason }] : [];
  });

  const matched = details.filter((d) => d.item).length;
  const counts: EvaluationCounts = {
    gold: fixture.expected.length,
    predicted: doc.items.length,
    matched,
    origin_correct: details.filter((d) => d.originCorrect).length,
    provenance_correct: details.filter((d) => d.provenanceCorrect).length,
    unsupported,
    forbidden: forbidden.length,
  };
  return {
    fixture: fixture.id,
    counts,
    metrics: metricsFor(counts),
    matches: details,
    unmatched: doc.items.filter((i) => !used.has(i.id)).map((i) => ({ id: i.id, type: i.type, content: i.content, origin: itemOrigin(doc, i) })),
    forbidden,
  };
}

export function metricsFor(c: EvaluationCounts): EvaluationMetrics {
  const precision = ratio(c.matched, c.predicted);
  const recall = ratio(c.matched, c.gold);
  return {
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    attribution_accuracy: ratio(c.origin_correct, c.matched),
    provenance_accuracy: ratio(c.provenance_correct, c.matched),
  };
}

/** Micro-averaged totals over several fixtures. */
export function aggregateReports(reports: readonly EvaluationReport[]): { counts: EvaluationCounts; metrics: EvaluationMetrics } {
  const counts = reports.reduce<EvaluationCounts>(
    (a, r) => ({
      gold: a.gold + r.counts.gold,
      predicted: a.predicted + r.counts.predicted,
      matched: a.matched + r.counts.matched,
      origin_correct: a.origin_correct + r.counts.origin_correct,
      provenance_correct: a.provenance_correct + r.counts.provenance_correct,
      unsupported: a.unsupported + r.counts.unsupported,
      forbidden: a.forbidden + r.counts.forbidden,
    }),
    { gold: 0, predicted: 0, matched: 0, origin_correct: 0, provenance_correct: 0, unsupported: 0, forbidden: 0 },
  );
  return { counts, metrics: metricsFor(counts) };
}

export function parseEvalFixture(raw: unknown): EvalFixture {
  return EvalFixtureSchema.parse(raw);
}

/** Run one fixture through `extractContext` (any mode) and score it. */
export async function runFixture(
  fixture: EvalFixture,
  options: Pick<ExtractContextOptions, 'mode' | 'semantic' | 'deterministic' | 'now'> = {},
): Promise<{ report: EvaluationReport; document: PCODocument }> {
  const { input } = fromLegacyConversation(fixture.conversation);
  const { document } = await extractContext(input, { ...options, ...(fixture.selection ? { selection: fixture.selection } : {}) });
  return { report: evaluateDocument(document, fixture), document };
}
