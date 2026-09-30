/**
 * Semantic / hybrid draft extraction for the side panel (runs in the service
 * worker, so the provider API key never reaches a page or content script).
 *
 *   captured Conversation ──(selected indexes)──► Core extractContext(mode)
 *     ├─ semantic: selected turns → OpenAI-compatible provider → validated items
 *     └─ hybrid:   rules + semantic → reconcile (explicit fallback to rules)
 *   ──► draft PCO (+ cira.semantic, + cira.browser selection metadata)
 *
 * Only the selected messages are put in the prompt (Core's selectTurns +
 * semantic extractor privacy boundary). The draft is returned to the side
 * panel for review; saving reuses that reviewed draft and never re-extracts.
 * Deterministic mode is not handled here: the side panel builds it locally,
 * exactly as before.
 */
import {
  createOpenAICompatibleProvider,
  createSemanticExtractor,
  extractContext,
  ExtractionError,
  fromLegacyConversation,
  isLoopbackUrl,
  ProviderError,
  scanForSecrets,
  TurnSelectionError,
  type ExtractionDiagnostic,
  type HttpTransport,
  type PCODocument,
} from '@cira/core';
import { normalizeMessageIndexes, SelectionError, withSelectionMeta } from '@/shared/context-selection';
import {
  BROWSER_SEMANTIC_TIMEOUT_MS,
  providerHost,
  providerOriginPattern,
  providerProblem,
  type ExtractionMode,
  type ProviderSettings,
} from '@/shared/extraction-settings';
import type { Conversation } from '@/shared/schema';

export type DraftErrorCode =
  | 'not_configured'
  | 'permission'
  | 'secrets'
  | 'unreachable'
  | 'forbidden'
  | 'unauthorized'
  | 'http'
  | 'timeout'
  | 'invalid_output'
  | 'too_large'
  | 'selection'
  | 'unknown';

export interface DraftProviderInfo {
  host: string;
  locality: 'local' | 'remote';
  model: string;
}

export interface BuildDraftSuccess {
  ok: true;
  draft: PCODocument;
  mode: Exclude<ExtractionMode, 'deterministic'>;
  /** Hybrid only: the semantic step failed and the draft is deterministic-only. */
  fallback: boolean;
  /** Why the semantic step failed (hybrid fallback). No conversation text. */
  fallbackReason?: string;
  provider: DraftProviderInfo;
  /** Messages that entered extraction (== the selection). */
  selectedMessages: number;
  /** Candidate counts etc. Content-free. */
  notes: string[];
}

export interface BuildDraftFailure {
  ok: false;
  code: DraftErrorCode;
  error: string;
}

export type BuildDraftResponse = BuildDraftSuccess | BuildDraftFailure;

export interface BuildDraftRequest {
  messageIndexes: number[];
  mode: Exclude<ExtractionMode, 'deterministic'>;
}

export interface DraftDeps {
  client: string;
  provider: ProviderSettings;
  apiKey?: string;
  /** Injected in tests; defaults to fetch. */
  transport?: HttpTransport;
  /** chrome.permissions.contains for the provider origin. */
  hasPermission?: (originPattern: string) => Promise<boolean>;
  now?: () => Date;
  timeoutMs?: number;
}

const fail = (code: DraftErrorCode, error: string): BuildDraftFailure => ({ ok: false, code, error });

/** Content-free, user-facing explanation of a failed semantic step. */
export function describeSemanticFailure(diagnostics: readonly ExtractionDiagnostic[], fallbackMessage: string, provider: ProviderSettings): { code: DraftErrorCode; message: string } {
  const host = providerHost(provider) || 'the provider';
  const local = isLoopbackUrl(provider.baseUrl);
  const d = diagnostics.find((x) => x.level === 'error') ?? diagnostics[0];
  const code = d?.code ?? '';
  const text = d?.message ?? fallbackMessage;
  const status = Number(/HTTP (\d{3})/.exec(text)?.[1] ?? NaN);

  if (code === 'provider_network') {
    return { code: 'unreachable', message: local ? `Could not reach ${host}. Is Ollama (or your local model server) running?` : `Could not reach ${host}.` };
  }
  if (code === 'provider_timeout') return { code: 'timeout', message: `${host} did not answer within ${Math.round(BROWSER_SEMANTIC_TIMEOUT_MS / 1000)} s. Try fewer messages or a smaller model.` };
  if (code === 'provider_http') {
    if (status === 401) return { code: 'unauthorized', message: `${host} rejected the request (HTTP 401). Check the API key.` };
    if (status === 403) {
      return {
        code: 'forbidden',
        message: local
          ? `${host} refused the request (HTTP 403). Ollama blocks browser extensions unless OLLAMA_ORIGINS includes chrome-extension://* (then restart Ollama).`
          : `${host} refused the request (HTTP 403).`,
      };
    }
    if (status === 404) return { code: 'http', message: `${host} returned HTTP 404. Check the endpoint URL and that the model "${provider.model}" is installed.` };
    return { code: 'http', message: text };
  }
  if (code === 'provider_bad_response' || code === 'invalid_output' || code === 'schema_issue') {
    return { code: 'invalid_output', message: `The model's answer did not match CIRA's context schema. Retry, or try a larger model.` };
  }
  if (code === 'input_too_large') return { code: 'too_large', message: 'The selection is too large for semantic extraction. Select fewer messages.' };
  if (code === 'provider_config') return { code: 'not_configured', message: text };
  return { code: 'unknown', message: text || 'Semantic extraction failed.' };
}

