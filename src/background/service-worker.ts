import { STORAGE_KEYS } from '@/shared/messaging';
import type { RuntimeMessage } from '@/shared/messaging';
import type { Conversation } from '@/core/schema';
import { compress } from '@/core/compress';
import {
  startBridge,
  stopBridge,
  isConnected,
  sendSnapshot,
  sendDelta,
} from '@/sync/bridge';

const CONVERSATIONS_KEY = 'cira.persist.conversations';
const TEMPLATES_KEY = 'cira.persist.templates';
const ANALYTICS_KEY = 'cira.persist.analytics';
const RELAY_HISTORY_KEY = 'cira.persist.relayHistory';
const STATS_KEY = 'cira.persist.stats';
const MAX_CONVERSATIONS = 200;
const MAX_ANALYTICS_EVENTS = 500;
const MAX_RELAY_HISTORY = 200;
const MAX_RATE_LIMIT_LOG = 100;

interface ConversationRecord {
  id: string;
  conversation: Conversation;
  savedAt: string;
}

interface TemplateRecord {
  id: string;
  name: string;
  content: string;
  platform: string;
  createdAt: string;
}

interface RelayHistoryEntry {
  from: string;
  to: string;
  messageCount: number;
  at: string;
}

interface AnalyticsEntry {
  event: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

interface StatsData {
  totalRelays: number;
  totalMessages: number;
  lastRelayAt: string | null;
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function uniqueFilter<T, K>(fn: (item: T) => K): (item: T) => boolean {
  const seen = new Set<K>();
  return (item) => {
    const key = fn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

async function stageRelay(platformId: string, payload: unknown): Promise<void> {
  const key = STORAGE_KEYS.staged(platformId);
  await chrome.storage.session.set({ [key]: payload });
}

async function popStaged(platformId: string): Promise<unknown | null> {
  const key = STORAGE_KEYS.staged(platformId);
  const result = await chrome.storage.session.get(key);
  const payload = result[key] ?? null;
  if (payload) await chrome.storage.session.remove(key);
  return payload;
}

async function getStatsData(): Promise<StatsData> {
  const { [STATS_KEY]: raw } = await chrome.storage.local.get(STATS_KEY);
  const d = (raw ?? {}) as Partial<StatsData>;
  return { totalRelays: d.totalRelays ?? 0, totalMessages: d.totalMessages ?? 0, lastRelayAt: d.lastRelayAt ?? null };
}

async function recordRelay(from: string, to: string, messageCount: number): Promise<void> {
  const { [RELAY_HISTORY_KEY]: raw } = await chrome.storage.local.get(RELAY_HISTORY_KEY);
  const history: RelayHistoryEntry[] = raw ?? [];
  history.push({ from, to, messageCount, at: new Date().toISOString() });
  const stats = await getStatsData();
  stats.totalRelays += 1;
  stats.totalMessages += messageCount;
  stats.lastRelayAt = new Date().toISOString();
  await chrome.storage.local.set({
    [RELAY_HISTORY_KEY]: history.slice(-MAX_RELAY_HISTORY),
    [STATS_KEY]: stats,
  });
}

async function getAllConversations(): Promise<ConversationRecord[]> {
  const { [CONVERSATIONS_KEY]: raw } = await chrome.storage.local.get(CONVERSATIONS_KEY);
  return (raw as ConversationRecord[]) ?? [];
}

async function saveConversation(rec: ConversationRecord): Promise<void> {
  const list = await getAllConversations();
  const deduped = [rec, ...list.filter(uniqueFilter((x: ConversationRecord) => x.id))];
  const trimmed = deduped.slice(0, MAX_CONVERSATIONS);
  await chrome.storage.local.set({ [CONVERSATIONS_KEY]: trimmed });
}

async function deleteConversation(id: string): Promise<void> {
  const list = await getAllConversations();
  await chrome.storage.local.set({
    [CONVERSATIONS_KEY]: list.filter((c) => c.id !== id),
  });
}

async function getAllTemplates(): Promise<TemplateRecord[]> {
  const { [TEMPLATES_KEY]: raw } = await chrome.storage.local.get(TEMPLATES_KEY);
  return (raw as TemplateRecord[]) ?? [];
}

async function saveTemplate(tmpl: TemplateRecord): Promise<void> {
  const list = await getAllTemplates();
  const idx = list.findIndex((t) => t.id === tmpl.id);
  if (idx >= 0) list[idx] = tmpl;
  else list.push(tmpl);
  await chrome.storage.local.set({ [TEMPLATES_KEY]: list });
}

async function deleteTemplate(id: string): Promise<void> {
  const list = await getAllTemplates();
  await chrome.storage.local.set({
    [TEMPLATES_KEY]: list.filter((t) => t.id !== id),
  });
}

async function trackEvent(event: AnalyticsEntry): Promise<void> {
  const { [ANALYTICS_KEY]: raw } = await chrome.storage.local.get(ANALYTICS_KEY);
  const events: AnalyticsEntry[] = raw ?? [];
  events.push(event);
  await chrome.storage.local.set({
    [ANALYTICS_KEY]: events.slice(-MAX_ANALYTICS_EVENTS),
  });
}

async function computeStats() {
  const [historyRaw, stats] = await Promise.all([
    chrome.storage.local.get(RELAY_HISTORY_KEY),
    getStatsData(),
  ]);
  const history: RelayHistoryEntry[] = (historyRaw[RELAY_HISTORY_KEY] as RelayHistoryEntry[]) ?? [];
  const recentRelays = [...history].reverse().slice(0, 5);
  const rateLimitRaw = await chrome.storage.local.get(STORAGE_KEYS.rateLimitLog);
  const rateLimits: Array<{ source: string; timestamp: number }> =
    (rateLimitRaw[STORAGE_KEYS.rateLimitLog] as Array<{ source: string; timestamp: number }>) ?? [];
  const estimatedTokensSaved = stats.totalMessages * 100;
  const relaysBySource: Record<string, number> = {};
  for (const r of history) {
    relaysBySource[r.from] = (relaysBySource[r.from] ?? 0) + 1;
  }
  return {
    recentRelays,
    totalRelays: stats.totalRelays,
    totalMessages: stats.totalMessages,
    estimatedTokensSaved,
    lastRelayAt: stats.lastRelayAt,
    relaysBySource,
    rateLimitsDetected: rateLimits.length,
  };
}

function handleLiveSyncSnapshot(msg: RuntimeMessage & { type: 'CIRA/LIVE_SNAPSHOT' }): void {
  startBridge();
  if (isConnected()) {
    sendSnapshot(msg.conversation.source, msg.conversation, msg.summary);
  }
  chrome.storage.session.set({
    [STORAGE_KEYS.liveContext]: { conversation: msg.conversation, summary: msg.summary },
  });
}

function handleLiveSyncDelta(msg: RuntimeMessage & { type: 'CIRA/LIVE_DELTA' }): void {
  startBridge();
  if (isConnected()) {
    sendDelta(msg.source as never, msg.url, msg.newMessages as never);
  }
}

async function handleFetchImage(url: string): Promise<{ dataUrl?: string; error?: string }> {
  try {
    const res = await fetch(url);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const blob = await res.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { dataUrl };
  } catch (err) {
    return { error: String(err) };
  }
}

async function handleRateLimitDetected(source: string, timestamp: number): Promise<void> {
  const key = STORAGE_KEYS.rateLimitLog;
  const { [key]: raw } = await chrome.storage.local.get(key);
  const log: Array<{ source: string; timestamp: number }> = raw ?? [];
  log.push({ source, timestamp });
  await chrome.storage.local.set({ [key]: log.slice(-MAX_RATE_LIMIT_LOG) });
}

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  switch (msg.type) {

    case 'CIRA/STAGE_RELAY': {
      if (!msg.payload.summary) {
        msg.payload.summary = compress(msg.payload.conversation);
      }
      void stageRelay(msg.target, msg.payload).then(() => {
        void recordRelay(
          msg.payload.conversation.source,
          msg.target,
          msg.payload.conversation.messages.length,
        );
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'CIRA/POP_STAGED': {
      void popStaged(msg.for).then((payload) => {
        sendResponse({
          type: 'CIRA/POP_STAGED_RESPONSE',
          payload: payload as never,
        });
      });
      return true;
    }

    case 'CIRA/PING':
      sendResponse({ type: 'CIRA/PONG' });
      return false;

    case 'CIRA/LIVE_SNAPSHOT':
      handleLiveSyncSnapshot(msg);
      sendResponse({ ok: true });
      return false;

    case 'CIRA/LIVE_DELTA':
      handleLiveSyncDelta(msg);
      sendResponse({ ok: true });
      return false;

    case 'CIRA/GET_STATS': {
      void computeStats().then((stats) => sendResponse(stats));
      return true;
    }

    case 'CIRA/SAVE_CONVERSATION': {
      const rec: ConversationRecord = {
        id: msg.id ?? uid(),
        conversation: msg.conversation,
        savedAt: new Date().toISOString(),
      };
      void saveConversation(rec).then(() => sendResponse({ ok: true, id: rec.id }));
      return true;
    }

    case 'CIRA/GET_CONVERSATIONS': {
      void getAllConversations().then((list) =>
        sendResponse({ conversations: list }),
      );
      return true;
    }

    case 'CIRA/GET_CONVERSATION': {
      void getAllConversations().then((list) => {
        const found = list.find((c) => c.id === msg.id) ?? null;
        sendResponse({ conversation: found });
      });
      return true;
    }

    case 'CIRA/DELETE_CONVERSATION': {
      void deleteConversation(msg.id).then(() => sendResponse({ ok: true }));
      return true;
    }

    case 'CIRA/SAVE_TEMPLATE': {
      const tmpl: TemplateRecord = {
        id: msg.id ?? uid(),
        name: msg.name,
        content: msg.content,
        platform: msg.platform,
        createdAt: new Date().toISOString(),
      };
      void saveTemplate(tmpl).then(() => sendResponse({ ok: true, id: tmpl.id }));
      return true;
    }

    case 'CIRA/GET_TEMPLATES': {
      void getAllTemplates().then((list) => sendResponse({ templates: list }));
      return true;
    }

    case 'CIRA/DELETE_TEMPLATE': {
      void deleteTemplate(msg.id).then(() => sendResponse({ ok: true }));
      return true;
    }

    case 'CIRA/TRACK_EVENT': {
      void trackEvent({
        event: msg.event,
        data: msg.data,
        timestamp: new Date().toISOString(),
      }).then(() => sendResponse({ ok: true }));
      return true;
    }

    case 'CIRA/FETCH_IMAGE': {
      void handleFetchImage(msg.url).then((result) => sendResponse(result));
      return true;
    }

    case 'CIRA/EXPORT_CONVERSATION': {
      const json = JSON.stringify(msg.conversation, null, 2);
      sendResponse({ ok: true, json });
      return false;
    }

    case 'CIRA/RATE_LIMIT_DETECTED': {
      const { source, timestamp } = msg;
      void handleRateLimitDetected(source, timestamp);
      sendResponse({ ok: true });
      return false;
    }

    default:
      return false;
  }
});

self.addEventListener('install', () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });
});

self.addEventListener('unload', () => {
  stopBridge();
});
