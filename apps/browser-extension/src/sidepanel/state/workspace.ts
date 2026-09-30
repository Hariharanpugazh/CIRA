/**
 * Side panel workspace state machine (pure, no chrome.* — unit tested).
 *
 *   idle ──Read chat──► select ──Continue──► review ──Continue──► send ──Save/Send──► success
 *                          ◄──────Back──────    ◄──────Back──────
 *
 * Invariants:
 *  - Searching only changes what is visible; it never changes the selection.
 *  - Back keeps every selection. Item removals are remembered by ID, so a
 *    re-extraction after changing the message selection keeps them removed.
 */
import type { PCODocument } from '@cira/core';
import type { SyncResult } from '@/background/context-pipeline';
import type { DraftErrorCode, DraftProviderInfo } from '@/background/extraction';
import type { ContextSelection } from '@/shared/context-selection';
import { DEFAULT_PROVIDER, type ExtractionMode, type ExtractionSettings, type ProviderSettings } from '@/shared/extraction-settings';
import type { Conversation, Role } from '@/shared/schema';

export type Step = 'idle' | 'select' | 'review' | 'send' | 'success';
export const FLOW_STEPS = ['select', 'review', 'send'] as const;

export interface CapturedMessage {
  /** Position in the captured conversation (0-based); shown as #index+1. */
  index: number;
  role: Role;
  content: string;
  /** Whitespace-collapsed start of the message for the compact row. */
  preview: string;
  /** Lower-cased content used by search. */
  haystack: string;
  /** Long enough to offer "Show more". */
  long: boolean;
}

export interface ActiveContext {
  id: string;
  title: string;
  source: string;
  messageCount: number;
  totalMessages: number;
  itemCount: number;
  updatedAt: string;
  saved: boolean;
  sync?: SyncResult;
  sentTo?: string;
  document: PCODocument;
  /** What was picked, so "Edit" can reopen the review. */
  conversation: Conversation;
  selection: ContextSelection;
  /** Absent on contexts saved before Phase 02C (= deterministic). */
  mode?: ExtractionMode;
  /**
   * Semantic / hybrid only: the full reviewed draft, so "Edit" reopens the
   * same items instead of calling the model again.
   */
  draft?: PCODocument;
}

/** How the current draft was produced (semantic / hybrid only). */
export interface DraftInfo {
  mode: ExtractionMode;
  fallback: boolean;
  fallbackReason?: string;
  provider?: DraftProviderInfo;
}

export interface SemanticFailure {
  code: DraftErrorCode;
  message: string;
}

export type BusyKind = 'reading' | 'extracting' | 'saving' | 'sending' | 'syncing';
export interface Busy {
  kind: BusyKind;
  label: string;
}

export interface Outcome {
  messageCount: number;
  itemCount: number;
  saved: boolean;
  sync?: SyncResult;
  sentTo?: string;
  safetyWarnings: string[];
}

export interface WorkspaceState {
  step: Step;
  conversation: Conversation | null;
  messages: CapturedMessage[];
  selectedMessages: ReadonlySet<number>;
  /** Last message clicked without Shift (range start). */
  anchor: number | null;
  query: string;
  draft: PCODocument | null;
  /** Message selection the draft was built from. */
  draftKey: string | null;
  /** Item IDs the user removed during review. */
  removedItems: ReadonlySet<string>;
  target: string | null;
  saveLocally: boolean;
  busy: Busy | null;
  error: string | null;
  outcome: Outcome | null;
  active: ActiveContext | null;
  /** Extraction mode for the next "Continue to Review". Default deterministic. */
  mode: ExtractionMode;
  provider: ProviderSettings;
  /** Semantic provider config panel open (Semantic / Hybrid only). */
  providerOpen: boolean;
  draftInfo: DraftInfo | null;
  /** Semantic / hybrid extraction failed; offers Retry and Switch to Deterministic. */
  semanticError: SemanticFailure | null;
}

export const initialWorkspace: WorkspaceState = {
  step: 'idle',
  conversation: null,
  messages: [],
  selectedMessages: new Set(),
  anchor: null,
  query: '',
  draft: null,
  draftKey: null,
  removedItems: new Set(),
  target: null,
  saveLocally: true,
  busy: null,
  error: null,
  outcome: null,
  active: null,
  mode: 'deterministic',
  provider: DEFAULT_PROVIDER,
  providerOpen: false,
  draftInfo: null,
  semanticError: null,
};

