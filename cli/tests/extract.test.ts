import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encode, fromLegacyConversation, getSemanticExtension, validate, type HttpRequest, type HttpTransport } from '@cira/core';
import { main } from '../src/main';
import { parseMessageSelection } from '../src/semantic-config';

const FIXTURES = resolve(__dirname, '../../packages/core/tests/fixtures');
const EVAL = join(FIXTURES, 'eval');

let dir = '';
let out = '';
let err = '';
const env = (): NodeJS.ProcessEnv => ({ CIRA_HOME: join(dir, 'home') });
const io = (extraEnv: NodeJS.ProcessEnv = {}) => ({
  stdout: (t: string) => void (out += t),
  stderr: (t: string) => void (err += t),
  env: { ...env(), ...extraEnv },
  cwd: dir,
});

/** Fake OpenAI-compatible server that answers with `content` and records requests. */
function fakeServer(content: string | ((req: HttpRequest) => string)): HttpTransport & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const t = (async (req: HttpRequest) => {
    calls.push(req);
    const c = typeof content === 'string' ? content : content(req);
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: c } }] }) };
  }) as HttpTransport & { calls: HttpRequest[] };
  t.calls = calls;
  return t;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cira-extract-'));
  out = '';
  err = '';
  const fixture = JSON.parse(await readFile(join(EVAL, 'typescript-stack.eval.json'), 'utf8'));
  await writeFile(join(dir, 'stack.json'), JSON.stringify(fixture.conversation));
  await copyFile(join(FIXTURES, 'legacy/chatgpt-popup-export.json'), join(dir, 'chat.json'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cira extract', () => {
  it('defaults to deterministic mode: same PCO as `cira migrate`, no network', async () => {
    const server = fakeServer('{}');
    expect(await main(['extract', 'chat.json'], io({ CIRA_SEMANTIC_MODEL: 'm' }), { transport: server })).toBe(0);
    expect(server.calls).toHaveLength(0);
    const doc = JSON.parse(await readFile(join(dir, 'chat.pco.json'), 'utf8'));
    const legacy = JSON.parse(await readFile(join(dir, 'chat.json'), 'utf8'));
    const expected = encode(fromLegacyConversation(legacy, { kind: 'browser' }).input, { now: doc.metadata.created_at, createdBy: 'cira-cli@0.1.0' });
    expect(doc).toEqual(expected);
  });

  it('semantic mode with a local model: attributed PCO, provider sees only the selected messages', async () => {
    const reference = await readFile(join(EVAL, 'reference/typescript-stack.json'), 'utf8');
    const server = fakeServer(reference);
    const code = await main(['extract', 'stack.json', '--mode', 'semantic', '--model', 'qwen2.5', '-o', 'stack.sem.pco.json'], io(), { transport: server });
    expect(err).not.toContain('error');
    expect(code).toBe(0);
    expect(server.calls[0].url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(err).toContain('semantic extraction: 2 selected message(s) → 127.0.0.1:11434 (local, model qwen2.5)');
    const doc = JSON.parse(await readFile(join(dir, 'stack.sem.pco.json'), 'utf8'));
    expect(validate(doc).ok).toBe(true);
    const ext = getSemanticExtension(doc)!;
    expect(ext.mode).toBe('semantic');
    expect(Object.values(ext.items).filter((a) => a.origin === 'assistant')).toHaveLength(3);
    expect(err).toMatch(/origin: 4 user, 3 assistant/);
  });

  it('--messages selects 1-based messages; unselected text never reaches the provider or the PCO', async () => {
    const convo = {
      source: 'chatgpt', title: 't', url: 'https://chatgpt.com/c/sel', capturedAt: '2026-09-30T09:00:00.000Z',
      messages: Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `MARKER-${i + 1}. The API must be versioned.` })),
    };
    await writeFile(join(dir, 'ten.json'), JSON.stringify(convo));
    const server = fakeServer('{"items":[],"relations":[]}');
    expect(await main(['extract', 'ten.json', '--mode', 'hybrid', '--model', 'm', '--messages', '2,5-6,9', '--stdout'], io(), { transport: server })).toBe(0);
    const sent = server.calls[0].body;
    for (let n = 1; n <= 10; n++) {
      if ([2, 5, 6, 9].includes(n)) expect(sent).toContain(`MARKER-${n}.`);
      else expect(sent).not.toContain(`MARKER-${n}.`);
    }
    const doc = JSON.parse(out);
    expect(doc.conversations[0].turns.map((t: { index: number }) => t.index)).toEqual([1, 4, 5, 8]);
    expect(out).not.toContain('MARKER-1.');
  });

  it('refuses remote endpoints without --allow-remote, and never prints the API key', async () => {
    const server = fakeServer('{"items":[],"relations":[]}');
    const e = io({ CIRA_SEMANTIC_API_KEY: 'sk-live-TOPSECRET' });
    expect(await main(['extract', 'stack.json', '--mode', 'semantic', '--model', 'gpt-x', '--base-url', 'https://api.example.com/v1'], e, { transport: server })).toBe(1);
    expect(err).toContain('refusing to send 2 selected message(s) to remote endpoint api.example.com');
    expect(server.calls).toHaveLength(0);

    err = '';
    expect(await main(['extract', 'stack.json', '--mode', 'semantic', '--model', 'gpt-x', '--base-url', 'https://api.example.com/v1', '--allow-remote', '--stdout'], e, { transport: server })).toBe(0);
    expect(server.calls[0].headers.authorization).toBe('Bearer sk-live-TOPSECRET');
    expect(err + out).not.toContain('TOPSECRET');
    expect(err).toContain('(remote, model gpt-x)');
  });

  it('refuses to send potential secrets to a remote endpoint unless --allow-secrets', async () => {
    const token = ['ghp', '_', 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8'].join('');
    await writeFile(join(dir, 'leak.json'), JSON.stringify({ source: 'chatgpt', title: 't', url: 'https://chatgpt.com/c/leak', capturedAt: '2026-09-30T09:00:00.000Z', messages: [{ role: 'user', content: `deploy with ${token}` }] }));
    const server = fakeServer('{"items":[],"relations":[]}');
    expect(await main(['extract', 'leak.json', '--mode', 'semantic', '--model', 'm', '--base-url', 'https://api.example.com/v1', '--allow-remote'], io(), { transport: server })).toBe(1);
    expect(err).toContain('potential secret');
    expect(server.calls).toHaveLength(0);
  });

  it('hybrid falls back to deterministic with a warning when the model output is invalid', async () => {
    const server = fakeServer('I am not JSON');
    expect(await main(['extract', 'stack.json', '--mode', 'hybrid', '--model', 'm', '--stdout'], io(), { transport: server })).toBe(0);
    expect(err).toContain('semantic_fallback');
    const doc = JSON.parse(out);
    expect(getSemanticExtension(doc)!.fallback).toBe(true);
    expect(doc.items.length).toBeGreaterThan(0);
  });

  it('semantic mode fails loudly on invalid model output, and needs a model', async () => {
    expect(await main(['extract', 'stack.json', '--mode', 'semantic', '--model', 'm'], io(), { transport: fakeServer('nope') })).toBe(1);
    expect(err).toContain('semantic extraction failed');
    err = '';
    expect(await main(['extract', 'stack.json', '--mode', 'semantic'], io())).toBe(2);
    expect(err).toContain('needs a model');
  });

  it('re-extracts an existing PCO without overwriting it, and `cira validate` reports the extension', async () => {
    await main(['migrate', 'stack.json'], io());
    expect(existsSync(join(dir, 'stack.pco.json'))).toBe(true);
    const reference = await readFile(join(EVAL, 'reference/typescript-stack.json'), 'utf8');
    out = '';
    expect(await main(['extract', 'stack.pco.json', '--mode', 'hybrid', '--model', 'm'], io(), { transport: fakeServer(reference) })).toBe(0);
    expect(out).toContain('stack.hybrid.pco.json');
    out = '';
    expect(await main(['validate', 'stack.hybrid.pco.json'], io())).toBe(0);
    expect(out).toContain('semantic extension: mode hybrid, cira.deterministic@0.1.0 + cira.semantic@0.1.0');
    expect(out).not.toContain('WARNING');
  });

  it('rejects invalid modes and selections', async () => {
    expect(await main(['extract', 'stack.json', '--mode', 'magic'], io())).toBe(2);
    expect(await main(['extract', 'stack.json', '--messages', '9'], io())).toBe(2);
    expect(() => parseMessageSelection('3-1')).toThrow();
    expect(parseMessageSelection('3, 1-2,2')).toEqual([0, 1, 2]);
  });
});

