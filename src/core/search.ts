import FlexSearch from 'flexsearch';
import { db, type ConversationRecord } from '@/core/db';

const INDEX_STORE_KEY = 'search_index_serialized';
const INDEX_VERSION_KEY = 'search_index_version';
const CURRENT_VERSION = 1;

let index: FlexSearch.Document<ConversationRecord & { id: number }, string[]> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;

async function serializeIndex(): Promise<void> {
  if (!index) return;
  let data = '';
  await index.export((_key: string | number, value: unknown) => {
    data += JSON.stringify(value);
  });
  await chrome.storage.local.set({
    [INDEX_STORE_KEY]: data,
    [INDEX_VERSION_KEY]: CURRENT_VERSION,
  });
  dirty = false;
}

async function debouncedSerialize(): Promise<void> {
  dirty = true;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void serializeIndex();
  }, 5_000);
}

function createIndex(): FlexSearch.Document<ConversationRecord & { id: number }, string[]> {
  const idx = new FlexSearch.Document<ConversationRecord & { id: number }, string[]>({
    document: {
      id: 'id',
      index: ['title', 'content'],
    },
    tokenize: 'forward',
  });
  return idx;
}

function buildSearchDoc(conv: ConversationRecord): Record<string, string> {
  const content = conv.messages.map((m) => m.content).join('\n');
  return { id: String(conv.id ?? ''), title: conv.title, content };
}

export async function initSearch(): Promise<void> {
  const stored = await chrome.storage.local.get([INDEX_STORE_KEY, INDEX_VERSION_KEY]);

  const storedVersion = stored[INDEX_VERSION_KEY] as number | undefined;
  const storedData = stored[INDEX_STORE_KEY] as string | undefined;

  index = createIndex();

  if (storedData && storedVersion === CURRENT_VERSION) {
    try {
      await index.import(0, storedData as never);
    } catch {
      void rebuildIndex();
      return;
    }
  } else {
    void rebuildIndex();
  }
}

async function rebuildIndex(): Promise<void> {
  if (!index) return;
  index = createIndex();
  const conversations = await db.conversations.toArray();
  for (const conv of conversations) {
    if (conv.id == null) continue;
    const doc = buildSearchDoc(conv);
    index.add(conv.id, doc as never);
  }
  await serializeIndex();
}

export async function searchConversations(query: string): Promise<number[]> {
  if (!index) await initSearch();
  if (!index) return [];

  const results = await index.search(query, { limit: 50, enrich: true });
  const ids = new Set<number>();

  for (const field of results) {
    for (const resultItem of field.result) {
      const id = typeof resultItem === 'object' ? (resultItem as Record<string, unknown>).id : resultItem;
      if (typeof id === 'number') ids.add(id);
      else if (typeof id === 'string') ids.add(Number(id));
    }
  }

  return Array.from(ids);
}

export async function addToIndex(conv: ConversationRecord): Promise<void> {
  if (!index) await initSearch();
  if (!index || conv.id == null) return;

  const doc = buildSearchDoc(conv);
  index.add(conv.id, doc as never);
  await debouncedSerialize();
}

export async function removeFromIndex(id: number): Promise<void> {
  if (!index) await initSearch();
  if (!index) return;

  index.remove(id);
  await debouncedSerialize();
}

export async function flushIndex(): Promise<void> {
  if (dirty && index) {
    await serializeIndex();
  }
}
