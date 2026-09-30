/**
 * File-system ContextStore (Node only; exported from `@cira/core/node`).
 *
 * Layout: `<dir>/<id>.pco.json`, pretty-printed UTF-8 JSON, one document per
 * file. Default dir: `$CIRA_HOME/contexts`, where CIRA_HOME defaults to
 * `~/.cira`. Writes are atomic (temp file + rename). IDs are restricted by
 * the PCO schema to [A-Za-z0-9._-], so they cannot escape the directory.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ID_PATTERN,
  prepareForPut,
  sortSummaries,
  summarize,
  validate,
  type ContextStore,
  type ContextSummary,
  type PCODocument,
} from '../index';

export const PCO_FILE_SUFFIX = '.pco.json';

export function defaultCiraHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CIRA_HOME ? resolve(env.CIRA_HOME) : join(homedir(), '.cira');
}

export function defaultContextDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultCiraHome(env), 'contexts');
}

export interface InvalidContextFile {
  file: string;
  reason: string;
}

export interface FileContextStoreOptions {
  /** Called for files in the directory that are not valid PCO documents. */
  onInvalidFile?: (info: InvalidContextFile) => void;
}

export class FileContextStore implements ContextStore {
  readonly dir: string;
  private readonly onInvalidFile?: (info: InvalidContextFile) => void;

  constructor(dir: string = defaultContextDir(), options: FileContextStoreOptions = {}) {
    this.dir = resolve(dir);
    this.onInvalidFile = options.onInvalidFile;
  }

  pathFor(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`invalid PCO id: ${JSON.stringify(id)}`);
    return join(this.dir, `${id}${PCO_FILE_SUFFIX}`);
  }

  private async readDoc(file: string): Promise<PCODocument | null> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      this.onInvalidFile?.({ file, reason: `invalid JSON: ${(err as Error).message}` });
      return null;
    }
    const r = validate(json);
    if (!r.ok || !r.document) {
      this.onInvalidFile?.({ file, reason: r.errors.map((e) => e.message).join('; ') });
      return null;
    }
    return r.document;
  }

  async put(document: PCODocument): Promise<ContextSummary> {
    const target = this.pathFor(document.id);
    const next = prepareForPut(document, await this.readDoc(target));
    await mkdir(this.dir, { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, target);
    return summarize(next);
  }

  async get(id: string): Promise<PCODocument | null> {
    if (!ID_PATTERN.test(id)) return null;
    return this.readDoc(this.pathFor(id));
  }

  async list(): Promise<ContextSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const docs = await Promise.all(
      names.filter((n) => n.endsWith(PCO_FILE_SUFFIX)).map((n) => this.readDoc(join(this.dir, n))),
    );
    return sortSummaries(docs.filter((d): d is PCODocument => d !== null).map(summarize));
  }

  async delete(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id)) return false;
    try {
      await rm(this.pathFor(id));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }
}
