/**
 * Reconciliation: merge candidate items from several extractors into one
 * de-duplicated set, without losing evidence or provenance.
 *
 * Deterministic and order-independent in its decisions (ties broken by a
 * fixed rule), so the same inputs always give the same PCO.
 *
 * Two candidates are the SAME item when they come from different extractors,
 * have the same type and the same origin, and either
 *   - have equal normalised content (code: equal code; reference: equal URI), or
 *   - cite overlapping text in the same turn (≥ 50 % of the shorter span).
 * Candidates with different origins are never merged: a user requirement and
 * an assistant suggestion about the same topic stay separate items.
 *
 * On merge, the higher-confidence candidate becomes canonical (code and links:
 * the deterministic literal copy wins), evidence and extractor lists are
 * unioned, and the other candidate is kept in `merged_from`.
 *
 * Nothing is overwritten on conflict: `supersedes` / `conflicts_with`
 * relations asserted by extractors are kept, and different-type items citing
 * the same text get a `same_evidence` relation. Automatic resolution is a
 * later phase.
 */
import { normalizeForDedupe } from '../encoder/text';
import type { ContextItem } from '../types';
import type { Evidence, Relation, SemanticAnnotation } from './annotations';
import { extractorRef, type ExtractionDiagnostic, type ExtractionResult } from './types';

export const RECONCILER_ID = 'cira.reconcile@0.1.0';

export interface ReconcileReport {
  candidates: number;
  items: number;
  merged: number;
  by_extractor: Record<string, number>;
}

export interface ReconciledResult {
  items: ContextItem[];
  annotations: Record<string, SemanticAnnotation>;
  relations: Relation[];
  diagnostics: ExtractionDiagnostic[];
  report: ReconcileReport;
}

interface Candidate {
  item: ContextItem;
  annotation: SemanticAnnotation;
  extractor: string;
  kind: 'deterministic' | 'semantic';
  order: number;
}

function spanOverlap(a: Evidence[], b: Evidence[]): number {
  let best = 0;
  for (const x of a) {
    for (const y of b) {
      if (x.turn_id !== y.turn_id || !x.span || !y.span) continue;
      const inter = Math.min(x.span.end, y.span.end) - Math.max(x.span.start, y.span.start);
      if (inter <= 0) continue;
      const shorter = Math.min(x.span.end - x.span.start, y.span.end - y.span.start);
      best = Math.max(best, inter / shorter);
    }
  }
  return best;
}

function contentKey(item: ContextItem): string {
  switch (item.type) {
    case 'code_artifact':
      return item.content.replace(/\s+/g, ' ').trim();
    case 'reference':
      return item.uri.replace(/\/+$/, '').toLowerCase();
    default:
      return normalizeForDedupe(item.content);
  }
}

function sameItem(a: Candidate, b: Candidate): boolean {
  if (a.extractor === b.extractor) return false;
  if (a.item.type !== b.item.type || a.annotation.origin !== b.annotation.origin) return false;
  if (contentKey(a.item) === contentKey(b.item)) return true;
  return spanOverlap(a.annotation.evidence, b.annotation.evidence) >= 0.5;
}

const literalType = (t: ContextItem['type']) => t === 'code_artifact' || t === 'reference';

/** Which candidate stays canonical. */
function prefer(a: Candidate, b: Candidate): Candidate {
  if (literalType(a.item.type) && a.kind !== b.kind) return a.kind === 'deterministic' ? a : b;
  if (a.item.confidence !== b.item.confidence) return a.item.confidence > b.item.confidence ? a : b;
  if (a.kind !== b.kind) return a.kind === 'semantic' ? a : b; // richer attribution
  return a.order <= b.order ? a : b;
}

function unionEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of [...a, ...b]) {
    const key = `${e.turn_id}:${e.span?.start ?? ''}:${e.span?.end ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

interface Group {
  canonical: Candidate;
  members: Candidate[];
}

export function reconcile(results: readonly ExtractionResult[]): ReconciledResult {
  const candidates: Candidate[] = [];
  const byExtractor: Record<string, number> = {};
  const diagnostics: ExtractionDiagnostic[] = [];

  results.forEach((r) => {
    const ref = extractorRef(r.extractor);
    byExtractor[ref] = (byExtractor[ref] ?? 0) + r.items.length;
    for (const item of r.items) {
      const annotation = r.annotations[item.id];
      if (!annotation) {
        diagnostics.push({ level: 'warning', code: 'missing_annotation', message: `item from ${ref} has no annotation; skipped`, ref: item.id });
        continue;
      }
      candidates.push({ item, annotation, extractor: ref, kind: r.extractor.kind, order: candidates.length });
    }
  });

  // Group duplicates. A group accepts at most one member per extractor.
  const groups: Group[] = [];
  const groupOf = new Map<string, Group>();
  for (const c of candidates) {
    const g = groups.find((g) => !g.members.some((m) => m.extractor === c.extractor) && g.members.some((m) => sameItem(m, c)));
    if (g) {
      g.members.push(c);
      g.canonical = prefer(g.canonical, c);
    } else {
      groups.push({ canonical: c, members: [c] });
    }
    groupOf.set(c.item.id, groups.find((x) => x.members.includes(c))!);
  }

  const items: ContextItem[] = [];
  const annotations: Record<string, SemanticAnnotation> = {};
  let merged = 0;
  for (const g of groups) {
    const canon = g.canonical;
    const others = g.members.filter((m) => m !== canon);
    let annotation: SemanticAnnotation = { ...canon.annotation, evidence: [...canon.annotation.evidence], extractors: [...canon.annotation.extractors] };
    let confidence = canon.item.confidence;
    for (const o of others) {
      merged++;
      annotation = {
        ...annotation,
        assertion: annotation.assertion === 'unknown' ? o.annotation.assertion : annotation.assertion,
        evidence: unionEvidence(annotation.evidence, o.annotation.evidence),
        extractors: [...new Set([...annotation.extractors, ...o.annotation.extractors])],
        merged_from: [
          ...(annotation.merged_from ?? []),
          { extractor: o.extractor, type: o.item.type, content: o.item.content, confidence: o.item.confidence },
        ],
      };
      confidence = Math.max(confidence, o.item.confidence);
    }
    items.push(confidence === canon.item.confidence ? canon.item : ({ ...canon.item, confidence } as ContextItem));
    annotations[canon.item.id] = annotation;
  }

  // Relations asserted by extractors, re-pointed at canonical items.
  const canonicalId = (id: string) => groupOf.get(id)?.canonical.item.id;
  const relations: Relation[] = [];
  const relKey = new Set<string>();
  const addRelation = (r: Relation) => {
    const key = `${r.type}|${r.from}|${r.to}`;
    if (r.from === r.to || relKey.has(key)) return;
    relKey.add(key);
    relations.push(r);
  };
  for (const r of results) {
    for (const rel of r.relations) {
      const from = canonicalId(rel.from);
      const to = canonicalId(rel.to);
      if (from && to) addRelation({ type: rel.type, from, to, source: extractorRef(r.extractor) });
    }
  }

  // Different-type items from different extractors that cite the same text: keep both, link them.
  const kept = groups.map((g) => g.canonical);
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const a = kept[i];
      const b = kept[j];
      if (a.extractor === b.extractor || a.item.type === b.item.type || a.annotation.origin !== b.annotation.origin) continue;
      if (spanOverlap(annotations[a.item.id].evidence, annotations[b.item.id].evidence) >= 0.8) {
        addRelation({ type: 'same_evidence', from: a.item.id, to: b.item.id, source: RECONCILER_ID });
      }
    }
  }

  return {
    items,
    annotations,
    relations,
    diagnostics,
    report: { candidates: candidates.length, items: items.length, merged, by_extractor: byExtractor },
  };
}
