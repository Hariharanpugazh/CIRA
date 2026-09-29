/**
 * Encoder: Conversation(s) → Portable Context Object.
 *
 * The transcript is kept verbatim in `conversations[]` so nothing is lost;
 * `items[]` holds the extracted context, each with provenance pointing back
 * at the exact conversation, turn and character span.
 *
 * Deterministic: the same input + options produce the same IDs.
 */
import { PCO_VERSION } from '../pco/version';
import { createProvenance } from '../provenance';
import type { ContextItem, PCODocument, PcoConversation, Turn } from '../types';
import { makeId } from '../util/hash';
import { codeBlockExtractor, referenceExtractor } from './extractors/deterministic';
import { heuristicStatementExtractor } from './extractors/heuristic';
import { findFencedBlocks, maskRanges, normalizeForDedupe } from './text';
import type { ConversationInput, ItemExtractor } from './types';

export const DEFAULT_EXTRACTORS: readonly ItemExtractor[] = [
  codeBlockExtractor,
  referenceExtractor,
  heuristicStatementExtractor,
];

export const ENCODER_ID = 'cira.encoder@0.1.0';

export interface EncodeOptions {
  /** Document ID. Derived from the conversation IDs when omitted. */
  id?: string;
  title?: string;
  description?: string;
  /** Clock override (tests, reproducible builds). */
  now?: Date | string;
  /** Recorded as metadata.created_by.agent, e.g. "cira-browser-extension@0.1.0". */
  createdBy?: string;
  extractors?: readonly ItemExtractor[];
  /** Drop items with the same type + normalised content. Default true. */
  dedupe?: boolean;
  extensions?: Record<string, unknown>;
}

/** Path part of a URL without relying on the host `URL` API. */
function urlPath(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url);
  return (m?.[1] ?? '').replace(/\/+$/, '');
}

/**
 * Conversation IDs are stable per conversation URL, so re-capturing the same
 * chat updates the same PCO instead of creating a new one. URLs without a
 * path (e.g. a fresh "new chat" page) fall back to capture time + title.
 */
export function deriveConversationId(input: Pick<ConversationInput, 'source' | 'url' | 'captured_at' | 'title'>): string {
  if (input.url && urlPath(input.url).length > 0) {
    return makeId('conv', input.source.platform, input.url.split('#')[0]);
  }
  return makeId('conv', input.source.platform, input.url, input.captured_at, input.title);
}

function toIso(now: Date | string | undefined): string {
  if (now === undefined) return new Date().toISOString();
  return typeof now === 'string' ? now : now.toISOString();
}

function dedupeKey(item: ContextItem): string {
  switch (item.type) {
    case 'code_artifact':
      return `code|${item.language}|${item.content.trim()}`;
    case 'reference':
      return `ref|${item.uri}`;
    default:
      return `${item.type}|${normalizeForDedupe(item.content)}`;
  }
}

export function buildConversation(input: ConversationInput): PcoConversation {
  const id = input.id ?? deriveConversationId(input);
  const conv: PcoConversation = {
    id,
    source: { ...input.source },
    captured_at: input.captured_at,
    turns: input.turns.map((t, index): Turn => {
      const turn: Turn = { id: `${id}_t${index}`, index, role: t.role, content: t.content };
      if (t.timestamp) turn.timestamp = t.timestamp;
      if (t.attachments?.length) turn.attachments = t.attachments.map((a) => ({ ...a }));
      return turn;
    }),
  };
  if (input.title) conv.title = input.title;
  if (input.url) conv.url = input.url;
  return conv;
}

export function extractItems(
  conversation: PcoConversation,
  extractors: readonly ItemExtractor[],
  createdAt: string,
): ContextItem[] {
  const items: ContextItem[] = [];
  for (const turn of conversation.turns) {
    const prose = maskRanges(turn.content, findFencedBlocks(turn.content));
    for (const ex of extractors) {
      for (const draft of ex.extract({ conversation, turn, prose })) {
        const { span, ...rest } = draft;
        const provenance = createProvenance({
          conversation,
          turn,
          span,
          method: ex.method,
          agent: `${ex.id}@${ex.version}`,
        });
        const id = makeId('itm', turn.id, rest.type, span?.start, span?.end, rest.content);
        items.push({ ...rest, id, provenance, created_at: createdAt } as ContextItem);
      }
    }
  }
  return items;
}

export function encode(input: ConversationInput | readonly ConversationInput[], options: EncodeOptions = {}): PCODocument {
  const inputs = Array.isArray(input) ? input : [input as ConversationInput];
  const now = toIso(options.now);
  const extractors = options.extractors ?? DEFAULT_EXTRACTORS;

  const conversations = inputs.map(buildConversation);

  let items = conversations.flatMap((c) => extractItems(c, extractors, now));
  if (options.dedupe !== false) {
    const seen = new Set<string>();
    items = items.filter((item) => {
      const key = dedupeKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  // Guarantee ID uniqueness even for pathological inputs.
  const ids = new Set<string>();
  items = items.filter((i) => (ids.has(i.id) ? false : (ids.add(i.id), true)));

  const title = options.title ?? (conversations.length === 1 ? conversations[0].title : undefined);
  const doc: PCODocument = {
    pco_version: PCO_VERSION,
    id: options.id ?? makeId('pco', ...conversations.map((c) => c.id).sort()),
    metadata: {
      created_at: now,
      updated_at: now,
      created_by: { agent: options.createdBy ?? ENCODER_ID },
    },
    conversations,
    items,
  };
  if (title) doc.metadata.title = title;
  if (options.description) doc.metadata.description = options.description;
  if (options.extensions) doc.extensions = { ...options.extensions };
  return doc;
}
