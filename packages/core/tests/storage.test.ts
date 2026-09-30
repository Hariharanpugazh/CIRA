import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryArea,
  InMemoryContextStore,
  KeyValueContextStore,
  migrateLegacyConversation,
  PcoValidationError,
  validate,
  type ContextStore,
  type PCODocument,
} from '../src';
import { defaultContextDir, FileContextStore } from '../src/node';
import { clone, loadFixture } from './helpers';

function doc(fixture: string, now = '2026-09-29T12:00:00.000Z'): PCODocument {
  return migrateLegacyConversation(loadFixture(fixture), { now }).document;
}

let tempDir = '';
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cira-store-'));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const factories: Array<[string, () => ContextStore]> = [
  ['InMemoryContextStore', () => new InMemoryContextStore()],
  ['KeyValueContextStore', () => new KeyValueContextStore(createMemoryArea())],
  ['FileContextStore', () => new FileContextStore(join(tempDir, 'contexts'))],
];

describe.each(factories)('%s (ContextStore contract)', (_name, make) => {
  it('put → get returns an equal document', async () => {
    const store = make();
    const d = doc('technical-project');
    const summary = await store.put(d);
    expect(summary).toMatchObject({ id: d.id, item_count: d.items.length, conversation_count: 1, sources: ['browser/claude'] });
    expect(await store.get(d.id)).toEqual(d);
  });

  it('put → list returns summaries, newest first', async () => {
    const store = make();
    await store.put(doc('decisions', '2026-09-01T00:00:00.000Z'));
    await store.put(doc('mixed-context', '2026-09-02T00:00:00.000Z'));
    const list = await store.list();
    expect(list.map((s) => s.title)).toEqual(['Note-taking app sync', 'Database choice']);
    expect(list[0].item_counts.constraint).toBeGreaterThan(0);
  });

  it('delete removes the document', async () => {
    const store = make();
    const d = doc('constraints');
    await store.put(d);
    expect(await store.delete(d.id)).toBe(true);
    expect(await store.get(d.id)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await store.delete(d.id)).toBe(false);
  });

  it('returns null for unknown ids', async () => {
    expect(await make().get('pco_does_not_exist')).toBeNull();
  });

  it('rejects invalid documents', async () => {
    const bad = clone(doc('decisions'));
    bad.items[0].provenance.turn_id = 'nope';
    await expect(make().put(bad)).rejects.toBeInstanceOf(PcoValidationError);
  });

  it('replacing a document keeps the original created_at', async () => {
    const store = make();
    await store.put(doc('decisions', '2026-09-01T00:00:00.000Z'));
    await store.put(doc('decisions', '2026-09-05T00:00:00.000Z'));
    const stored = await store.get(doc('decisions').id);
    expect(stored?.metadata.created_at).toBe('2026-09-01T00:00:00.000Z');
    expect(stored?.metadata.updated_at).toBe('2026-09-05T00:00:00.000Z');
    expect(await store.list()).toHaveLength(1);
  });

  it('returns copies (callers cannot mutate stored state)', async () => {
    const store = make();
    const d = doc('decisions');
    await store.put(d);
    const got = (await store.get(d.id))!;
    got.metadata.title = 'mutated';
    expect((await store.get(d.id))?.metadata.title).toBe('Database choice');
  });
});

describe('FileContextStore specifics', () => {
  it('writes <id>.pco.json files that validate on their own', async () => {
    const dir = join(tempDir, 'contexts');
    const store = new FileContextStore(dir);
    const d = doc('mixed-context');
    await store.put(d);
    expect(await readdir(dir)).toEqual([`${d.id}.pco.json`]);
    const onDisk = JSON.parse(await readFile(join(dir, `${d.id}.pco.json`), 'utf8'));
    expect(validate(onDisk).ok).toBe(true);
  });

  it('skips and reports invalid files in the directory', async () => {
    const dir = join(tempDir, 'contexts');
    const invalid: string[] = [];
    const store = new FileContextStore(dir, { onInvalidFile: (i) => invalid.push(i.file) });
    await store.put(doc('decisions'));
    await writeFile(join(dir, 'broken.pco.json'), '{ not json');
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    expect((await store.list()).map((s) => s.title)).toEqual(['Database choice']);
    expect(invalid).toHaveLength(1);
  });

  it('rejects ids that could escape the directory', async () => {
    const store = new FileContextStore(join(tempDir, 'contexts'));
    expect(() => store.pathFor('../evil')).toThrow(/invalid PCO id/);
    expect(await store.get('../evil')).toBeNull();
    expect(await store.delete('..\\evil')).toBe(false);
  });

  it('defaults to $CIRA_HOME/contexts or ~/.cira/contexts', () => {
    expect(defaultContextDir({ CIRA_HOME: join(tempDir, 'home') })).toBe(join(tempDir, 'home', 'contexts'));
    expect(defaultContextDir({})).toMatch(/[\\/]\.cira[\\/]contexts$/);
  });
});

describe('KeyValueContextStore specifics', () => {
  it('keeps one key per document plus an index', async () => {
    const area = createMemoryArea();
    const store = new KeyValueContextStore(area, { prefix: 'test.' });
    const d = doc('decisions');
    await store.put(d);
    expect(Object.keys(area.dump()).sort()).toEqual([`test.doc.${d.id}`, 'test.index']);
  });

  it('serialises concurrent puts without losing index entries', async () => {
    const store = new KeyValueContextStore(createMemoryArea());
    await Promise.all(['decisions', 'constraints', 'mixed-context', 'simple-conversation'].map((f) => store.put(doc(f))));
    expect(await store.list()).toHaveLength(4);
  });
});