describe('cira eval', () => {
  it('scores the deterministic baseline on the fixture set', async () => {
    expect(await main(['eval', EVAL], io())).toBe(0);
    expect(out).toContain('mode: deterministic');
    expect(out).toMatch(/TOTAL \(micro\)\s+100\.0%\s+54\.5%\s+70\.6%/);
  });

  it('replays recorded model outputs (perfect reference) in semantic mode', async () => {
    expect(await main(['eval', EVAL, '--mode', 'semantic', '--replay', join(EVAL, 'reference')], io())).toBe(0);
    expect(out).toMatch(/TOTAL \(micro\)\s+100\.0%\s+100\.0%\s+100\.0%\s+100\.0%\s+100\.0%/);
  });

  it('does not report a total when every fixture failed', async () => {
    const code = await main(['eval', join(EVAL, 'django-vs-fastapi.eval.json'), '--mode', 'semantic', '--model', 'm'], io(), { transport: fakeServer('{"items":[{"ref":"x"}]}') });
    expect(code).toBe(1);
    expect(out).toContain('n/a (no fixture completed)');
    expect(out).toContain('1 of 1 fixture(s) failed');
    expect(out).not.toMatch(/TOTAL \(micro\)\s+100/);
  });

  it('emits machine-readable JSON', async () => {
    expect(await main(['eval', join(EVAL, 'django-vs-fastapi.eval.json'), '--json'], io())).toBe(0);
    const r = JSON.parse(out);
    expect(r.mode).toBe('deterministic');
    expect(r.fixtures[0].fixture).toBe('django-vs-fastapi');
  });
});
