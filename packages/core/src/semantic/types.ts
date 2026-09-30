/**
 * Conversation-level extractor contract.
 *
 *   Transcript ──► ExtractionInput ──► ContextExtractor ──► ExtractionResult ──► reconcile ──► PCO items
 *
 * Every extractor (deterministic rules, a local model, a remote API, …)
 * implements the same interface, so providers are replaceable and results
 * are comparable. Extractors never mutate a PCO; they return candidates.
 */
import type { ContextItem, PcoConversation, SourceRef } from '../types';
import type { ExtractorInfo, SemanticAnnotation } from './annotations';

export interface ExtractionInput {
  /**
   * The conversation to extract from. Its `turns` are exactly the turns the
   * user selected (the selection boundary is applied before this object is
   * built), with their ORIGINAL indices and IDs.
   */
  conversation: PcoConversation;
  /** Convenience copy of `conversation.source`. */
  source: SourceRef;
  /** Clock for created_at (deterministic tests). ISO 8601. */
  now: string;
  metadata?: Record<string, unknown>;
}

export type DiagnosticLevel = 'info' | 'warning' | 'error';

/**
 * Diagnostics never contain conversation text: only codes, counts, item refs
 * and short reasons, so they are safe to log.
 */
export interface ExtractionDiagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  /** Provider-side item reference (e.g. "i3") or PCO item ID. */
  ref?: string;
}

export interface ExtractionUsage {
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
}

export interface ExtractionResult {
  extractor: ExtractorInfo;
  /** Candidate items with PCO provenance (conversation, turn, span, capture time, extractor). */
  items: ContextItem[];
  /** Semantic metadata keyed by item ID. Every item has an annotation. */
  annotations: Record<string, SemanticAnnotation>;
  /** Relations the extractor asserted between its own items. */
  relations: Array<{ type: 'supersedes' | 'conflicts_with'; from: string; to: string }>;
  diagnostics: ExtractionDiagnostic[];
  usage?: ExtractionUsage;
}

export interface ContextExtractor {
  readonly info: ExtractorInfo;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export class ExtractionError extends Error {
  readonly diagnostics: ExtractionDiagnostic[];
  constructor(message: string, diagnostics: ExtractionDiagnostic[] = []) {
    super(message);
    this.name = 'ExtractionError';
    this.diagnostics = diagnostics;
  }
}

/** `id@version`, the identity recorded in provenance and annotations. */
export function extractorRef(info: Pick<ExtractorInfo, 'id' | 'version'>): string {
  return `${info.id}@${info.version}`;
}