export type WorkspaceAction =
  | { type: 'capture/start' }
  | { type: 'capture/ok'; conversation: Conversation }
  | { type: 'capture/fail'; error: string }
  | { type: 'restore'; conversation: Conversation; selection: ContextSelection; removedItems: string[]; draft: PCODocument; mode?: ExtractionMode }
  | { type: 'settings/loaded'; settings: ExtractionSettings }
  | { type: 'mode/set'; mode: ExtractionMode }
  | { type: 'provider/set'; provider: ProviderSettings }
  | { type: 'provider/open'; open: boolean }
  | { type: 'review/semantic-fail'; failure: SemanticFailure }
  | { type: 'message/toggle'; index: number; range?: boolean }
  | { type: 'messages/all' }
  | { type: 'messages/none' }
  | { type: 'messages/invert' }
  | { type: 'query'; query: string }
  | { type: 'review/start' }
  | { type: 'review/ok'; draft: PCODocument; key: string; info?: DraftInfo | null }
  | { type: 'review/fail'; error: string }
  | { type: 'item/toggle'; id: string }
  | { type: 'items/all' }
  | { type: 'items/none' }
  | { type: 'send/open' }
  | { type: 'back' }
  | { type: 'target'; target: string | null }
  | { type: 'saveLocally'; value: boolean }
  | { type: 'submit/start'; kind: 'saving' | 'sending'; label: string }
  | { type: 'submit/ok'; outcome: Outcome; active: ActiveContext }
  | { type: 'submit/fail'; error: string }
  | { type: 'sync/start' }
  | { type: 'sync/done'; sync: SyncResult }
  | { type: 'active/set'; active: ActiveContext | null }
  | { type: 'error/dismiss' }
  | { type: 'reset' };

const PREVIEW_CHARS = 220;

export function toCapturedMessages(conversation: Conversation): CapturedMessage[] {
  return conversation.messages.map((m, index) => {
    // Compact preview: fenced code shows as a short marker; the full text is one click away.
    const flat = m.content
      .replace(/```([\w+#-]*)[^\n]*\n[\s\S]*?```/g, (_, lang: string) => ` [${lang || 'code'} block] `)
      .replace(/\s+/g, ' ')
      .trim();
    return {
      index,
      role: m.role,
      content: m.content,
      preview: flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…` : flat,
      haystack: m.content.toLowerCase(),
      long: flat.length > PREVIEW_CHARS || m.content.split('\n').length > 4 || m.content.includes('```'),
    };
  });
}

/** Messages matching the search query, in conversation order. */
export function visibleMessages(state: Pick<WorkspaceState, 'messages' | 'query'>): CapturedMessage[] {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.messages;
  const terms = q.split(/\s+/);
  return state.messages.filter((m) => terms.every((t) => m.haystack.includes(t)));
}

export function selectionKey(selected: ReadonlySet<number>): string {
  return [...selected].sort((a, b) => a - b).join(',');
}

/**
 * What a draft was built from: the mode, the provider (semantic / hybrid) and
 * the message selection. A draft is reused only when all three match.
 */
export function draftKeyFor(selected: ReadonlySet<number>, mode: ExtractionMode, provider?: ProviderSettings): string {
  const via = mode === 'deterministic' || !provider ? '' : `@${provider.baseUrl}|${provider.model}`;
  return `${mode}${via}:${selectionKey(selected)}`;
}

export function busyLabelFor(mode: ExtractionMode): string {
  return mode === 'deterministic' ? 'Extracting context…' : 'Extracting context… Using semantic model…';
}

export function selectedMessageIndexes(state: Pick<WorkspaceState, 'selectedMessages'>): number[] {
  return [...state.selectedMessages].sort((a, b) => a - b);
}

/** Draft items the user kept, in draft order. */
export function selectedItemIds(state: Pick<WorkspaceState, 'draft' | 'removedItems'>): string[] {
  return (state.draft?.items ?? []).filter((i) => !state.removedItems.has(i.id)).map((i) => i.id);
}

export function currentSelection(state: WorkspaceState): ContextSelection {
  return { messageIndexes: selectedMessageIndexes(state), itemIds: selectedItemIds(state) };
}

function withSelection(state: WorkspaceState, indexes: Iterable<number>, value: boolean): WorkspaceState {
  const next = new Set(state.selectedMessages);
  for (const i of indexes) {
    if (value) next.add(i);
    else next.delete(i);
  }
  return { ...state, selectedMessages: next, error: null };
}

