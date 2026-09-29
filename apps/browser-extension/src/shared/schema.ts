/**
 * Browser-extension conversation types.
 *
 * The conversation shape itself is the legacy CIRA "v0" conversation owned by
 * @cira/core (so the extension, CLI migration and tests share one
 * definition). What stays here is browser-connector knowledge: the list of
 * supported web platforms (`Source`) and the relay payload.
 */
import type {
  LegacyCodeBlockV0,
  LegacyConversationV0,
  LegacyMediaAttachmentV0,
  LegacyMessageV0,
  LegacyRoleV0,
} from '@cira/core';

export type Role = LegacyRoleV0;
export type MediaAttachment = LegacyMediaAttachmentV0;
export type CodeBlock = LegacyCodeBlockV0;
export type Message = LegacyMessageV0;

/** AI web platforms this connector can capture from / relay to. */
export type Source =
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'deepseek'
  | 'perplexity'
  | 'copilot'
  | 'grok'
  | 'kimi'
  | 'qwen'
  | 'poe'
  | 'huggingchat'
  | 'notebooklm'
  | 'you'
  | 'characterai'
  | 'pi'
  | 'zai'
  | 'mistral'
  | 'unknown';

export interface Conversation extends Omit<LegacyConversationV0, 'source' | 'platform'> {
  source: Source;
}

export interface RelayPayload {
  conversation: Conversation;
  summary: string;
}
