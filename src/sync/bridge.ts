/**
 * WebSocket bridge — connects Chrome extension to the CIRA MCP companion process.
 *
 * The service worker maintains a persistent WebSocket to ws://127.0.0.1:9021.
 * Content scripts and popup relay context through chrome.runtime.sendMessage,
 * and the service worker forwards it over WebSocket to the MCP server.
 *
 * This module also handles reconnection logic with exponential backoff.
 */

import type { Conversation, Source, Message } from '@/core/schema';

const WS_URL = 'ws://127.0.0.1:9021';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

interface BridgeState {
  ws: WebSocket | null;
  connected: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
}

const state: BridgeState = {
  ws: null,
  connected: false,
  reconnectTimer: null,
  reconnectAttempts: 0,
};

export function isConnected(): boolean {
  return state.connected && state.ws?.readyState === WebSocket.OPEN;
}

export function sendSnapshot(source: Source, conversation: Conversation, summary: string): void {
  if (!isConnected()) return;
  state.ws!.send(JSON.stringify({ type: 'context_snapshot', source, conversation, summary }));
}

export function sendDelta(source: Source, url: string, newMessages: Message[]): void {
  if (!isConnected()) return;
  state.ws!.send(JSON.stringify({ type: 'live_delta', source, url, newMessages }));
}

function connect(): void {
  if (state.reconnectAttempts > 3) return;
  if (state.ws?.readyState === WebSocket.CONNECTING) return;

  state.ws = new WebSocket(WS_URL);

  state.ws.onopen = () => {
    state.connected = true;
    state.reconnectAttempts = 0;
  };

  state.ws.onclose = () => {
    state.connected = false;
    scheduleReconnect();
  };

  state.ws.onerror = () => {
    state.reconnectAttempts++;
  };

  state.ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === 'capture_request') {
        handleCaptureRequest(msg.source as Source);
      }
    } catch {
    }
  };
}

function scheduleReconnect(): void {
  const delay = Math.min(
    RECONNECT_BASE_MS * 2 ** state.reconnectAttempts,
    RECONNECT_MAX_MS,
  );
  state.reconnectAttempts++;

  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(connect, delay);
}

const PLATFORM_URLS: Partial<Record<Source, string>> = {
  chatgpt: 'https://chatgpt.com/*',
  claude: 'https://claude.ai/*',
  gemini: 'https://gemini.google.com/*',
  deepseek: 'https://chat.deepseek.com/*',
  perplexity: 'https://perplexity.ai/*',
  copilot: 'https://copilot.microsoft.com/*',
  grok: 'https://grok.com/*',
  kimi: 'https://kimi.moonshot.cn/*',
  qwen: 'https://tongyi.aliyun.com/*',
  poe: 'https://poe.com/*',
  huggingchat: 'https://huggingface.co/chat/*',
  notebooklm: 'https://notebooklm.google.com/*',
  you: 'https://you.com/*',
  characterai: 'https://character.ai/*',
  pi: 'https://pi.ai/*',
};

async function handleCaptureRequest(source: Source): Promise<void> {
  const urlPattern = PLATFORM_URLS[source];
  if (!urlPattern) {
    console.warn(`[CIRA/bridge] no URL pattern for platform: ${source}`);
    return;
  }

  const tabs = await chrome.tabs.query({ url: urlPattern });
  if (tabs.length === 0 || !tabs[0].id) {
    console.warn(`[CIRA/bridge] no ${source} tab open for capture request`);
    return;
  }

  try {
    const reply = await chrome.tabs.sendMessage(tabs[0].id!, {
      type: 'CIRA/EXTRACT_REQUEST',
    });
    if (reply && reply.type === 'CIRA/EXTRACT_RESPONSE') {
      // Summary will be compressed by the caller before sending
      // For now, just acknowledge the extraction happened
      console.log(`[CIRA/bridge] captured ${reply.conversation.messages.length} messages from ${source}`);
      // The content script should forward to the bridge via a dedicated message
    }
  } catch (err) {
    console.error(`[CIRA/bridge] capture request failed for ${source}:`, err);
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

export function startBridge(): void {
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    connect();
  }
}

export function stopBridge(): void {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.ws?.close();
  state.ws = null;
  state.connected = false;
}
