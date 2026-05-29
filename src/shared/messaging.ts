import type { Conversation, RelayPayload } from '@/core/schema';

export type RuntimeMessage =
  | { type: 'CIRA/EXTRACT_REQUEST' }
  | { type: 'CIRA/EXTRACT_RESPONSE'; conversation: Conversation }
  | { type: 'CIRA/STAGE_RELAY'; payload: RelayPayload; target: string }
  | { type: 'CIRA/POP_STAGED'; for: string }
  | { type: 'CIRA/POP_STAGED_RESPONSE'; payload: RelayPayload | null }
  | { type: 'CIRA/PING' }
  | { type: 'CIRA/PONG' }
  | { type: 'CIRA/LIVE_SNAPSHOT'; conversation: Conversation; summary: string }
  | { type: 'CIRA/LIVE_DELTA'; source: string; url: string; newMessages: Array<{ role: string; content: string }> }
  | { type: 'CIRA/RATE_LIMIT_DETECTED'; source: string; timestamp: number; url?: string }
  | { type: 'CIRA/SHOW_BANNER'; message: string; level: 'info' | 'warn' | 'error' }
  | { type: 'CIRA/GET_STATS' }
  | { type: 'CIRA/STATS_RESPONSE'; stats: RelayStats }
  | { type: 'CIRA/SAVE_CONVERSATION'; id?: string; conversation: Conversation }
  | { type: 'CIRA/GET_CONVERSATIONS' }
  | { type: 'CIRA/GET_CONVERSATION'; id: string }
  | { type: 'CIRA/DELETE_CONVERSATION'; id: string }
  | { type: 'CIRA/SAVE_TEMPLATE'; id?: string; name: string; content: string; platform: string }
  | { type: 'CIRA/GET_TEMPLATES' }
  | { type: 'CIRA/DELETE_TEMPLATE'; id: string }
  | { type: 'CIRA/TRACK_EVENT'; event: string; data?: Record<string, unknown> }
  | { type: 'CIRA/FETCH_IMAGE'; url: string }
  | { type: 'CIRA/EXPORT_CONVERSATION'; conversation: Conversation }
  | { type: 'MCP/EXTRACT'; source: string }
  | { type: 'MCP/STAGE_RELAY'; payload: RelayPayload; target: string }
  | { type: 'MCP/GET_ACTIVE'; tabId: number };

export interface RelayStats {
  totalRelays: number;
  relaysBySource: Record<string, number>;
  totalMessages: number;
  lastRelayAt: string | null;
  rateLimitsDetected: number;
  estimatedTokensSaved: number;
  recentRelays: Array<{ from: string; to: string; at: string; messageCount: number }>;
}

export const STORAGE_KEYS = {
  staged: (source: string) => `cira.staged.${source}`,
  liveContext: 'cira.live.context',
  liveLastFingerprint: 'cira.live.lastFingerprint',
  settings: 'cira.settings',
  analytics: 'cira.analytics',
  rateLimitLog: 'cira.rateLimit.log',
  relayHistory: 'cira.relay.history',
  platformAdapters: 'cira.platform.adapters',
} as const;
