import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validate } from '@cira/core';
import { FileContextStore } from '@cira/core/node';
import { main } from '../src/main';
import { encodeFrame, FrameDecoder } from '../src/native/framing';
import { handleHostMessage, runHost } from '../src/native/host';
import { planInstall } from '../src/native/install';

const FIXTURES = resolve(__dirname, '../../packages/core/tests/fixtures');
const EXAMPLES = resolve(__dirname, '../../packages/pco/examples');

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
  dir = await mkdtemp(join(tmpdir(), 'cira-cli-'));
  out = '';
  err = '';
  await copyFile(join(FIXTURES, 'legacy/chatgpt-popup-export.json'), join(dir, 'conversation.json'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cira CLI', () => {
  it('prints help and version', async () => {
    expect(await cira('--help')).toBe(0);
    expect(out).toContain('cira validate');
    out = '';
    expect(await cira('--version')).toBe(0);
    expect(out).toMatch(/^cira 0\.1\.0 \(PCO v0\.1\)/);
  });

  it('acceptance workflow: migrate → validate → save → list → export', async () => {
    expect(await cira('migrate', 'conversation.json')).toBe(0);
    const pcoFile = join(dir, 'conversation.pco.json');
    expect(existsSync(pcoFile)).toBe(true);
    expect(validate(JSON.parse(await readFile(pcoFile, 'utf8'))).ok).toBe(true);

    out = '';
    expect(await cira('validate', 'conversation.pco.json')).toBe(0);
    expect(out).toMatch(/^VALID: conversation\.pco\.json/);

    out = '';
    expect(await cira('save', 'conversation.pco.json')).toBe(0);
    const stored = await readdir(join(dir, 'home', 'contexts'));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^pco_[0-9a-f]{16}\.pco\.json$/);

    out = '';
    expect(await cira('list')).toBe(0);
    expect(out).toContain('Vite + React extension setup');

    out = '';
    expect(await cira('export', 'conversation.pco.json', '--format', 'md')).toBe(0);
    expect(out).toMatch(/^# Context: Vite \+ React extension setup/);
    expect(out).toContain('## Constraints');
    expect(out).toContain('Do not use webpack.');

    // Export by stored id gives the same context.
    const id = stored[0].replace('.pco.json', '');
    const byFile = out;
    out = '';
    expect(await cira('export', id)).toBe(0);
    expect(out).toBe(byFile);
  });

  it('export filters by type and supports json/pco formats', async () => {
    await cira('migrate', 'conversation.json');
    out = '';
    expect(await cira('export', 'conversation.pco.json', '--types', 'constraint,task', '--format', 'json')).toBe(0);
    const decoded = JSON.parse(out);
    expect(decoded.sections.map((s: { type: string }) => s.type)).toEqual(['constraint', 'task']);

    out = '';
    expect(await cira('export', 'conversation.pco.json', '--format', 'pco')).toBe(0);
    expect(validate(JSON.parse(out)).ok).toBe(true);

    expect(await cira('export', 'conversation.pco.json', '--types', 'feelings')).toBe(2);
    expect(err).toContain('unknown context type');
  });

  it('validate reports errors with paths and a non-zero exit code', async () => {
    const doc = JSON.parse(await readFile(join(EXAMPLES, 'decisions.pco.json'), 'utf8'));
    doc.items[0].provenance.turn_id = 'missing_turn';
    doc.items.push({ ...doc.items[1] });
    await writeFile(join(dir, 'bad.pco.json'), JSON.stringify(doc));
    expect(await cira('validate', 'bad.pco.json')).toBe(1);
    expect(out).toContain('ERROR unknown_turn at $.items[0].provenance.turn_id');
    expect(out).toContain('ERROR duplicate_id');
    expect(out).toContain('INVALID: bad.pco.json');

    out = '';
    expect(await cira('validate', 'bad.pco.json', '--json')).toBe(1);
    expect(JSON.parse(out).ok).toBe(false);
  });

  it('validate suggests migrate for legacy exports', async () => {
    expect(await cira('validate', 'conversation.json')).toBe(1);
    expect(out).toContain('cira migrate conversation.json');
  });

  it('warns about potential secrets on migrate and save', async () => {
    const conv = JSON.parse(await readFile(join(dir, 'conversation.json'), 'utf8'));
    conv.messages.push({ role: 'user', content: 'token ' + ['ghp', '_', 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8'].join('') });
    await writeFile(join(dir, 'leaky.json'), JSON.stringify(conv));
    expect(await cira('migrate', 'leaky.json', '--save')).toBe(0);
    expect(err).toContain('SAFETY WARNING');
    expect(err).not.toContain('Q1w2E3r4T5y6U7i8O9p0');
  });

  it('usage errors exit with 2', async () => {
    expect(await cira('frobnicate')).toBe(2);
    expect(await cira('validate')).toBe(2);
    expect(await cira('export', 'x', '--format', 'pdf')).toBe(2);
  });

  it('missing files exit with 1 and a readable message', async () => {
    expect(await cira('validate', 'nope.json')).toBe(1);
    expect(err).toContain('file not found');
  });
});

describe('native host', () => {
  it('frames messages exactly like Chrome native messaging', () => {
    const frame = encodeFrame({ type: 'ping' });
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    const dec = new FrameDecoder();
    // Split across chunks.
    expect(dec.push(frame.subarray(0, 3))).toEqual([]);
    expect(dec.push(Buffer.concat([frame.subarray(3), frame]))).toEqual([{ type: 'ping' }, { type: 'ping' }]);
    expect(dec.pending).toBe(0);
  });

  it('validates and saves documents to the file store', async () => {
    const store = new FileContextStore(join(dir, 'contexts'));
    const doc = JSON.parse(await readFile(join(EXAMPLES, 'mixed-context.pco.json'), 'utf8'));
    const res = await handleHostMessage({ type: 'save', document: doc }, store);
    expect(res).toMatchObject({ ok: true, type: 'saved', id: doc.id, item_count: doc.items.length });
    expect(await store.get(doc.id)).toEqual(doc);

    expect(await handleHostMessage({ type: 'ping' }, store)).toMatchObject({ ok: true, type: 'pong', protocol: 1 });
    const bad = await handleHostMessage({ type: 'save', document: { pco_version: '0.1' } }, store);
    expect(bad.ok).toBe(false);
    expect(await handleHostMessage({ type: 'rm -rf' }, store)).toMatchObject({ ok: false });
  });

  it('serves framed requests over streams until stdin closes', async () => {
    const store = new FileContextStore(join(dir, 'contexts'));
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (c: Buffer) => chunks.push(c));
    const done = runHost(store, { input, output, log: () => {} });
    const doc = JSON.parse(await readFile(join(EXAMPLES, 'decisions.pco.json'), 'utf8'));
    input.write(encodeFrame({ type: 'save', document: doc }));
    input.end();
    await done;
    const [res] = new FrameDecoder().push(Buffer.concat(chunks)) as Array<{ ok: boolean; path: string }>;
    expect(res.ok).toBe(true);
    expect(res.path).toBe(store.pathFor(doc.id));
  });

  it('plans a per-user install restricted to the given extension id', () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    const win = planInstall({
      extensionIds: [id],
      browser: 'chrome',
      platform: 'win32',
      env: { CIRA_HOME: 'C:\\Users\\u\\.cira' },
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'D:\\CIRA\\cli\\dist\\cira.js',
    });
    expect(win.registry).toEqual({
      key: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.cira.context_host',
      value: win.manifestPath,
    });
    const manifest = JSON.parse(win.files.find((f) => f.path.endsWith('.json'))!.content);
    expect(manifest).toMatchObject({ name: 'com.cira.context_host', type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] });
    expect(win.files[0].content).toContain('"D:\\CIRA\\cli\\dist\\cira.js" native-host %*');

    const linux = planInstall({
      extensionIds: [id],
      browser: 'chromium',
      platform: 'linux',
      env: { CIRA_HOME: '/home/u/.cira' },
      nodePath: '/usr/bin/node',
      scriptPath: '/opt/cira/cli/dist/cira.js',
      home: '/home/u',
    });
    expect(linux.registry).toBeUndefined();
    expect(linux.manifestPath.replace(/\\/g, '/')).toBe('/home/u/.config/chromium/NativeMessagingHosts/com.cira.context_host.json');
    expect(linux.files[0].mode).toBe(0o755);
  });

  it('rejects invalid extension ids and unbuilt script paths', () => {
    const base = { browser: 'chrome' as const, platform: 'linux' as const, env: {}, nodePath: 'node', scriptPath: '/x/cira.js' };
    expect(() => planInstall({ ...base, extensionIds: [] })).toThrow(/extension-id is required/);
    expect(() => planInstall({ ...base, extensionIds: ['not-an-id; rm -rf /'] })).toThrow(/not a Chrome extension ID/);
    expect(() => planInstall({ ...base, extensionIds: ['a'.repeat(32)], scriptPath: '/x/main.ts' })).toThrow(/built CLI/);
  });
});
