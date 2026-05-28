/**
 * Typed message contract between content scripts, background service worker,
 * and the popup.
 */
import type { Conversation, RelayPayload } from '@/core/schema';

export type RuntimeMessage =
  | { type: 'CIRA/EXTRACT_REQUEST' }
  | { type: 'CIRA/EXTRACT_RESPONSE'; conversation: Conversation }
  | { type: 'CIRA/STAGE_RELAY'; payload: RelayPayload; target: 'claude' | 'chatgpt' }
  | { type: 'CIRA/POP_STAGED'; for: 'claude' | 'chatgpt' }
  | { type: 'CIRA/POP_STAGED_RESPONSE'; payload: RelayPayload | null }
  | { type: 'CIRA/PING' }
  | { type: 'CIRA/PONG' };

export const STORAGE_KEYS = {
  stagedClaude: 'cira.staged.claude',
  stagedChatgpt: 'cira.staged.chatgpt',
} as const;
