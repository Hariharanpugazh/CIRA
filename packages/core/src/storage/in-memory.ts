import type { PCODocument } from '../types';
import { prepareForPut, sortSummaries, summarize, type ContextStore, type ContextSummary } from './context-store';

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Reference implementation; also useful for tests and ephemeral sessions. */
export class InMemoryContextStore implements ContextStore {
  private readonly docs = new Map<string, PCODocument>();

  async put(document: PCODocument): Promise<ContextSummary> {
    const next = prepareForPut(document, this.docs.get(document.id) ?? null);
    this.docs.set(next.id, copy(next));
    return summarize(next);
  }

  async get(id: string): Promise<PCODocument | null> {
    const doc = this.docs.get(id);
    return doc ? copy(doc) : null;
  }

  async list(): Promise<ContextSummary[]> {
    return sortSummaries([...this.docs.values()].map(summarize));
  }

  async delete(id: string): Promise<boolean> {
    return this.docs.delete(id);
  }
}
