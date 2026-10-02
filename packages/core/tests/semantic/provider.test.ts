import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenAICompatibleProvider,
  createScriptedProvider,
  createSemanticExtractor,
  endpointHost,
  ExtractionError,
  isLoopbackUrl,
  listModels,
  ProviderError,
  type HttpRequest,
  type HttpTransport,
} from '../../src';
import { extractionInput, STACK_MODEL_OUTPUT, STACK_TURNS } from './helpers';

function fakeHttp(respond: (req: HttpRequest) => { status: number; body: string }): HttpTransport & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const t = (async (req: HttpRequest) => {
    calls.push(req);
    return respond(req);
  }) as HttpTransport & { calls: HttpRequest[] };
  t.calls = calls;
  return t;
}

const completion = (content: string) => ({
  status: 200,
  body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 120, completion_tokens: 80 } }),
});

describe('endpoint locality', () => {
  it('treats loopback as local and everything else as remote', () => {
    expect(isLoopbackUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLoopbackUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8080/v1')).toBe(true);
    expect(isLoopbackUrl('https://api.openai.com/v1')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.10:11434/v1')).toBe(false);
    expect(isLoopbackUrl('http://localhost.evil.com/v1')).toBe(false);
    expect(endpointHost('https://user:secret@api.example.com:8443/v1')).toBe('api.example.com:8443');
  });
});

describe('OpenAI-compatible provider', () => {
  it('sends a strict json_schema chat completion with the API key only in the header', async () => {
    const http = fakeHttp(() => completion(JSON.stringify(STACK_MODEL_OUTPUT)));
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://api.example.com/v1/', model: 'model-x', apiKey: 'sk-test-KEY', transport: http });
    expect(provider.locality).toBe('remote');
    const ex = createSemanticExtractor({ provider });
    const r = await ex.extract(extractionInput(STACK_TURNS));

    const [call] = http.calls;
    expect(call.url).toBe('https://api.example.com/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer sk-test-KEY');
    const body = JSON.parse(call.body);
    expect(body.model).toBe('model-x');
    expect(body.temperature).toBe(0);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema).toMatchObject({ name: 'cira_context', strict: true });
    expect(call.body).not.toContain('sk-test-KEY');

    expect(r.items).toHaveLength(7);
    expect(r.usage).toMatchObject({ input_tokens: 120, output_tokens: 80 });
    expect(r.extractor).toEqual({ id: 'cira.semantic', version: '0.1.0', kind: 'semantic', locality: 'remote', provider: 'openai-compatible', model: 'model-x' });
    expect(JSON.stringify(r)).not.toContain('sk-test-KEY');
  });

  it('supports JSON mode for servers without schema support', async () => {
    const http = fakeHttp(() => completion(JSON.stringify(STACK_MODEL_OUTPUT)));
    const provider = createOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen', transport: http, responseFormat: 'json_object' });
    expect(provider.locality).toBe('local');
    await createSemanticExtractor({ provider }).extract(extractionInput(STACK_TURNS));
    expect(JSON.parse(http.calls[0].body).response_format).toEqual({ type: 'json_object' });
    expect(http.calls[0].headers.authorization).toBeUndefined();
  });

  it('turns HTTP errors into ProviderError without leaking the prompt or the key', async () => {
    const turns = STACK_TURNS;
    const http = fakeHttp((req) => ({ status: 400, body: JSON.stringify({ error: { message: `bad request near: ${JSON.parse(req.body).messages[1].content.slice(0, 300)}` } }) }));
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-live-SECRET', transport: http });
    const err = await createSemanticExtractor({ provider }).extract(extractionInput(turns)).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect(err.message).toMatch(/HTTP 400/);
    const everything = err.message + JSON.stringify(err.diagnostics);
    expect(everything).not.toContain('TypeScript project');
    expect(everything).not.toContain('sk-live-SECRET');
    expect(err.diagnostics[0].code).toBe('provider_http');
  });

  it('keeps short, harmless provider messages', async () => {
    const http = fakeHttp(() => ({ status: 404, body: JSON.stringify({ error: { message: 'model "nope" not found' } }) }));
    const provider = createOpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', model: 'nope', transport: http });
    await expect(provider.generate({ system: 's', user: 'u', schemaName: 'x', schema: {} })).rejects.toThrow('HTTP 404: model "nope" not found');
  });

  it('rejects malformed provider responses', async () => {
    for (const body of ['<html>502</html>', JSON.stringify({ choices: [] }), JSON.stringify({ choices: [{ message: { refusal: 'no' } }] })]) {
      const provider = createOpenAICompatibleProvider({ baseUrl: 'http://localhost/v1', model: 'm', transport: fakeHttp(() => ({ status: 200, body })) });
      await expect(provider.generate({ system: 's', user: 'u', schemaName: 'x', schema: {} })).rejects.toBeInstanceOf(ProviderError);
    }
  });

  it('validates configuration', () => {
    expect(() => createOpenAICompatibleProvider({ baseUrl: 'ftp://x', model: 'm' })).toThrow(ProviderError);
    expect(() => createOpenAICompatibleProvider({ baseUrl: 'http://localhost/v1', model: ' ' })).toThrow(/model is required/);
  });
});

describe('listModels', () => {
  function stubFetch(status: number, body: string) {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string> } }> = [];
    const fn = vi.fn(async (url: string, init: { method: string; headers: Record<string, string> }) => {
      calls.push({ url, init });
      return { status, async text() { return body; } };
    });
    vi.stubGlobal('fetch', fn);
    return { calls };
  }
  afterEach(() => vi.unstubAllGlobals());

  it('parses the OpenAI { data: [{ id }] } shape, sorted and deduped', async () => {
    const { calls } = stubFetch(200, JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-3.5-turbo' }, { id: 'gpt-4o' }] }));
    const models = await listModels({ baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-KEY' });
    expect(models).toEqual(['gpt-3.5-turbo', 'gpt-4o']);
    expect(calls[0].url).toBe('https://api.openai.com/v1/models');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers.authorization).toBe('Bearer sk-KEY');
  });

  it('parses Ollama { models: [{ name }] } and bare string arrays', async () => {
    stubFetch(200, JSON.stringify({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.3:70b' }] }));
    expect(await listModels({ baseUrl: 'http://127.0.0.1:11434/v1' })).toEqual(['llama3.3:70b', 'qwen2.5:7b']);
    stubFetch(200, JSON.stringify(['b-model', 'a-model']));
    expect(await listModels({ baseUrl: 'http://127.0.0.1:1234/v1' })).toEqual(['a-model', 'b-model']);
  });

  it('maps HTTP and empty results to ProviderError', async () => {
    stubFetch(401, JSON.stringify({ error: { message: 'bad key' } }));
    const e401 = await listModels({ baseUrl: 'https://api.openai.com/v1', apiKey: 'x' }).catch((e) => e);
    expect(e401).toBeInstanceOf(ProviderError);
    expect(e401.status).toBe(401);
    stubFetch(200, JSON.stringify({ data: [] }));
    await expect(listModels({ baseUrl: 'https://api.openai.com/v1' })).rejects.toThrow(/no models/);
  });

  it('does not send an Authorization header when no key is given', async () => {
    const { calls } = stubFetch(200, JSON.stringify({ data: [{ id: 'm' }] }));
    await listModels({ baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(calls[0].init.headers.authorization).toBeUndefined();
  });
});

describe('SemanticExtractor', () => {
  it('rejects malformed model output as a whole', async () => {
    for (const text of ['not json', JSON.stringify({ items: [{ ref: 'i1', type: 'fact' }], relations: [] })]) {
      const err = await createSemanticExtractor({ provider: createScriptedProvider(text) }).extract(extractionInput(STACK_TURNS)).catch((e) => e);
      expect(err).toBeInstanceOf(ExtractionError);
      expect(err.diagnostics[0].code).toBe('invalid_output');
    }
  });

  it('sends only the selected turns, with their original message refs, and nothing else', async () => {
    const provider = createScriptedProvider('{"items":[],"relations":[]}');
    const input = extractionInput([
      ['user', 'SELECTED-A'],
      ['assistant', 'SELECTED-B'],
    ]);
    // Simulate a selection of original messages 3 and 7.
    input.conversation.turns[0].index = 3;
    input.conversation.turns[1].index = 7;
    await createSemanticExtractor({ provider }).extract(input);
    const [req] = provider.requests;
    const sent = JSON.parse(req.user.slice(req.user.indexOf('[')));
    expect(sent).toEqual([
      { ref: 'm3', role: 'user', content: 'SELECTED-A' },
      { ref: 'm7', role: 'assistant', content: 'SELECTED-B' },
    ]);
    expect(req.user).not.toContain(input.conversation.url!);
    expect(req.user).not.toContain(input.conversation.title!);
  });

  it('refuses oversized selections instead of truncating them', async () => {
    const provider = createScriptedProvider('{"items":[],"relations":[]}');
    const err = await createSemanticExtractor({ provider, maxInputChars: 50 }).extract(extractionInput(STACK_TURNS)).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect(err.diagnostics[0].code).toBe('input_too_large');
    expect(provider.requests).toHaveLength(0);
  });

  it('does not call the provider when no messages are selected', async () => {
    const provider = createScriptedProvider('{"items":[],"relations":[]}');
    const r = await createSemanticExtractor({ provider }).extract(extractionInput([]));
    expect(r.items).toEqual([]);
    expect(provider.requests).toHaveLength(0);
  });

  it('reports a content-free summary diagnostic', async () => {
    const r = await createSemanticExtractor({ provider: createScriptedProvider(JSON.stringify(STACK_MODEL_OUTPUT)) }).extract(extractionInput(STACK_TURNS));
    expect(r.diagnostics.at(-1)).toEqual({ level: 'info', code: 'summary', message: '7 candidate(s) from the model, 7 accepted, 0 rejected' });
  });
});
