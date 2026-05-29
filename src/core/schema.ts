export type Role = 'user' | 'assistant' | 'system';

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

export interface MediaAttachment {
  url: string;
  type: 'image' | 'file' | 'code';
  name: string;
  mimeType: string;
  dataUrl?: string;
}

export interface CodeBlock {
  language: string;
  code: string;
}

export interface Message {
  role: Role;
  content: string;
  code?: CodeBlock[];
  attachments?: MediaAttachment[];
}

export interface Conversation {
  source: Source;
  title: string;
  url: string;
  capturedAt: string;
  messages: Message[];
}

export interface RelayPayload {
  conversation: Conversation;
  summary: string;
}

export type RelayDirection = 'import' | 'export';

export interface PlatformAdapter {
  source: Source;
  matchPatterns: RegExp[];
  extract(): Promise<Conversation>;
  inject(payload: RelayPayload): Promise<void>;
  detectRateLimit?: () => boolean;
}
