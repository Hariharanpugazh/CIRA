import type {
  Attachment,
  ContextItem,
  DistributiveOmit,
  ExtractionMethod,
  PcoConversation,
  Role,
  SourceRef,
  Span,
  Turn,
} from '../types';

/** Environment-neutral transcript input accepted by the encoder. */
export interface TurnInput {
  role: Role;
  content: string;
  timestamp?: string;
  attachments?: Attachment[];
  /**
   * Position of this turn in the source conversation. Defaults to its position
   * in `turns`. Set it when encoding a subset of a conversation (e.g. messages
   * the user selected) so turn IDs and provenance keep pointing at the
   * original message numbers. Must be unique within the conversation.
   */
  index?: number;
}

export interface ConversationInput {
  /** Stable ID. Derived from source + URL (or capture time) when omitted. */
  id?: string;
  source: SourceRef;
  title?: string;
  url?: string;
  /** ISO 8601 with offset. */
  captured_at: string;
  turns: TurnInput[];
}

/** What an extractor produces; the encoder adds id, provenance and created_at. */
export type ItemDraft = DistributiveOmit<ContextItem, 'id' | 'provenance' | 'created_at'> & {
  /** Location of the item within the turn content. */
  span?: Span;
};

/** Input of a per-turn rule (`ItemExtractor`). */
export interface TurnExtractionInput {
  conversation: PcoConversation;
  turn: Turn;
  /** Turn content with fenced code blocks blanked out (offsets preserved). */
  prose: string;
}

/**
 * Pluggable per-turn rule used by the deterministic encoder (code blocks,
 * links, heuristic statements). Conversation-level extractors (deterministic
 * or semantic) implement `ContextExtractor` in `../semantic/types`.
 */
export interface ItemExtractor {
  readonly id: string;
  readonly version: string;
  readonly method: ExtractionMethod;
  extract(input: TurnExtractionInput): ItemDraft[];
}
