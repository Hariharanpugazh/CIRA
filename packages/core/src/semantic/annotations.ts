/**
 * Semantic metadata stored alongside PCO v0.1 items, in
 * `extensions["cira.semantic"]`. The core PCO schema is unchanged: documents
 * without this extension are ordinary v0.1 documents, and readers that do not
 * know the extension simply ignore it.
 */
import { z } from 'zod';
import { IdSchema, SpanSchema } from '../pco/schema';
import type { PCODocument, Strict } from '../types';

export const SEMANTIC_EXTENSION = 'cira.semantic';
export const SEMANTIC_EXTENSION_VERSION = 1;

/** Who introduced the information: the role of the turn the evidence is in. */
export const ORIGINS = ['user', 'assistant', 'system', 'tool', 'unknown'] as const;
/** How the information is asserted. */
export const ASSERTIONS = ['explicit', 'inferred', 'suggested', 'quoted', 'unknown'] as const;
export const EXTRACTION_MODES = ['deterministic', 'semantic', 'hybrid'] as const;
export const RELATION_TYPES = ['supersedes', 'conflicts_with', 'same_evidence'] as const;

export const OriginSchema = z.enum(ORIGINS);
export const AssertionSchema = z.enum(ASSERTIONS);
export const ExtractionModeSchema = z.enum(EXTRACTION_MODES);

export const EvidenceSchema = z.object({
  turn_id: IdSchema,
  /** Character range in the turn content; present when the evidence was located exactly. */
  span: SpanSchema.optional(),
});

export const SemanticAnnotationSchema = z.object({
  origin: OriginSchema,
  assertion: AssertionSchema,
  evidence: z.array(EvidenceSchema),
  /** `id@version` of every extractor that produced this item. */
  extractors: z.array(z.string().min(1)).min(1),
  /** Candidates merged into this item by reconciliation. */
  merged_from: z
    .array(z.object({ extractor: z.string(), type: z.string(), content: z.string(), confidence: z.number() }))
    .optional(),
});

export const ExtractorInfoSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  kind: z.enum(['deterministic', 'semantic']),
  /** Where the conversation text was processed. */
  locality: z.enum(['local', 'remote']),
  provider: z.string().optional(),
  model: z.string().optional(),
});

export const RelationSchema = z.object({
  type: z.enum(RELATION_TYPES),
  /** For `supersedes`: `from` is the newer item that may replace `to`. */
  from: IdSchema,
  to: IdSchema,
  source: z.string().min(1),
});

export const SemanticExtensionSchema = z.object({
  version: z.literal(SEMANTIC_EXTENSION_VERSION),
  mode: ExtractionModeSchema,
  extractors: z.array(ExtractorInfoSchema),
  items: z.record(z.string(), SemanticAnnotationSchema),
  relations: z.array(RelationSchema),
  /** Hybrid mode only: the semantic extractor failed and only deterministic items are present. */
  fallback: z.boolean().optional(),
});

export type Origin = z.infer<typeof OriginSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;
export type ExtractionMode = z.infer<typeof ExtractionModeSchema>;
export type Evidence = Strict<z.infer<typeof EvidenceSchema>>;
export type SemanticAnnotation = Strict<z.infer<typeof SemanticAnnotationSchema>>;
export type ExtractorInfo = Strict<z.infer<typeof ExtractorInfoSchema>>;
export type Relation = Strict<z.infer<typeof RelationSchema>>;
export type SemanticExtension = Strict<z.infer<typeof SemanticExtensionSchema>>;

export interface SemanticIssue {
  code: 'invalid_extension' | 'unknown_item' | 'unknown_turn' | 'invalid_span' | 'origin_mismatch' | 'unknown_relation_target';
  message: string;
}

/** Read the semantic extension (undefined when absent). Does not validate. */
export function getSemanticExtension(doc: PCODocument): SemanticExtension | undefined {
  const raw = doc.extensions?.[SEMANTIC_EXTENSION];
  const r = SemanticExtensionSchema.safeParse(raw);
  return r.success ? (r.data as SemanticExtension) : undefined;
}

/** Semantic annotation of one item, if the document carries one. */
export function getAnnotation(doc: PCODocument, itemId: string): SemanticAnnotation | undefined {
  return getSemanticExtension(doc)?.items[itemId];
}

/**
 * Validate the extension against the document it lives in. PCO `validate()`
 * deliberately ignores extensions; call this where semantic data matters.
 * Returns [] for documents without the extension.
 */
export function validateSemanticExtension(doc: PCODocument): SemanticIssue[] {
  const raw = doc.extensions?.[SEMANTIC_EXTENSION];
  if (raw === undefined) return [];
  const parsed = SemanticExtensionSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({ code: 'invalid_extension' as const, message: `${i.path.join('.') || '$'}: ${i.message}` }));
  }
  const ext = parsed.data;
  const issues: SemanticIssue[] = [];
  const itemIds = new Set(doc.items.map((i) => i.id));
  const turns = new Map(doc.conversations.flatMap((c) => c.turns.map((t) => [t.id, t] as const)));

  for (const [id, a] of Object.entries(ext.items)) {
    if (!itemIds.has(id)) issues.push({ code: 'unknown_item', message: `annotation for unknown item ${id}` });
    for (const ev of a.evidence) {
      const turn = turns.get(ev.turn_id);
      if (!turn) {
        issues.push({ code: 'unknown_turn', message: `item ${id}: evidence turn ${ev.turn_id} is not in the document` });
        continue;
      }
      if (ev.span && (ev.span.end <= ev.span.start || ev.span.end > turn.content.length)) {
        issues.push({ code: 'invalid_span', message: `item ${id}: evidence span is outside turn ${ev.turn_id}` });
      }
    }
    const first = a.evidence[0] && turns.get(a.evidence[0].turn_id);
    if (first && a.origin !== 'unknown' && first.role !== a.origin && a.assertion !== 'quoted') {
      issues.push({ code: 'origin_mismatch', message: `item ${id}: origin ${a.origin} but evidence is a ${first.role} turn` });
    }
  }
  for (const r of ext.relations) {
    if (!itemIds.has(r.from) || !itemIds.has(r.to)) {
      issues.push({ code: 'unknown_relation_target', message: `relation ${r.type} ${r.from} → ${r.to} references a missing item` });
    }
  }
  return issues;
}
