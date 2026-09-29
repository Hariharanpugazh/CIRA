/**
 * Provenance helpers: build provenance records and answer
 * "where did this piece of context come from?".
 */
import type {
  ContextItem,
  ExtractionMethod,
  PCODocument,
  PcoConversation,
  Provenance,
  Role,
  SourceKind,
  Span,
  Turn,
} from '../types';

export interface ProvenanceInput {
  conversation: PcoConversation;
  turn?: Turn;
  span?: Span;
  method: ExtractionMethod;
  agent: string;
}

export function createProvenance(input: ProvenanceInput): Provenance {
  const p: Provenance = {
    source: { ...input.conversation.source },
    conversation_id: input.conversation.id,
    captured_at: input.conversation.captured_at,
    extracted_by: { method: input.method, agent: input.agent },
  };
  if (input.turn) p.turn_id = input.turn.id;
  if (input.turn && input.span) p.span = { start: input.span.start, end: input.span.end };
  return p;
}

/** Provenance with references resolved against the document. */
export interface ResolvedProvenance {
  platform: string;
  kind: SourceKind;
  client?: string;
  conversation_id?: string;
  conversation_title?: string;
  conversation_url?: string;
  turn_id?: string;
  turn_index?: number;
  role?: Role;
  captured_at: string;
  method: ExtractionMethod;
  agent: string;
  span?: Span;
  /** The exact source text the item was extracted from, when a span exists. */
  excerpt?: string;
}

export function resolveProvenance(doc: PCODocument, item: ContextItem): ResolvedProvenance {
  const p = item.provenance;
  const conv = p.conversation_id ? doc.conversations.find((c) => c.id === p.conversation_id) : undefined;
  const turn = conv && p.turn_id ? conv.turns.find((t) => t.id === p.turn_id) : undefined;
  const resolved: ResolvedProvenance = {
    platform: p.source.platform,
    kind: p.source.kind,
    captured_at: p.captured_at,
    method: p.extracted_by.method,
    agent: p.extracted_by.agent,
  };
  if (p.source.client) resolved.client = p.source.client;
  if (conv) {
    resolved.conversation_id = conv.id;
    if (conv.title) resolved.conversation_title = conv.title;
    if (conv.url) resolved.conversation_url = conv.url;
  }
  if (turn) {
    resolved.turn_id = turn.id;
    resolved.turn_index = turn.index;
    resolved.role = turn.role;
    if (p.span) {
      resolved.span = { ...p.span };
      resolved.excerpt = turn.content.slice(p.span.start, p.span.end);
    }
  }
  return resolved;
}

/** One-line human description, e.g. `chatgpt · "Trip" · turn 2 (user) · heuristic`. */
export function describeProvenance(r: ResolvedProvenance, opts: { includeCapturedAt?: boolean } = {}): string {
  const parts: string[] = [r.platform];
  if (r.conversation_title) parts.push(`"${r.conversation_title}"`);
  if (r.turn_index !== undefined) parts.push(`turn ${r.turn_index}${r.role ? ` (${r.role})` : ''}`);
  if (opts.includeCapturedAt) parts.push(`captured ${r.captured_at}`);
  parts.push(r.method);
  return parts.join(' · ');
}

/** Answer "where did item X come from?". Returns undefined if the item is unknown. */
export function explainItem(doc: PCODocument, itemId: string): ResolvedProvenance | undefined {
  const item = doc.items.find((i) => i.id === itemId);
  return item ? resolveProvenance(doc, item) : undefined;
}
