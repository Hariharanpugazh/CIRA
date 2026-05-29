/**
 * Live Sync — MutationObserver-based auto-capture with fingerprint diffing.
 *
 * Strategy:
 *   1. MutationObserver watches the DOM for structural changes
 *   2. On change → debounce 500ms → compute fingerprint of message list
 *   3. If fingerprint changed → extract new messages (delta since last fingerprint)
 *   4. Push delta to MCP companion via service worker → WebSocket
 *
 * This avoids re-extraction on every DOM mutation (cursor blinks, animations, etc.)
 * by using a content-based fingerprint.
 */

import type { Message, Conversation, Source } from '@/core/schema';

export interface SyncConfig {
  /** Which source site this is running on */
  source: Source;
  /** Debounce delay in ms after last DOM mutation before extracting */
  debounceMs: number;
  /** DOM selector that identifies individual message containers */
  messageSelector: string;
  /** Extract a Message from a single DOM node */
  extractMessage: (node: Element) => Message | null;
  /** Extract a full Conversation snapshot */
  extractConversation: () => Conversation;
  /** Called when a new delta (new messages) is detected */
  onDelta: (delta: { source: Source; url: string; newMessages: Message[] }) => void;
  /** Called when a full snapshot should be pushed */
  onSnapshot: (conv: Conversation) => void;
}

interface SyncState {
  lastFingerprint: string;
  messageCount: number;
  running: boolean;
  observer: MutationObserver | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Create a content fingerprint from a list of messages.
 * Uses first 200 chars of each message, joined.
 * Stable against whitespace changes, cursor movement, etc.
 */
function fingerprint(messages: Message[]): string {
  return messages
    .map((m) => `${m.role}:${m.content.slice(0, 200).trim()}`)
    .join('|');
}

/**
 * Start live sync. Returns a stop function.
 */
export function startLiveSync(config: SyncConfig): () => void {
  const state: SyncState = {
    lastFingerprint: '',
    messageCount: 0,
    running: true,
    observer: null,
    debounceTimer: null,
  };

  // Compute initial fingerprint
  const initialConv = config.extractConversation();
  state.lastFingerprint = fingerprint(initialConv.messages);
  state.messageCount = initialConv.messages.length;

  function onMutation() {
    if (!state.running) return;

    // Clear existing debounce
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    // Set new debounce
    state.debounceTimer = setTimeout(() => {
      if (!state.running) return;

      const conv = config.extractConversation();
      const fp = fingerprint(conv.messages);

      // No meaningful change
      if (fp === state.lastFingerprint) return;

      // Compute delta: new messages since last fingerprint
      if (conv.messages.length > state.messageCount) {
        const newMessages = conv.messages.slice(state.messageCount);
        if (newMessages.length > 0) {
          config.onDelta({
            source: config.source,
            url: location.href,
            newMessages,
          });
        }
      }

      // Update state
      state.lastFingerprint = fp;
      state.messageCount = conv.messages.length;
    }, config.debounceMs);
  }

  // Start MutationObserver
  state.observer = new MutationObserver(onMutation);
  state.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  console.log(`[CIRA/live-sync] started on ${config.source} (${state.messageCount} messages)`);

  return () => {
    state.running = false;
    state.observer?.disconnect();
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    console.log(`[CIRA/live-sync] stopped on ${config.source}`);
  };
}
