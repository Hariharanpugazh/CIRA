/**
 * Browser connector pipeline:
 *
 *   captured Conversation → legacy migration + encode (Core) → validate (Core)
 *     → safety scan (Core) → ContextStore (chrome.storage) → optional local sync (~/.cira/contexts)
 *
 * Environment access (store, sync transport, clock) is injected so the
 * pipeline is unit-testable outside Chrome.
 */
import {
  migrateLegacyConversation,
  scanDocument,
  validate,
  validateSemanticExtension,
  type ContextStore,
  type ContextSummary,
  type PCODocument,
} from '@cira/core';
import type { Conversation } from '@/shared/schema';
import {
  applyItemSelection,
  buildSelectedContext,
  normalizeMessageIndexes,
  SelectionError,
  selectionMetaOf,
  type ContextSelection,
} from '@/shared/context-selection';

/**
 * Semantic / hybrid save: keep the chosen items of the draft the user
 * reviewed. Checks that the draft belongs to this conversation and selection
 * (only selected turns inside, same message indexes) before trusting it.
 */
function finalizeReviewedDraft(conversation: Conversation, draft: PCODocument, selection?: ContextSelection): { document: PCODocument; warnings: string[] } {
  if (!selection) throw new SelectionError('A reviewed draft needs its message selection.');
  const indexes = normalizeMessageIndexes(selection.messageIndexes, conversation.messages.length);
  const meta = selectionMetaOf(draft);
  if (!meta || meta.message_indexes.join(',') !== indexes.join(',') || meta.total_messages !== conversation.messages.length) {
    throw new SelectionError('The reviewed context does not match the selected messages. Review the selection again.');
  }
  const keep = new Set(indexes);
  const turns = draft.conversations.flatMap((c) => c.turns);
  if (draft.conversations.length !== 1 || turns.some((t) => !keep.has(t.index))) {
    throw new SelectionError('The reviewed context contains messages that were not selected. Review the selection again.');
  }
  return { document: applyItemSelection(draft, selection.itemIds), warnings: [] };
}

export type SyncResult =
  | { status: 'synced'; path: string }
  | { status: 'host_unavailable'; message: string }
  | { status: 'error'; message: string }
  | { status: 'skipped' };

export interface SaveContextSuccess {
  ok: true;
  id: string;
  summary: ContextSummary;
  /** Migration/validation warnings (not safety findings). */
  warnings: string[];
  safety: { hasFindings: boolean; findingCount: number; warnings: string[] };
  sync: SyncResult;
  document: PCODocument;
}

export interface SaveContextFailure {
  ok: false;
  error: string;
}

/** Retry the local sync of an already stored PCO (side panel "Retry"). */
export async function resyncStoredPco(id: string, deps: Pick<PipelineDeps, 'store' | 'sync'>): Promise<SyncResult> {
  const doc = await deps.store.get(id);
  if (!doc) return { status: 'error', message: `No stored context with id ${id}` };
  if (!deps.sync) return { status: 'skipped' };
  try {
    return await deps.sync(doc);
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export type SaveContextResponse = SaveContextSuccess | SaveContextFailure;

export interface PipelineDeps {
  store: ContextStore;
  sync?: (doc: PCODocument) => Promise<SyncResult>;
  /** e.g. "cira-browser-extension@0.1.0" */
  client: string;
  now?: () => Date;
}

/**
 * Without `selection` the whole conversation is encoded (Phase 01 behaviour,
 * used by the popup). With `selection` only the chosen messages reach the
 * encoder and only the chosen items are kept (side panel review flow).
 */
export async function saveConversationAsPco(
  conversation: Conversation,
  deps: PipelineDeps,
  selection?: ContextSelection,
  reviewedDraft?: PCODocument,
): Promise<SaveContextResponse> {
  try {
    const now = (deps.now ?? (() => new Date()))();
    const { document, warnings } = reviewedDraft
      ? finalizeReviewedDraft(conversation, reviewedDraft, selection)
      : selection
        ? buildSelectedContext(conversation, selection, { client: deps.client, now })
        : migrateLegacyConversation(conversation, { client: deps.client, createdBy: deps.client, now });

    const validation = validate(document);
    if (!validation.ok) {
      return { ok: false, error: `Encoded PCO failed validation: ${validation.errors.map((e) => e.message).join('; ')}` };
    }
    const semanticIssues = validateSemanticExtension(document);
    const blocking = semanticIssues.filter((i) => i.code === 'invalid_extension' || i.code === 'unknown_item' || i.code === 'unknown_turn');
    if (blocking.length) {
      return { ok: false, error: `Semantic metadata failed validation: ${blocking.map((i) => i.message).join('; ')}` };
    }
    warnings.push(...semanticIssues.filter((i) => !blocking.includes(i)).map((i) => `semantic: ${i.message}`));

    // Safety scan happens before anything is persisted, so the UI can warn.
    const safety = scanDocument(document);

    const summary = await deps.store.put(document);
    const stored = (await deps.store.get(document.id)) ?? document;

    let sync: SyncResult = { status: 'skipped' };
    if (deps.sync) {
      try {
        sync = await deps.sync(stored);
      } catch (err) {
        sync = { status: 'error', message: err instanceof Error ? err.message : String(err) };
      }
    }

    return {
      ok: true,
      id: document.id,
      summary,
      warnings: [...warnings, ...validation.warnings.map((w) => w.message)],
      safety: { hasFindings: safety.hasFindings, findingCount: safety.findings.length, warnings: safety.warnings },
      sync,
      document: stored,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
