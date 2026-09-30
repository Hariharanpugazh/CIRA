/**
 * Regression: Unicode survives the local half of the capture path, byte for byte.
 *
 *   captured conversation (fixture = exactly what the extension emits; see
 *   apps/browser-extension/tests/unicode-capture.regression.test.ts)
 *   → legacy migration + encode (the call the extension's service worker makes)
 *   → Chrome native-messaging frame (UTF-8 JSON behind a 32-bit LE length),
 *     delivered in chunks that split multi-byte characters
 *   → `cira native-host` (runHost) → ~/.cira/contexts/<id>.pco.json
 *   → `cira validate` / `cira export --format md|json|pco` / `export -o`.
 *
 * The stored file must be BOM-less UTF-8 holding the original code points.
 * If Windows PowerShell 5.1 shows `â”œâ”€â”€` for `├──`, the file was read as
 * Windows-1252: use `Get-Content -Encoding UTF8` or `cira export -o <file>`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { TextDecoder } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyConversation, validate, type LegacyConversationV0, type PCODocument } from '@cira/core';
import { FileContextStore } from '@cira/core/node';
import { main } from '../src/main';
import { FrameDecoder } from '../src/native/framing';
import { runHost } from '../src/native/host';

const FIXTURE = resolve(__dirname, '../../packages/core/tests/fixtures/legacy/chatgpt-unicode-capture.json');
const CLIENT = 'cira-browser-extension@0.1.0';

const TREE = ['project/', '├── frontend/', '│   ├── src/', '│   └── App.tsx', '└── README.md'].join('\n');
const FLOW = ['Browser (React)', '      │', '      ▼', 'Django /api/auth/login → JWT ✓ 🔐 connexion réussie · ログイン成功'].join('\n');
const PROSE = 'Multilingual: Café naïve façade — 日本語 · Ελληνικά · हिन्दी · русский · 😀';

/** Characters inside the two code blocks (these reach every export format). */
const CODE_SAMPLES = ['├──', '│', '└──', '▼', '→', '✓', '🔐', 'é', '·', 'ログイン'];
/** Everything in the transcript. */
const ALL_SAMPLES = [...CODE_SAMPLES, '—', '日本語', 'Ελληνικά', 'हिन्दी', 'русский', '😀'];

const utf8 = (s: string) => Buffer.from(s, 'utf8');
/** The exact corruption from the report: UTF-8 bytes read as Windows-1252. */
const asWindows1252 = (s: string) => new TextDecoder('windows-1252').decode(utf8(s));

function count(haystack: Buffer, needle: Buffer): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function expectUnicodeIntact(text: string, samples: string[]): void {
  for (const s of samples) {
    expect(text, `missing ${s}`).toContain(s);
    expect(text, `mojibake of ${s}`).not.toContain(asWindows1252(s));
  }
}

/** What Chrome writes to the host's stdin for `chrome.runtime.sendNativeMessage`. */
function chromeFrame(message: unknown): Buffer {
  const body = utf8(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Cut right after the first byte of each needle, so those characters straddle two chunks. */
function splitInside(frame: Buffer, needles: string[]): Buffer[] {
  const cuts = [...new Set(needles.map((n) => frame.indexOf(utf8(n)) + 1).filter((i) => i > 0))].sort((a, b) => a - b);
  const chunks: Buffer[] = [];
  let prev = 0;
  for (const cut of cuts) {
    chunks.push(frame.subarray(prev, cut));
    prev = cut;
  }
  chunks.push(frame.subarray(prev));
  return chunks;
}

let dir = '';
let out = '';
let err = '';
const io = () => ({
  stdout: (t: string) => void (out += t),
  stderr: (t: string) => void (err += t),
  env: { CIRA_HOME: join(dir, 'home') } as NodeJS.ProcessEnv,
  cwd: dir,
});
const cira = (...argv: string[]) => main(argv, io());

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cira-unicode-'));
  out = '';
  err = '';
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Saved {
  sent: PCODocument;
  reply: { ok: boolean; type: string; id: string; path: string; item_count: number };
  bytes: Buffer;
  chunks: number;
}

/** Browser → native host → disk, exactly as a capture reaches ~/.cira/contexts. */
async function captureThroughHost(): Promise<Saved> {
  const conversation = JSON.parse(await readFile(FIXTURE, 'utf8')) as LegacyConversationV0;
  const { document } = migrateLegacyConversation(conversation, { client: CLIENT, createdBy: CLIENT, now: new Date('2026-09-30T09:15:05.000Z') });

  const store = new FileContextStore(join(dir, 'home', 'contexts'));
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Buffer[] = [];
  output.on('data', (c: Buffer) => replies.push(c));
  const done = runHost(store, { input, output, log: () => {} });

  const chunks = splitInside(chromeFrame({ type: 'save', document }), ['├', '│', '└', '▼', '→', '✓', 'é', 'ロ', '日', 'ह', '😀', '🔐']);
  for (const chunk of chunks) {
    input.write(chunk);
    await new Promise((r) => setImmediate(r)); // deliver each chunk as its own 'data' event
  }
  input.end();
  await done;

  const [reply] = new FrameDecoder().push(Buffer.concat(replies)) as Saved['reply'][];
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, type: 'saved' });
  return { sent: document, reply, bytes: await readFile(reply.path), chunks: chunks.length };
}