/** Build a semantic or hybrid draft from ONLY the selected messages. */
export async function buildSemanticDraft(conversation: Conversation, request: BuildDraftRequest, deps: DraftDeps): Promise<BuildDraftResponse> {
  const mode = request.mode;
  if (mode !== 'semantic' && mode !== 'hybrid') return fail('unknown', `Unsupported extraction mode: ${String(mode)}`);

  let indexes: number[];
  try {
    indexes = normalizeMessageIndexes(request.messageIndexes, conversation.messages.length);
  } catch (err) {
    return fail('selection', err instanceof Error ? err.message : String(err));
  }

  const problem = providerProblem(deps.provider);
  if (problem) return fail('not_configured', problem);
  const host = providerHost(deps.provider);
  const local = isLoopbackUrl(deps.provider.baseUrl);

  const pattern = providerOriginPattern(deps.provider.baseUrl);
  if (deps.hasPermission && pattern && !(await deps.hasPermission(pattern).catch(() => false))) {
    return fail('permission', `CIRA needs your permission to reach ${host}. Press Continue to Review again and allow access.`);
  }

  // A remote provider must never receive secrets that happen to be in the selection.
  if (!local) {
    const withSecrets = indexes.filter((i) => scanForSecrets(conversation.messages[i].content).length > 0);
    if (withSecrets.length) {
      return fail(
        'secrets',
        `Message${withSecrets.length === 1 ? '' : 's'} ${withSecrets.map((i) => `#${i + 1}`).join(', ')} may contain secrets, so ${host} was not contacted. Deselect ${withSecrets.length === 1 ? 'it' : 'them'}, use a local model, or switch to Deterministic.`,
      );
    }
  }

  const now = (deps.now ?? (() => new Date()))();
  try {
    const provider = createOpenAICompatibleProvider({
      baseUrl: deps.provider.baseUrl,
      model: deps.provider.model,
      ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
      ...(deps.transport ? { transport: deps.transport } : {}),
      timeoutMs: deps.timeoutMs ?? BROWSER_SEMANTIC_TIMEOUT_MS,
    });
    const semantic = createSemanticExtractor({ provider });
    const { input } = fromLegacyConversation(conversation, { kind: 'browser', client: deps.client, now });
    const result = await extractContext(input, { mode, semantic, selection: indexes, createdBy: deps.client, now });

    const draft = withSelectionMeta(result.document, {
      message_indexes: indexes,
      total_messages: conversation.messages.length,
      extracted_items: result.document.items.length,
      selected_items: result.document.items.length,
    });
    const fallbackReason = result.fallback ? describeSemanticFailure(result.diagnostics, 'Semantic extraction failed.', deps.provider).message : undefined;
    const notes = result.diagnostics.filter((d) => d.code === 'summary').map((d) => d.message);
    return {
      ok: true,
      draft,
      mode,
      fallback: result.fallback,
      ...(fallbackReason ? { fallbackReason } : {}),
      provider: { host, locality: provider.locality, model: provider.model },
      selectedMessages: result.selectedMessages,
      notes,
    };
  } catch (err) {
    if (err instanceof ExtractionError) {
      const { code, message } = describeSemanticFailure(err.diagnostics, err.message, deps.provider);
      return fail(code, message);
    }
    if (err instanceof ProviderError) return fail(err.code === 'config' ? 'not_configured' : 'unknown', err.message);
    if (err instanceof TurnSelectionError || err instanceof SelectionError) return fail('selection', err.message);
    return fail('unknown', err instanceof Error ? err.message : String(err));
  }
}
