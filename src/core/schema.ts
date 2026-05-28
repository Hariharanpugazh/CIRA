/**
 * Common conversation schema used across all sites.
 * Site-specific extractors normalize their DOM output into this shape.
 */

export type Role = 'user' | 'assistant' | 'system';

export type Source = 'chatgpt' | 'claude' | 'gemini' | 'unknown';

export interface CodeBlock {
  language: string;
  code: string;
}

export interface Message {
  role: Role;
  /** Plain-text content with code blocks left as fenced markdown. */
  content: string;
  /** Optional structured code blocks pulled out for compression. */
  code?: CodeBlock[];
}

export interface Conversation {
  /** Where this conversation was scraped from. */
  source: Source;
  /** Best-effort title (from page title or first user message). */
  title: string;
  /** URL the conversation was captured from. */
  url: string;
  /** ISO timestamp of capture. */
  capturedAt: string;
  messages: Message[];
}

export interface RelayPayload {
  /** The full normalized conversation. */
  conversation: Conversation;
  /** A compressed, structured summary suitable for prompt injection. */
  summary: string;
}
