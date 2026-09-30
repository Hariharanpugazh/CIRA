/**
 * User-controlled context selection (pure; shared by the side panel and the
 * service worker).
 *
 *   captured Conversation ──(selected message indexes)──► Phase 01 encoder
 *     ──► draft PCO (every extracted item) ──(selected item IDs)──► final PCO
 *
 * The encoder only ever receives the selected messages. Each selected message
 * keeps its original position, so turn IDs and provenance still say
 * "message 7" when message 7 was picked. Item IDs are deterministic, so the
 * draft reviewed in the side panel and the document re-built in the service
 * worker agree on which item is which.
 */
import {
  decode,
  encode,
  fromLegacyConversation,
  getSemanticExtension,
  SEMANTIC_EXTENSION,
  type ContextItem,
  type DecodedContext,
  type ExtractionMode,
  type PCODocument,
  type SemanticAnnotation,
  type SemanticExtension,
} from '@cira/core';
import type { Conversation } from './schema';

export interface ContextSelection {
  /** Positions in `conversation.messages` (0-based). */
  messageIndexes: number[];
  /** Item IDs from the draft to keep. Omit to keep every extracted item. */
  itemIds?: string[];
}

export interface SelectionMetadata {
  message_indexes: number[];
  total_messages: number;
  extracted_items: number;
  selected_items: number;
}

/** Stored under `extensions["cira.browser"].selection`. */
export const SELECTION_EXTENSION = 'cira.browser';

export class SelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelectionError';
  }
}

export interface BuildOptions {
  /** Connector identity, e.g. "cira-browser-extension@0.1.0". */
  client: string;
  now?: Date;
}

export interface BuiltContext {
  /** Everything the encoder extracted from the selected messages. */
  draft: PCODocument;
  /** Draft minus the items the user removed. What gets saved and sent. */
  document: PCODocument;
  warnings: string[];
}

function normalizeIndexes(indexes: readonly number[], total: number): number[] {
  const out = [...new Set(indexes)].filter((i) => Number.isInteger(i) && i >= 0 && i < total).sort((a, b) => a - b);
  if (out.length === 0) throw new SelectionError('Select at least one message to continue.');
  return out;
}

/** Deduplicated, in-range, sorted message indexes; throws SelectionError when empty. */
export function normalizeMessageIndexes(indexes: readonly number[], total: number): number[] {
  return normalizeIndexes(indexes, total);
}

/** The selected messages, in conversation order (for the relay payload). */
export function selectMessages(conversation: Conversation, messageIndexes: readonly number[]): Conversation {
  const keep = new Set(normalizeIndexes(messageIndexes, conversation.messages.length));
  return { ...conversation, messages: conversation.messages.filter((_, i) => keep.has(i)) };
}

export function withSelectionMeta(doc: PCODocument, meta: SelectionMetadata): PCODocument {
  const previous = (doc.extensions?.[SELECTION_EXTENSION] ?? {}) as Record<string, unknown>;
  return { ...doc, extensions: { ...doc.extensions, [SELECTION_EXTENSION]: { ...previous, selection: meta } } };
}

/**
 * Encode ONLY the selected messages with the Phase 01 encoder, then drop the
 * items the user deselected. Throws SelectionError for an empty message
 * selection or unknown item IDs.
 */
export function buildSelectedContext(conversation: Conversation, selection: ContextSelection, options: BuildOptions): BuiltContext {
  const total = conversation.messages.length;
  const indexes = normalizeIndexes(selection.messageIndexes, total);
  const keep = new Set(indexes);

  const { input, warnings } = fromLegacyConversation(conversation, { kind: 'browser', client: options.client, now: options.now });
  const selected = { ...input, turns: input.turns.map((t, index) => ({ ...t, index })).filter((t) => keep.has(t.index)) };
  const encoded = encode(selected, { createdBy: options.client, now: options.now });

  const meta = (selectedItems: number): SelectionMetadata => ({
    message_indexes: indexes,
    total_messages: total,
    extracted_items: encoded.items.length,
    selected_items: selectedItems,
  });
  const draft = withSelectionMeta(encoded, meta(encoded.items.length));

  if (selection.itemIds === undefined) return { draft, document: draft, warnings };

  const known = new Set(encoded.items.map((i) => i.id));
  const unknown = selection.itemIds.filter((id) => !known.has(id));
  if (unknown.length) throw new SelectionError(`Unknown context item(s): ${unknown.join(', ')}. Review the selection again.`);
  const wanted = new Set(selection.itemIds);
  const items = encoded.items.filter((i) => wanted.has(i.id));
  return { draft, document: withSelectionMeta({ ...encoded, items }, meta(items.length)), warnings };
}

export function selectionMetaOf(doc: PCODocument): SelectionMetadata | undefined {
  return (doc.extensions?.[SELECTION_EXTENSION] as { selection?: SelectionMetadata } | undefined)?.selection;
}

/** Extraction mode a draft was built with ("deterministic" when it has no semantic extension). */
export function draftMode(doc: PCODocument): ExtractionMode {
  return getSemanticExtension(doc)?.mode ?? 'deterministic';
}

