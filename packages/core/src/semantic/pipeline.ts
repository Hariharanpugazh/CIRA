/**
 * Extraction pipeline with explicit modes.
 *
 *   ConversationInput ──selectTurns──► selected turns only ──► ExtractionInput
 *        ├─ deterministic: rules only (identical to Phase 01 `encode()`, no network)
 *        ├─ semantic:      semantic extractor only
 *        └─ hybrid:        rules + semantic → reconcile (falls back to rules if the semantic step fails)
 *   ──► PCO v0.1 document (+ extensions["cira.semantic"] for semantic/hybrid) ──► validate
 *
 * The default mode is `deterministic`: nothing leaves the process unless a
 * caller explicitly configures a semantic extractor AND picks a mode that uses it.
 */
import { assembleDocument, buildConversation, dedupeItems, toIso, type EncodeOptions } from '../encoder/encode';
import type { ConversationInput } from '../encoder/types';
import type { ContextItem, PCODocument } from '../types';
import { assertValid } from '../validation/validate';
import {
  SEMANTIC_EXTENSION,
  SEMANTIC_EXTENSION_VERSION,
  validateSemanticExtension,
  type ExtractionMode,
  type ExtractorInfo,
  type Relation,
  type SemanticAnnotation,
  type SemanticExtension,
} from './annotations';
import { createDeterministicExtractor } from './deterministic-extractor';
import { reconcile, type ReconcileReport } from './reconcile';
import { ExtractionError, type ContextExtractor, type ExtractionDiagnostic, type ExtractionResult } from './types';

export class TurnSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnSelectionError';
  }
}

/**
 * Keep only the selected turns, preserving their ORIGINAL indices so turn IDs
 * and provenance still say "message 7". `indexes` are 0-based positions in
 * `input.turns`. Duplicates are ignored; out-of-range indexes are an error.
 */
export function selectTurns(input: ConversationInput, indexes: readonly number[]): ConversationInput {
  const total = input.turns.length;
  const bad = indexes.filter((i) => !Number.isInteger(i) || i < 0 || i >= total);
  if (bad.length) throw new TurnSelectionError(`message selection out of range: ${bad.join(', ')} (conversation has ${total} messages)`);
  const keep = new Set(indexes);
  if (keep.size === 0) throw new TurnSelectionError('select at least one message');
  return {
    ...input,
    turns: input.turns.map((t, position) => ({ ...t, index: t.index ?? position })).filter((_, position) => keep.has(position)),
  };
}

export interface ExtractContextOptions extends Pick<EncodeOptions, 'id' | 'title' | 'description' | 'createdBy' | 'extensions'> {
  /** Default "deterministic". */
  mode?: ExtractionMode;
  /** Required for "semantic" and "hybrid". */
  semantic?: ContextExtractor;
  /** Override the rule-based extractor (defaults to the Phase 01 rules). */
  deterministic?: ContextExtractor;
  /** 0-based message positions to extract from. Omit to use every message. */
  selection?: readonly number[];
  now?: Date | string;
}

export interface ExtractContextResult {
  document: PCODocument;
  mode: ExtractionMode;
  /** True when hybrid mode fell back to deterministic-only because the semantic step failed. */
  fallback: boolean;
  results: ExtractionResult[];
  diagnostics: ExtractionDiagnostic[];
  reconciliation?: ReconcileReport;
  /** Number of messages that entered extraction. */
  selectedMessages: number;
}

export async function extractContext(
  input: ConversationInput | readonly ConversationInput[],
  options: ExtractContextOptions = {},
): Promise<ExtractContextResult> {
  const mode = options.mode ?? 'deterministic';
  const inputs = (Array.isArray(input) ? input : [input as ConversationInput]).map((c) =>
    options.selection ? selectTurns(c, options.selection) : c,
  );
  if (options.selection && inputs.length !== 1) throw new TurnSelectionError('a message selection applies to exactly one conversation');
  if ((mode === 'semantic' || mode === 'hybrid') && !options.semantic) {
    throw new ExtractionError(`${mode} mode requires a semantic extractor (configure a provider, or use --mode deterministic)`);
  }

  const now = toIso(options.now);
  const conversations = inputs.map(buildConversation);
  const deterministic = options.deterministic ?? createDeterministicExtractor();
  const diagnostics: ExtractionDiagnostic[] = [];
  const results: ExtractionResult[] = [];
  const selectedMessages = conversations.reduce((n, c) => n + c.turns.length, 0);

  const run = async (ex: ContextExtractor) => {
    const out: ExtractionResult[] = [];
    for (const conversation of conversations) {
      out.push(await ex.extract({ conversation, source: conversation.source, now }));
    }
    return out;
  };

  // ── deterministic: byte-compatible with Phase 01 encode() ───────────────
  if (mode === 'deterministic') {
    const det = await run(deterministic);
    results.push(...det);
    const items = dedupeItems(det.flatMap((r) => r.items));
    const document = assertValid(assembleDocument(conversations, items, now, options));
    return { document, mode, fallback: false, results, diagnostics: det.flatMap((r) => r.diagnostics), selectedMessages };
  }

  // ── semantic / hybrid ───────────────────────────────────────────────────
  let fallback = false;
  let semResults: ExtractionResult[] = [];
  try {
    semResults = await run(options.semantic!);
  } catch (err) {
    if (mode === 'semantic' || !(err instanceof ExtractionError)) throw err;
    fallback = true;
    diagnostics.push(...err.diagnostics, {
      level: 'warning',
      code: 'semantic_fallback',
      message: `semantic extraction failed (${err.message}); using deterministic extraction only`,
    });
  }
  const detResults = mode === 'hybrid' ? await run(deterministic) : [];
  results.push(...detResults, ...semResults);
  for (const r of results) diagnostics.push(...r.diagnostics);

  const rec = reconcile(results);
  diagnostics.push(...rec.diagnostics);

  const extractors: ExtractorInfo[] = [];
  for (const r of results) if (!extractors.some((e) => e.id === r.extractor.id && e.version === r.extractor.version)) extractors.push(r.extractor);

  const extension: SemanticExtension = {
    version: SEMANTIC_EXTENSION_VERSION,
    mode,
    extractors,
    items: rec.annotations as Record<string, SemanticAnnotation>,
    relations: rec.relations as Relation[],
    ...(fallback ? { fallback: true } : {}),
  };
  const items: ContextItem[] = rec.items;
  const document = assertValid(
    assembleDocument(conversations, items, now, { ...options, extensions: { ...options.extensions, [SEMANTIC_EXTENSION]: extension } }),
  );
  for (const issue of validateSemanticExtension(document)) {
    diagnostics.push({ level: 'error', code: `semantic_${issue.code}`, message: issue.message });
  }
  return { document, mode, fallback, results, diagnostics, reconciliation: rec.report, selectedMessages };
}
