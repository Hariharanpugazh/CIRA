/**
 * Wires the pure workspace reducer to Chrome: the active tab, capture,
 * extraction preview, save (service worker → ContextStore → native host),
 * relay staging and the persisted "active context".
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { scanDocument } from '@cira/core';
import { detectSource } from '@/platform/detect';
import { TARGET_URLS } from '@/platform/urls';
import { retrySync as retrySyncRequest, saveContext } from '@/shared/context-client';
import { buildPcoHandoff, buildSelectedContext, selectMessages } from '@/shared/context-selection';
import type { RuntimeMessage } from '@/shared/messaging';
import { chromeTabApi, extractFromTab, NOT_CONNECTED_MESSAGE } from '@/shared/tab-connection';
import { brandFor } from '../brands';
import {
  currentSelection,
  initialWorkspace,
  selectedMessageIndexes,
  selectionKey,
  workspaceReducer,
  type ActiveContext,
  type WorkspaceState,
} from '../state/workspace';

export const ACTIVE_CONTEXT_KEY = 'cira.active.context';

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

export function useWorkspace() {
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspace);
  const [tab, setTab] = useState<TabInfo>({ tabId: null, source: 'unknown' });
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

  // --- active context -----------------------------------------------------
  useEffect(() => {
    void chrome.storage.local.get(ACTIVE_CONTEXT_KEY).then((r) => {
      const active = r?.[ACTIVE_CONTEXT_KEY] as ActiveContext | undefined;
      if (active?.id) dispatch({ type: 'active/set', active });
    }).catch(() => {});
  }, []);

  const persistActive = useCallback(async (active: ActiveContext | null) => {
    if (active) await chrome.storage.local.set({ [ACTIVE_CONTEXT_KEY]: active });
    else await chrome.storage.local.remove(ACTIVE_CONTEXT_KEY);
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

  const continueToReview = useCallback(async () => {
    const s = stateRef.current;
    dispatch({ type: 'review/start' });
    if (!s.conversation || s.selectedMessages.size === 0) return;
    const key = selectionKey(s.selectedMessages);
    if (s.draft && s.draftKey === key) {
      dispatch({ type: 'review/ok', draft: s.draft, key });
      return;
    }
    await nextTick(); // let "Extracting context…" render
    try {
      const { draft } = buildSelectedContext(s.conversation, { messageIndexes: selectedMessageIndexes(s) }, { client: clientId() });
      dispatch({ type: 'review/ok', draft, key });
    } catch (err) {
      dispatch({ type: 'review/fail', error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const submit = useCallback(async () => {
    const s = stateRef.current;
    if (!s.conversation) return;
    const conversation = s.conversation;
    const target = s.target;
    const targetName = target ? brandFor(target).name : '';
    dispatch({ type: 'submit/start', kind: target ? 'sending' : 'saving', label: target ? `Sending to ${targetName}…` : 'Saving context…' });
    if (!s.saveLocally && !target) return;

    const selection = currentSelection(s);
    let saved = false;
    try {
      let document;
      let sync;
      let safetyWarnings: string[] = [];
      if (s.saveLocally) {
        const r = await saveContext(conversation, selection);
        if (!r.ok) throw new Error(r.error);
        ({ document, sync } = r);
        saved = true;
        if (r.safety.hasFindings) safetyWarnings = r.safety.warnings;
      } else {
        document = buildSelectedContext(conversation, selection, { client: clientId() }).document;
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
      const { draft } = buildSelectedContext(a.conversation, { messageIndexes: a.selection.messageIndexes }, { client: clientId() });
      const kept = new Set(a.selection.itemIds ?? draft.items.map((i) => i.id));
      const removedItems = draft.items.filter((i) => !kept.has(i.id)).map((i) => i.id);
      dispatch({ type: 'restore', conversation: a.conversation, selection: a.selection, removedItems, draft });
    } catch (err) {
      dispatch({ type: 'capture/fail', error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  return { state, dispatch, tab, readChat, reloadTab, continueToReview, submit, retrySync, clearActive, editActive };
}
