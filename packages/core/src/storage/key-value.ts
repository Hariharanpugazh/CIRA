/**
 * ContextStore over any async key/value area.
 *
 * `KeyValueArea` matches the subset of `chrome.storage.StorageArea` CIRA
 * needs, and is trivially implementable over localStorage, React Native
 * AsyncStorage, IndexedDB wrappers, etc. Core never references `chrome`;
 * connectors pass their area in.
 *
 * Layout: one key per document (`<prefix>doc.<id>`) plus an index of
 * summaries (`<prefix>index`) so `list()` does not load every document.
 */
import type { PCODocument } from '../types';
import { validate } from '../validation/validate';
import { prepareForPut, sortSummaries, summarize, type ContextStore, type ContextSummary } from './context-store';

export interface KeyValueArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface KeyValueContextStoreOptions {
  /** Key prefix. Default "cira.pco.". */
  prefix?: string;
}

export class KeyValueContextStore implements ContextStore {
  private readonly prefix: string;
  /** Serialises index read-modify-write cycles within this instance. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly area: KeyValueArea, options: KeyValueContextStoreOptions = {}) {
    this.prefix = options.prefix ?? 'cira.pco.';
  }

  private docKey(id: string): string {
    return `${this.prefix}doc.${id}`;
  }

  private get indexKey(): string {
    return `${this.prefix}index`;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readIndex(): Promise<Record<string, ContextSummary>> {
    const raw = (await this.area.get(this.indexKey))[this.indexKey];
    return raw && typeof raw === 'object' ? (raw as Record<string, ContextSummary>) : {};
  }

  put(document: PCODocument): Promise<ContextSummary> {
    return this.exclusive(async () => {
      const next = prepareForPut(document, await this.get(document.id));
      const summary = summarize(next);
      const index = await this.readIndex();
      index[next.id] = summary;
      await this.area.set({ [this.docKey(next.id)]: next, [this.indexKey]: index });
      return summary;
    });
  }

  async get(id: string): Promise<PCODocument | null> {
    const key = this.docKey(id);
    const raw = (await this.area.get(key))[key];
    if (raw === undefined) return null;
    const r = validate(raw);
    return r.ok && r.document ? r.document : null;
  }

  async list(): Promise<ContextSummary[]> {
    return sortSummaries(Object.values(await this.readIndex()));
  }

  delete(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const index = await this.readIndex();
      const key = this.docKey(id);
      const existed = id in index || (await this.area.get(key))[key] !== undefined;
      if (!existed) return false;
      delete index[id];
      await this.area.remove(key);
      await this.area.set({ [this.indexKey]: index });
      return true;
    });
  }
}

/** Minimal in-memory KeyValueArea (tests, prototyping). */
export function createMemoryArea(): KeyValueArea & { dump(): Record<string, unknown> } {
  const data = new Map<string, unknown>();
  const clone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (data.has(k)) out[k] = clone(data.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, clone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
    dump: () => Object.fromEntries(data),
  };
}