describe('Unicode survives native host → ~/.cira/contexts → CLI', () => {
  it('uses the real characters (guards this file and the fixture against re-encoding)', async () => {
    expect([...'├─│└▼→✓'].map((c) => c.codePointAt(0))).toEqual([0x251c, 0x2500, 0x2502, 0x2514, 0x25bc, 0x2192, 0x2713]);
    expect(asWindows1252('├──')).toBe('â”œâ”€â”€');
    const fixture = await readFile(FIXTURE);
    expect(fixture.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expectUnicodeIntact(fixture.toString('utf8'), ALL_SAMPLES);
  });

  it('writes BOM-less UTF-8 with the original bytes when frames split multi-byte characters', async () => {
    const { sent, reply, bytes, chunks } = await captureThroughHost();
    expect(chunks).toBeGreaterThan(10);
    expect(reply).toMatchObject({ ok: true, type: 'saved', id: sent.id, item_count: 6 });

    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); // throws on invalid UTF-8
    // "├── frontend/" is E2 94 9C, E2 94 80, E2 94 80 on disk, never C3 A2 E2 80 9D C5 93 ("â”œ").
    expect(bytes.includes(Buffer.from('e2949ce29480e294802066726f6e74656e642f', 'hex'))).toBe(true);
    for (const s of ALL_SAMPLES) {
      expect(count(bytes, utf8(s)), `bytes of ${s}`).toBeGreaterThan(0);
      expect(count(bytes, utf8(asWindows1252(s))), `mojibake of ${s}`).toBe(0);
    }

    const onDisk = JSON.parse(text) as PCODocument;
    expect(validate(onDisk).ok).toBe(true);
    expect(onDisk).toEqual(sent);
    expect(onDisk.conversations[0].turns[1].content).toContain(PROSE);
    expect(onDisk.items.filter((i) => i.type === 'code_artifact').map((i) => i.content)).toEqual([TREE, FLOW]);
  });

  it('validate and every export format keep the characters', async () => {
    const { reply, bytes } = await captureThroughHost();
    const stored = JSON.parse(bytes.toString('utf8')) as PCODocument;

    expect(await cira('validate', reply.path)).toBe(0);
    expect(out).toMatch(/^VALID: /);

    out = '';
    expect(await cira('export', reply.id, '--format', 'md')).toBe(0);
    const md = out;
    expect(md).toContain(`\`\`\`\n${TREE}\n\`\`\``);
    expect(md).toContain(`\`\`\`\n${FLOW}\n\`\`\``);
    expectUnicodeIntact(md, CODE_SAMPLES);

    out = '';
    expect(await cira('export', reply.id, '--format', 'json')).toBe(0);
    const decoded = JSON.parse(out) as { sections: Array<{ type: string; items: Array<{ item: { content: string } }> }> };
    expect(decoded.sections.find((s) => s.type === 'code_artifact')?.items.map((d) => d.item.content)).toEqual([TREE, FLOW]);
    expectUnicodeIntact(out, CODE_SAMPLES);

    out = '';
    expect(await cira('export', reply.id, '--format', 'pco')).toBe(0);
    expect(JSON.parse(out)).toEqual(stored);
    expectUnicodeIntact(out, ALL_SAMPLES);

    // `-o` writes UTF-8 itself, so no shell/console decoding is involved.
    expect(await cira('export', reply.id, '--format', 'md', '-o', 'context.md')).toBe(0);
    const mdBytes = await readFile(join(dir, 'context.md'));
    expect(new TextDecoder('utf-8', { fatal: true }).decode(mdBytes)).toBe(md);
    for (const s of CODE_SAMPLES) expect(count(mdBytes, utf8(asWindows1252(s))), `mojibake of ${s}`).toBe(0);
    expect(err).toContain('Wrote ');
  });
});
