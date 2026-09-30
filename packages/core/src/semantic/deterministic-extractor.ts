/**
 * The Phase 01 rule-based extractor behind the `ContextExtractor` interface.
 *
 * It runs exactly the same per-turn rules as `encode()` (code blocks, links,
 * heuristic statements) and returns identical items, so deterministic mode is
 * byte-compatible with Phase 01. It is the offline, privacy-first baseline and
 * the fallback when no semantic provider is configured or it fails.
 *
 * Its annotations are honest about what rules can know: origin is the role of
 * the turn the text came from; assertion is `explicit` only for literal copies
 * (code, links), `suggested` for assistant proposals, otherwise `unknown`.
 */
import { DEFAULT_EXTRACTORS, dedupeItems, extractItems } from '../encoder/encode';
import type { ItemExtractor } from '../encoder/types';
import type { ContextItem, PcoConversation } from '../types';
import type { Origin, SemanticAnnotation } from './annotations';
import type { ContextExtractor, ExtractionResult } from './types';

export const DETERMINISTIC_EXTRACTOR_ID = 'cira.deterministic';
export const DETERMINISTIC_EXTRACTOR_VERSION = '0.1.0';

export interface DeterministicExtractorOptions {
  rules?: readonly ItemExtractor[];
  /** Phase 01 de-duplication by type + normalised content. Default true. */
  dedupe?: boolean;
}

export function originOfTurn(conversation: PcoConversation, turnId: string | undefined): Origin {
  const turn = turnId ? conversation.turns.find((t) => t.id === turnId) : undefined;
  return turn ? turn.role : 'unknown';
}

export function deterministicAnnotation(conversation: PcoConversation, item: ContextItem): SemanticAnnotation {
  const p = item.provenance;
  const origin = originOfTurn(conversation, p.turn_id);
  const literal = p.extracted_by.method === 'deterministic';
  const assertion =
    literal ? 'explicit' : item.type === 'decision' && item.status === 'proposed' ? 'suggested' : 'unknown';
  return {
    origin,
    assertion,
    evidence: p.turn_id ? [{ turn_id: p.turn_id, ...(p.span ? { span: { ...p.span } } : {}) }] : [],
    extractors: [p.extracted_by.agent],
  };
}

export function createDeterministicExtractor(options: DeterministicExtractorOptions = {}): ContextExtractor {
  const rules = options.rules ?? DEFAULT_EXTRACTORS;
  return {
    info: {
      id: DETERMINISTIC_EXTRACTOR_ID,
      version: DETERMINISTIC_EXTRACTOR_VERSION,
      kind: 'deterministic',
      locality: 'local',
    },
    async extract(input): Promise<ExtractionResult> {
      const started = Date.now();
      const items = dedupeItems(extractItems(input.conversation, rules, input.now), options.dedupe !== false);
      const annotations: Record<string, SemanticAnnotation> = {};
      for (const item of items) annotations[item.id] = deterministicAnnotation(input.conversation, item);
      return {
        extractor: this.info,
        items,
        annotations,
        relations: [],
        diagnostics: [],
        usage: { duration_ms: Date.now() - started },
      };
    },
  };
}
