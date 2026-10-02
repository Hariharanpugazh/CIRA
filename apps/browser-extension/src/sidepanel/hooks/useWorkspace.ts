/**
 * Wires the pure workspace reducer to Chrome: the active tab, capture,
 * extraction preview, save (service worker → ContextStore → native host),
 * relay staging and the persisted "active context".
 *
 * Extraction modes (Phase 02C):
 *  - deterministic (default): built here, synchronously, exactly as in Phase 01.
 *  - semantic / hybrid: built by the service worker (CIRA/BUILD_DRAFT) from the
 *    selected messages only, and only when the user presses Continue. Saving
 *    and sending reuse the reviewed draft; the model is never called again.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { getSemanticExtension, scanDocument } from '@cira/core';
import { detectSource } from '@/platform/detect';
import { TARGET_URLS } from '@/platform/urls';
import { buildDraft, listProviderModels as listProviderModelsRequest, retrySync as retrySyncRequest, saveContext } from '@/shared/context-client';
import type { ListModelsResponse } from '@/shared/context-client';
import { applyItemSelection, buildPcoHandoff, buildSelectedContext, draftMode, selectMessages } from '@/shared/context-selection';
import {
  API_KEY_STORAGE_KEY,
  normalizeSettings,
  providerOriginPattern,
  providerProblem,
  type ExtractionMode,
  type ExtractionSettings,
  type ProviderSettings,
} from '@/shared/extraction-settings';
import { STORAGE_KEYS, type RuntimeMessage } from '@/shared/messaging';
import { chromeTabApi, extractFromTab, NOT_CONNECTED_MESSAGE } from '@/shared/tab-connection';
import { brandFor } from '../brands';
import {
  currentSelection,
  draftKeyFor,
  initialWorkspace,
  selectedMessageIndexes,
  workspaceReducer,
  type ActiveContext,
  type WorkspaceState,
} from '../state/workspace';

export const ACTIVE_CONTEXT_KEY = 'cira.active.context';
export const SETTINGS_KEY = STORAGE_KEYS.settings;

export interface TabInfo {
  tabId: number | null;
  source: string;
  url?: string;
}

function clientId(): string {
  return `cira-browser-extension@${chrome.runtime.getManifest().version}`;
}

/** `?tab=<id>` pins the panel to one tab (used when the panel is opened as a page); otherwise the active tab. */
function pinnedTabId(): number | null {
  const raw = new URLSearchParams(globalThis.location?.search ?? '').get('tab');
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) ? n : null;
}

const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

/** chrome.storage.session is only available to trusted extension contexts; tolerate its absence. */
const session = () => (chrome.storage as { session?: chrome.storage.StorageArea }).session;

