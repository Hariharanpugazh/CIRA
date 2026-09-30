/**
 * Decoder: PCO → target-neutral decoded context.
 *
 * Decoding groups items by type, applies optional filters and resolves
 * provenance. It does not know about any target (ChatGPT, VS Code, …):
 * connectors turn a `DecodedContext` into their own prompt/format, and
 * `renderMarkdown()` is the generic human/agent-readable rendering.
 */
import { CONTEXT_ITEM_TYPES } from '../pco/schema';
import { resolveProvenance, type ResolvedProvenance } from '../provenance';
import type { ContextItem, ContextItemType, ExtractionMethod, PCODocument, SourceRef } from '../types';

/** Presentation order: what an agent most needs to respect comes first. */
export const SECTION_ORDER: readonly ContextItemType[] = [
  'constraint',
  'decision',
  'preference',
  'fact',
  'task',
  'question',
  'code_artifact',
  'reference',
];

export const SECTION_LABELS: Record<ContextItemType, string> = {
  constraint: 'Constraints',
  decision: 'Decisions',
  preference: 'Preferences',
  fact: 'Facts',
  task: 'Tasks',
  question: 'Questions',
  code_artifact: 'Code',
  reference: 'References',
};

export interface DecodeOptions {
  /** Only include these item types. */
  types?: readonly ContextItemType[];
  /** Drop items below this confidence (0..1). */
  minConfidence?: number;
  /** Only include items whose provenance points at these conversations. */
  conversationIds?: readonly string[];
}

export interface DecodedItem<T extends ContextItem = ContextItem> {
  item: T;
  provenance: ResolvedProvenance;
}

export interface DecodedSection {
  type: ContextItemType;
  label: string;
  items: DecodedItem[];
}

export interface DecodedConversation {
  id: string;
  title?: string;
  platform: string;
  kind: SourceRef['kind'];
  url?: string;
  captured_at: string;
  turn_count: number;
}

export interface DecodedContext {
  document_id: string;
  pco_version: string;
  title?: string;
  created_at: string;
  updated_at: string;
  conversations: DecodedConversation[];
  /** Non-empty sections in SECTION_ORDER. */
  sections: DecodedSection[];
  total_items: number;
  /** Items in the document before filtering. */
  available_items: number;
  methods: ExtractionMethod[];
  filters: DecodeOptions;
}

export function isContextItemType(value: string): value is ContextItemType {
  return (CONTEXT_ITEM_TYPES as readonly string[]).includes(value);
}

export function decode(doc: PCODocument, options: DecodeOptions = {}): DecodedContext {
  const types = options.types ? new Set(options.types) : undefined;
  const convIds = options.conversationIds ? new Set(options.conversationIds) : undefined;
  const minConfidence = options.minConfidence ?? 0;

  const selected = doc.items.filter(
    (item) =>
      (!types || types.has(item.type)) &&
      item.confidence >= minConfidence &&
      (!convIds || (item.provenance.conversation_id !== undefined && convIds.has(item.provenance.conversation_id))),
  );

  const byType = new Map<ContextItemType, DecodedItem[]>();
  for (const item of selected) {
    const list = byType.get(item.type) ?? [];
    list.push({ item, provenance: resolveProvenance(doc, item) });
    byType.set(item.type, list);
  }

  const sections: DecodedSection[] = SECTION_ORDER.filter((t) => byType.has(t)).map((type) => ({
    type,
    label: SECTION_LABELS[type],
    items: byType.get(type)!,
  }));

  const methods = [...new Set(selected.map((i) => i.provenance.extracted_by.method))].sort();

  const decoded: DecodedContext = {
    document_id: doc.id,
    pco_version: doc.pco_version,
    created_at: doc.metadata.created_at,
    updated_at: doc.metadata.updated_at,
    conversations: doc.conversations.map((c) => {
      const d: DecodedConversation = {
        id: c.id,
        platform: c.source.platform,
        kind: c.source.kind,
        captured_at: c.captured_at,
        turn_count: c.turns.length,
      };
      if (c.title) d.title = c.title;
      if (c.url) d.url = c.url;
      return d;
    }),
    sections,
    total_items: selected.length,
    available_items: doc.items.length,
    methods,
    filters: { ...options },
  };
  if (doc.metadata.title) decoded.title = doc.metadata.title;
  return decoded;
}