/**
 * Keep only the chosen items of an ALREADY REVIEWED draft (semantic / hybrid).
 * Unlike buildSelectedContext this never re-extracts: a model would not
 * return the same items twice, so the reviewed draft is the source of truth.
 * Annotations and relations of removed items are dropped with them.
 */
export function applyItemSelection(draft: PCODocument, itemIds?: readonly string[]): PCODocument {
  if (itemIds === undefined) return draft;
  const known = new Set(draft.items.map((i) => i.id));
  const unknown = itemIds.filter((id) => !known.has(id));
  if (unknown.length) throw new SelectionError(`Unknown context item(s): ${unknown.join(', ')}. Review the selection again.`);
  const wanted = new Set(itemIds);
  const items = draft.items.filter((i) => wanted.has(i.id));

  let extensions = draft.extensions;
  const sem = draft.extensions?.[SEMANTIC_EXTENSION] as SemanticExtension | undefined;
  if (sem && typeof sem === 'object') {
    const annotations = Object.fromEntries(Object.entries(sem.items ?? {}).filter(([id]) => wanted.has(id)));
    const relations = (sem.relations ?? []).filter((r) => wanted.has(r.from) && wanted.has(r.to));
    extensions = { ...extensions, [SEMANTIC_EXTENSION]: { ...sem, items: annotations, relations } };
  }
  const doc: PCODocument = { ...draft, items, ...(extensions ? { extensions } : {}) };
  const meta = selectionMetaOf(draft);
  return meta ? withSelectionMeta(doc, { ...meta, selected_items: items.length }) : doc;
}

/** Original message number (1-based) an item was extracted from, for "Source: Message 4". */
export function itemMessageNumber(doc: PCODocument, item: ContextItem): number | undefined {
  const turnId = item.provenance.turn_id;
  if (!turnId) return undefined;
  for (const c of doc.conversations) {
    const t = c.turns.find((x) => x.id === turnId);
    if (t) return t.index + 1;
  }
  return undefined;
}

/** Rough size estimate for the review summary (~4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function fence(code: string, language: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${language === 'text' ? '' : language}\n${code}\n${ticks}`;
}

/**
 * Marker for items the user did not state themselves. Only semantic/hybrid
 * documents carry annotations, so deterministic handoffs are unchanged.
 */
export function attributionNote(annotation: SemanticAnnotation | undefined): string {
  if (!annotation) return '';
  switch (annotation.origin) {
    case 'assistant':
      return annotation.assertion === 'suggested' ? ' (assistant suggestion, not confirmed by the user)' : ' (stated by the assistant)';
    case 'tool':
      return ' (from a tool result)';
    case 'unknown':
      return ' (source unclear)';
    default:
      return '';
  }
}

function renderItems(ctx: DecodedContext): string[] {
  const out: string[] = [];
  const one = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();
  for (const section of ctx.sections) {
    out.push(`## ${section.label}`);
    for (const { item, annotation } of section.items) {
      const note = attributionNote(annotation);
      switch (item.type) {
        case 'constraint':
          out.push(`- ${item.strength.replace('_', ' ').toUpperCase()}: ${one(item.content)}${note}`);
          break;
        case 'task':
          out.push(`- [${item.status === 'done' ? 'x' : ' '}] ${one(item.content)}${note}`);
          break;
        case 'reference':
          out.push(`- ${item.title ? `${item.title}: ` : ''}${item.uri}${note}`);
          break;
        case 'code_artifact':
          out.push(`${item.filename ? `${item.filename}:\n` : ''}${note ? `${note.trim()}\n` : ''}${fence(item.content, item.language)}`);
          break;
        case 'decision':
          // A semantic "proposed" decision is an idea on the table, not a choice the user made.
          out.push(`- ${annotation && item.status === 'proposed' ? 'PROPOSED: ' : ''}${one(item.content)}${note}`);
          break;
        default:
          out.push(`- ${one(item.content)}${note}`);
      }
    }
    out.push('');
  }
  return out;
}

/**
 * Handoff text injected into the target AI when the user sends a reviewed
 * context. Built only from the final PCO's items, so deselected messages and
 * items never reach the target.
 */
export function buildPcoHandoff(doc: PCODocument, meta: { source: string; title?: string; capturedAt?: string }): string {
  const ctx = decode(doc);
  const messages = selectionMetaOf(doc);
  const semantic = getSemanticExtension(doc);
  const lines = [
    `# Context handoff from ${meta.source.toUpperCase()}`,
    ...(meta.title ? [`Title: ${meta.title}`] : []),
    ...(meta.capturedAt ? [`Captured: ${meta.capturedAt}`] : []),
    ...(messages ? [`Selected: ${messages.message_indexes.length} of ${messages.total_messages} messages, ${ctx.total_items} context items`] : []),
    '',
    'You are continuing a conversation that started in another AI assistant.',
    'The user selected the context below. Treat it as your own prior memory of this project.',
    ...(semantic
      ? ['Items marked as assistant suggestions or PROPOSED were ideas from the previous assistant, not requirements the user set.']
      : []),
    '',
    ...renderItems(ctx),
    '## Your job',
    'Acknowledge the handoff in one sentence, then continue helping from this context.',
  ];
  return lines.join('\n');
}