export function useWorkspace() {
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspace);
  const [tab, setTab] = useState<TabInfo>({ tabId: null, source: 'unknown' });
  /** Only whether a key is stored; the side panel never keeps the key itself. */
  const [hasApiKey, setHasApiKey] = useState(false);
  const stateRef = useRef<WorkspaceState>(state);
  stateRef.current = state;

  // --- tab tracking -------------------------------------------------------
  const refreshTab = useCallback(async () => {
    const pinned = pinnedTabId();
    const t = pinned !== null ? await chrome.tabs.get(pinned).catch(() => undefined) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    setTab(t ? { tabId: t.id ?? null, source: detectSource(t.url), url: t.url } : { tabId: null, source: 'unknown' });
  }, []);

  useEffect(() => {
    void refreshTab();
    const onChange = () => void refreshTab();
    chrome.tabs.onActivated.addListener(onChange);
    chrome.tabs.onUpdated.addListener(onChange);
    return () => {
      chrome.tabs.onActivated.removeListener(onChange);
      chrome.tabs.onUpdated.removeListener(onChange);
    };
  }, [refreshTab]);

  // --- active context + settings -----------------------------------------
  useEffect(() => {
    void chrome.storage.local.get(ACTIVE_CONTEXT_KEY).then((r) => {
      const active = r?.[ACTIVE_CONTEXT_KEY] as ActiveContext | undefined;
      if (active?.id) dispatch({ type: 'active/set', active });
    }).catch(() => {});
    void chrome.storage.local.get(SETTINGS_KEY).then((r) => {
      if (r?.[SETTINGS_KEY]) dispatch({ type: 'settings/loaded', settings: normalizeSettings(r[SETTINGS_KEY]) });
    }).catch(() => {});
    void Promise.resolve(session()?.get(API_KEY_STORAGE_KEY))
      .then((r) => setHasApiKey(typeof r?.[API_KEY_STORAGE_KEY] === 'string' && !!r[API_KEY_STORAGE_KEY]))
      .catch(() => {});
  }, []);

  const persistActive = useCallback(async (active: ActiveContext | null) => {
    if (active) await chrome.storage.local.set({ [ACTIVE_CONTEXT_KEY]: active });
    else await chrome.storage.local.remove(ACTIVE_CONTEXT_KEY);
  }, []);

  const persistSettings = useCallback(async (settings: ExtractionSettings) => {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => {});
  }, []);

  const setMode = useCallback((mode: ExtractionMode) => {
    dispatch({ type: 'mode/set', mode });
    void persistSettings({ extractionMode: mode, provider: stateRef.current.provider });
  }, [persistSettings]);

  const setProvider = useCallback((provider: ProviderSettings) => {
    dispatch({ type: 'provider/set', provider });
    void persistSettings({ extractionMode: stateRef.current.mode, provider });
  }, [persistSettings]);

  /** Store (or clear, with an empty string) the optional API key in session storage. */
  const setApiKey = useCallback(async (key: string) => {
    const area = session();
    if (!area) return;
    if (key.trim()) await area.set({ [API_KEY_STORAGE_KEY]: key.trim() });
    else await area.remove(API_KEY_STORAGE_KEY);
    setHasApiKey(!!key.trim());
  }, []);

  /**
   * Ask the configured provider which models the key can access, so the model
   * picker shows a live, accurate list. Requests the provider-origin
   * permission first (as part of this click) so a remote fetch is allowed.
   */
  const fetchModels = useCallback(async (): Promise<ListModelsResponse> => {
    const provider = stateRef.current.provider;
    const origin = providerOriginPattern(provider.baseUrl);
    if (origin && chrome.permissions?.request) {
      const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
      if (!granted) {
        return { ok: false, code: 'permission', error: `Access to ${new URL(provider.baseUrl).host} was not granted, so no models were listed.` };
      }
    }
    return listProviderModelsRequest();
  }, []);

  // --- flow ---------------------------------------------------------------
  const readChat = useCallback(async () => {
    if (tab.tabId === null) return;
    dispatch({ type: 'capture/start' });
    const r = await extractFromTab(chromeTabApi, tab.tabId);
    if (r.ok) dispatch({ type: 'capture/ok', conversation: r.conversation });
    else dispatch({ type: 'capture/fail', error: r.reason === 'not_connected' ? `${NOT_CONNECTED_MESSAGE} CIRA could not reach the page.` : r.message });
  }, [tab.tabId]);

  const reloadTab = useCallback(async () => {
    if (tab.tabId !== null) await chrome.tabs.reload(tab.tabId);
  }, [tab.tabId]);

  /**
   * The ONLY place a semantic provider is called, and only on an explicit
   * click (Continue to Review / Retry / Switch to Deterministic).
   */
  const continueToReview = useCallback(async (modeOverride?: ExtractionMode) => {
    const s = stateRef.current;
    const mode = modeOverride ?? s.mode;
    if (modeOverride && modeOverride !== s.mode) {
      dispatch({ type: 'mode/set', mode: modeOverride });
      void persistSettings({ extractionMode: modeOverride, provider: s.provider });
    }
    dispatch({ type: 'review/start' });
    if (!s.conversation || s.selectedMessages.size === 0) return;
    const key = draftKeyFor(s.selectedMessages, mode, s.provider);
    // A hybrid draft that fell back is not reused: Retry must try the model again.
    if (s.draft && s.draftKey === key && !getSemanticExtension(s.draft)?.fallback) {
      dispatch({ type: 'review/ok', draft: s.draft, key });
      return;
    }

    if (mode === 'deterministic') {
      await nextTick(); // let "Extracting context…" render
      try {
        const { draft } = buildSelectedContext(s.conversation, { messageIndexes: selectedMessageIndexes(s) }, { client: clientId() });
        dispatch({ type: 'review/ok', draft, key, info: null });
      } catch (err) {
        dispatch({ type: 'review/fail', error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const problem = providerProblem(s.provider);
    if (problem) {
      dispatch({ type: 'provider/open', open: true });
      dispatch({ type: 'review/semantic-fail', failure: { code: 'not_configured', message: problem } });
      return;
    }
    // Ask for access to exactly the provider's origin. This must be the first
    // await so it still counts as part of the user's click.
    const origin = providerOriginPattern(s.provider.baseUrl);
    if (origin && chrome.permissions?.request) {
      const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
      if (!granted) {
        dispatch({
          type: 'review/semantic-fail',
          failure: { code: 'permission', message: `Access to ${new URL(s.provider.baseUrl).host} was not granted, so nothing was sent.` },
        });
        return;
      }
    }

    const r = await buildDraft(s.conversation, selectedMessageIndexes(s), mode);
    if (r.ok) {
      dispatch({
        type: 'review/ok',
        draft: r.draft,
        key,
        info: { mode: r.mode, fallback: r.fallback, ...(r.fallbackReason ? { fallbackReason: r.fallbackReason } : {}), provider: r.provider },
      });
    } else {
      dispatch({ type: 'review/semantic-fail', failure: { code: r.code, message: r.error } });
    }
  }, [persistSettings]);

  const submit = useCallback(async () => {
    const s = stateRef.current;
    if (!s.conversation) return;
    const conversation = s.conversation;
    const target = s.target;
    const targetName = target ? brandFor(target).name : '';
    dispatch({ type: 'submit/start', kind: target ? 'sending' : 'saving', label: target ? `Sending to ${targetName}…` : 'Saving context…' });
    if (!s.saveLocally && !target) return;

    const selection = currentSelection(s);
    // Semantic / hybrid: the reviewed draft is final. Deterministic: rebuilt (Phase 01 behaviour).
    const reviewed = s.draft && draftMode(s.draft) !== 'deterministic' ? s.draft : undefined;
    let saved = false;
    try {
      let document;
      let sync;
      let safetyWarnings: string[] = [];
      if (s.saveLocally) {
        const r = await saveContext(conversation, selection, reviewed);
        if (!r.ok) throw new Error(r.error);
        ({ document, sync } = r);
        saved = true;
        if (r.safety.hasFindings) safetyWarnings = r.safety.warnings;
      } else {
        document = reviewed
          ? applyItemSelection(reviewed, selection.itemIds)
          : buildSelectedContext(conversation, selection, { client: clientId() }).document;
        const scan = scanDocument(document);
        if (scan.hasFindings) safetyWarnings = scan.warnings;
      }

      if (target) {
        // Only the reviewed context is injected; the relay never falls back to the whole chat.
        const summary = buildPcoHandoff(document, { source: conversation.source, title: conversation.title, capturedAt: conversation.capturedAt });
        const payload = { conversation: selectMessages(conversation, selection.messageIndexes), summary };
        const staged = (await chrome.runtime.sendMessage({ type: 'CIRA/STAGE_RELAY', target, payload } satisfies RuntimeMessage)) as { ok?: boolean } | undefined;
        if (!staged?.ok) throw new Error(`Could not hand the context to ${targetName}.`);
        await chrome.tabs.create({ url: TARGET_URLS[target] ?? `https://${target}.com/` });
      }

      const mode = draftMode(document);
      const active: ActiveContext = {
        id: document.id,
        title: conversation.title,
        source: conversation.source,
        messageCount: selection.messageIndexes.length,
        totalMessages: conversation.messages.length,
        itemCount: document.items.length,
        updatedAt: new Date().toISOString(),
        saved,
        ...(sync ? { sync } : {}),
        ...(target ? { sentTo: target } : {}),
        document,
        conversation,
        selection,
        ...(mode !== 'deterministic' ? { mode, draft: reviewed } : {}),
      };
      await persistActive(active).catch(() => {});
      dispatch({
        type: 'submit/ok',
        active,
        outcome: { messageCount: active.messageCount, itemCount: active.itemCount, saved, sync, sentTo: target ?? undefined, safetyWarnings },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dispatch({ type: 'submit/fail', error: saved ? `Saved, but sending failed: ${message}` : message });
    }
  }, [persistActive]);

  const retrySync = useCallback(async () => {
    const id = stateRef.current.active?.id;
    if (!id) return;
    dispatch({ type: 'sync/start' });
    const sync = await retrySyncRequest(id);
    dispatch({ type: 'sync/done', sync });
    const active = stateRef.current.active;
    if (active) await persistActive({ ...active, sync }).catch(() => {});
  }, [persistActive]);

  const clearActive = useCallback(async () => {
    dispatch({ type: 'active/set', active: null });
    await persistActive(null).catch(() => {});
  }, [persistActive]);

  /** Reopen the active context's review with its previous message and item choices. */
  const editActive = useCallback(() => {
    const a = stateRef.current.active;
    if (!a) return;
    try {
      // Semantic / hybrid contexts reopen the stored draft; the model is not called again.
      const draft = a.draft ?? buildSelectedContext(a.conversation, { messageIndexes: a.selection.messageIndexes }, { client: clientId() }).draft;
      const kept = new Set(a.selection.itemIds ?? draft.items.map((i) => i.id));
      const removedItems = draft.items.filter((i) => !kept.has(i.id)).map((i) => i.id);
      dispatch({ type: 'restore', conversation: a.conversation, selection: a.selection, removedItems, draft, mode: a.draft ? a.mode : 'deterministic' });
    } catch (err) {
      dispatch({ type: 'capture/fail', error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  return {
    state,
    dispatch,
    tab,
    hasApiKey,
    readChat,
    reloadTab,
    continueToReview,
    submit,
    retrySync,
    clearActive,
    editActive,
    setMode,
    setProvider,
    setApiKey,
    fetchModels,
  };
}
