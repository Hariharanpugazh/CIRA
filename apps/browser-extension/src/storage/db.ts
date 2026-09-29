import Dexie, { type Table } from 'dexie';

export interface ConversationRecord {
  id?: number;
  source: string;
  platform: string;
  title: string;
  url: string;
  capturedAt: string;
  messageCount: number;
  messages: Array<{
    role: string;
    content: string;
    codeBlocks?: Array<{ language: string; code: string }>;
  }>;
  tags: string[];
  archived: boolean;
}

export interface TemplateRecord {
  id?: number;
  name: string;
  description: string;
  body: string;
  variables: Array<{ name: string; defaultValue?: string }>;
  category: string;
  usageCount: number;
  createdAt: string;
}

export interface AnalyticsEvent {
  id?: number;
  sessionId: string;
  timestamp: string;
  event: string;
  properties: Record<string, number | string>;
}

export interface SettingsRecord {
  key: string;
  value: unknown;
}

export class CiraDB extends Dexie {
  conversations!: Table<ConversationRecord, number>;
  templates!: Table<TemplateRecord, number>;
  analytics!: Table<AnalyticsEvent, number>;
  settings!: Table<SettingsRecord, string>;

  constructor() {
    super('CIRA');

    this.version(1).stores({
      conversations:
        '++id, source, capturedAt, tags, archived',
      templates:
        '++id, category, usageCount, createdAt',
      analytics:
        '++id, event, timestamp',
      settings:
        'key',
    });
  }
}

export const db = new CiraDB();
