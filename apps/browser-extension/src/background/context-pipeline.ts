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
  type ContextStore,
  type ContextSummary,
  type PCODocument,
} from '@cira/core';
import type { Conversation } from '@/shared/schema';

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

export type SaveContextResponse = SaveContextSuccess | SaveContextFailure;

export interface PipelineDeps {
  store: ContextStore;
  sync?: (doc: PCODocument) => Promise<SyncResult>;
  /** e.g. "cira-browser-extension@0.1.0" */
  client: string;
  now?: () => Date;
}

export async function saveConversationAsPco(conversation: Conversation, deps: PipelineDeps): Promise<SaveContextResponse> {
  try {
    const { document, warnings } = migrateLegacyConversation(conversation, {
      client: deps.client,
      createdBy: deps.client,
      now: (deps.now ?? (() => new Date()))(),
    });

    const validation = validate(document);
    if (!validation.ok) {
      return { ok: false, error: `Encoded PCO failed validation: ${validation.errors.map((e) => e.message).join('; ')}` };
    }

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
