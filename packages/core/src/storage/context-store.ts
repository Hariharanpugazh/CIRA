/**
 * Storage abstraction for PCO documents.
 *
 *   CIRA Core → ContextStore → { InMemory | KeyValue(chrome.storage, …) | File | future SQLite / E2E sync }
 *
 * Contract (all implementations):
 *  - `put` validates the document and rejects invalid ones (PcoValidationError).
 *  - `put` with an existing id replaces it; `metadata.created_at` of the
 *    stored version is kept so re-capturing a conversation updates it.
 *  - `get` returns null for unknown ids.
 *  - `list` returns lightweight summaries, most recently updated first.
 *  - `delete` returns whether something was removed.
 */
import type { PCODocument } from '../types';
import { assertValid } from '../validation/validate';

export interface ContextSummary {
  id: string;
  title?: string;
  pco_version: string;
  created_at: string;
  updated_at: string;
  item_count: number;
  conversation_count: number;
  /** Distinct `kind/platform` pairs, e.g. ["browser/chatgpt"]. */
  sources: string[];
  item_counts: Partial<Record<PCODocument['items'][number]['type'], number>>;
}

export interface ContextStore {
  put(document: PCODocument): Promise<ContextSummary>;
  get(id: string): Promise<PCODocument | null>;
  list(): Promise<ContextSummary[]>;
  delete(id: string): Promise<boolean>;
}

export function summarize(doc: PCODocument): ContextSummary {
  const item_counts: ContextSummary['item_counts'] = {};
  for (const item of doc.items) item_counts[item.type] = (item_counts[item.type] ?? 0) + 1;
  const summary: ContextSummary = {
    id: doc.id,
    pco_version: doc.pco_version,
    created_at: doc.metadata.created_at,
    updated_at: doc.metadata.updated_at,
    item_count: doc.items.length,
    conversation_count: doc.conversations.length,
    sources: [...new Set(doc.conversations.map((c) => `${c.source.kind}/${c.source.platform}`))],
    item_counts,
  };
  if (doc.metadata.title) summary.title = doc.metadata.title;
  return summary;
}

export function sortSummaries(list: ContextSummary[]): ContextSummary[] {
  return [...list].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.id.localeCompare(b.id)));
}

/**
 * Shared `put` preparation: validate, then keep the original creation time
 * when replacing an existing document.
 */
export function prepareForPut(doc: PCODocument, existing: PCODocument | null): PCODocument {
  const valid = assertValid(doc);
  if (!existing) return valid;
  const created = existing.metadata.created_at;
  if (created === valid.metadata.created_at) return valid;
  return { ...valid, metadata: { ...valid.metadata, created_at: created < valid.metadata.created_at ? created : valid.metadata.created_at } };
}