const EMPTY_MESSAGES = 'Select at least one message to continue.';
const EMPTY_ITEMS = 'Select at least one context item to continue.';

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'capture/start':
      return { ...state, busy: { kind: 'reading', label: 'Reading conversation…' }, error: null };

    case 'capture/ok': {
      const messages = toCapturedMessages(action.conversation);
      return {
        ...state,
        step: 'select',
        conversation: action.conversation,
        messages,
        // Default: everything selected; the user removes what they don't want.
        selectedMessages: new Set(messages.map((m) => m.index)),
        anchor: null,
        query: '',
        draft: null,
        draftKey: null,
        draftInfo: null,
        removedItems: new Set(),
        target: null,
        busy: null,
        error: null,
        semanticError: null,
        outcome: null,
      };
    }

    case 'capture/fail':
      return { ...state, busy: null, error: action.error };

    // "Edit" on the active context: back to Review with the previous choices.
    case 'restore': {
      const messages = toCapturedMessages(action.conversation);
      const selected = new Set(action.selection.messageIndexes.filter((i) => i >= 0 && i < messages.length));
      return {
        ...state,
        step: 'review',
        conversation: action.conversation,
        messages,
        selectedMessages: selected,
        anchor: null,
        query: '',
        draft: action.draft,
        // Restored drafts are keyed by their own mode (not the provider), so they are
        // reused as-is until the messages or the mode change.
        mode: action.mode ?? 'deterministic',
        draftKey: draftKeyFor(selected, action.mode ?? 'deterministic', action.mode && action.mode !== 'deterministic' ? state.provider : undefined),
        draftInfo: action.mode && action.mode !== 'deterministic' ? { mode: action.mode, fallback: false } : null,
        removedItems: new Set(action.removedItems),
        target: null,
        busy: null,
        error: null,
        semanticError: null,
        outcome: null,
      };
    }

    case 'settings/loaded':
      return { ...state, mode: action.settings.extractionMode, provider: action.settings.provider };
    case 'mode/set':
      return {
        ...state,
        mode: action.mode,
        providerOpen: action.mode === 'deterministic' ? false : state.providerOpen,
        semanticError: null,
        error: null,
      };
    case 'provider/set':
      return { ...state, provider: action.provider, semanticError: null };
    case 'provider/open':
      return { ...state, providerOpen: action.open };
    case 'review/semantic-fail':
      // Selection, conversation and any previous draft stay untouched.
      return { ...state, busy: null, error: null, semanticError: action.failure };

    case 'message/toggle': {
      const value = !state.selectedMessages.has(action.index);
      if (action.range && state.anchor !== null && state.anchor !== action.index) {
        const visible = visibleMessages(state).map((m) => m.index);
        const a = visible.indexOf(state.anchor);
        const b = visible.indexOf(action.index);
        if (a !== -1 && b !== -1) {
          const [from, to] = a < b ? [a, b] : [b, a];
          return { ...withSelection(state, visible.slice(from, to + 1), value), anchor: action.index };
        }
      }
      return { ...withSelection(state, [action.index], value), anchor: action.index };
    }

    // Bulk actions apply to what is visible, so "search, then Select all" picks the matches.
    case 'messages/all':
      return withSelection(state, visibleMessages(state).map((m) => m.index), true);
    case 'messages/none':
      return withSelection(state, visibleMessages(state).map((m) => m.index), false);
    case 'messages/invert': {
      const next = new Set(state.selectedMessages);
      for (const m of visibleMessages(state)) {
        if (next.has(m.index)) next.delete(m.index);
        else next.add(m.index);
      }
      return { ...state, selectedMessages: next, error: null };
    }

    case 'query':
      return { ...state, query: action.query };

    case 'review/start':
      if (state.selectedMessages.size === 0) return { ...state, error: EMPTY_MESSAGES };
      return { ...state, busy: { kind: 'extracting', label: busyLabelFor(state.mode) }, error: null, semanticError: null };

    case 'review/ok':
      return {
        ...state,
        step: 'review',
        draft: action.draft,
        draftKey: action.key,
        draftInfo: action.info === undefined ? state.draftInfo : action.info,
        busy: null,
        error: null,
        semanticError: null,
      };

    case 'review/fail':
      return { ...state, busy: null, error: action.error };

    case 'item/toggle': {
      const next = new Set(state.removedItems);
      if (next.has(action.id)) next.delete(action.id);
      else next.add(action.id);
      return { ...state, removedItems: next, error: null };
    }
    case 'items/all': {
      const next = new Set(state.removedItems);
      for (const i of state.draft?.items ?? []) next.delete(i.id);
      return { ...state, removedItems: next, error: null };
    }
    case 'items/none': {
      const next = new Set(state.removedItems);
      for (const i of state.draft?.items ?? []) next.add(i.id);
      return { ...state, removedItems: next };
    }

    case 'send/open':
      if (selectedItemIds(state).length === 0) return { ...state, error: EMPTY_ITEMS };
      return { ...state, step: 'send', error: null };

    case 'back': {
      const prev: Partial<Record<Step, Step>> = { review: 'select', send: 'review', success: 'send' };
      const to = prev[state.step];
      return to ? { ...state, step: to, error: null, semanticError: null, busy: null } : state;
    }

    case 'target':
      return { ...state, target: action.target, error: null };
    case 'saveLocally':
      return { ...state, saveLocally: action.value, error: null };

    case 'submit/start':
      if (!state.saveLocally && !state.target) return { ...state, error: 'Choose a target AI or Save locally.' };
      return { ...state, busy: { kind: action.kind, label: action.label }, error: null };
    case 'submit/ok':
      return { ...state, step: 'success', busy: null, error: null, outcome: action.outcome, active: action.active };
    case 'submit/fail':
      return { ...state, busy: null, error: action.error };

    case 'sync/start':
      return { ...state, busy: { kind: 'syncing', label: 'Retrying local sync…' } };
    case 'sync/done': {
      const outcome = state.outcome ? { ...state.outcome, sync: action.sync } : state.outcome;
      const active = state.active ? { ...state.active, sync: action.sync } : state.active;
      return { ...state, busy: null, outcome, active };
    }

    case 'active/set':
      return { ...state, active: action.active };
    case 'error/dismiss':
      return { ...state, error: null, semanticError: null };
    case 'reset':
      // Settings are the user's choice, not part of one context.
      return { ...initialWorkspace, active: state.active, mode: state.mode, provider: state.provider };
  }
}
