/**
 * Structured-output provider abstraction.
 *
 * A provider turns (system prompt, user prompt, JSON Schema) into a JSON
 * string. It knows nothing about PCO. The semantic extractor validates
 * whatever comes back. Swapping vendors means writing another provider,
 * never touching extraction logic.
 *
 * Core stays environment-neutral: HTTP goes through an injected
 * `HttpTransport` (the default wraps the host's `fetch`).
 */

export interface StructuredRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface StructuredResponse {
  /** Raw JSON text as returned by the model. */
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface StructuredOutputProvider {
  /** Provider family, e.g. "openai-compatible". */
  readonly name: string;
  readonly model: string;
  /** "local" when the endpoint is on this machine; anything else is "remote". */
  readonly locality: 'local' | 'remote';
  /** Host that receives the prompt (no path, no credentials), for consent prompts and logs. */
  readonly endpointHost: string;
  generate(request: StructuredRequest): Promise<StructuredResponse>;
}

export type ProviderErrorCode = 'http' | 'timeout' | 'network' | 'bad_response' | 'config';

/** Provider failure. Messages never include prompts, conversation text or credentials. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;
  constructor(code: ProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// ── HTTP transport ────────────────────────────────────────────────────────

export interface HttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: unknown },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Transport over the host `fetch` (browsers, Node ≥ 18, Deno, Bun). */
export function fetchTransport(fetchImpl?: FetchLike): HttpTransport {
  return async (req) => {
    const g = globalThis as { fetch?: FetchLike; AbortSignal?: { timeout?(ms: number): unknown } };
    const f = fetchImpl ?? g.fetch;
    if (!f) throw new ProviderError('config', 'no fetch implementation available');
    const signal = g.AbortSignal?.timeout?.(req.timeoutMs);
    try {
      const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body, ...(signal ? { signal } : {}) });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new ProviderError('timeout', `semantic provider timed out after ${req.timeoutMs} ms`);
      throw new ProviderError('network', 'could not reach the semantic provider');
    }
  };
}

// ── Endpoint helpers ──────────────────────────────────────────────────────

export function endpointHost(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?/i.exec(url.trim());
  if (!m) return '';
  return m[2] ? `${m[1].toLowerCase()}:${m[2]}` : m[1].toLowerCase();
}

/** True for loopback endpoints (this machine). Everything else is treated as remote. */
export function isLoopbackUrl(url: string): boolean {
  const host = endpointHost(url).replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '::1';
}

/** Error text from a provider response, capped and checked so it cannot echo the prompt. */
function safeProviderMessage(body: string, prompt: string): string {
  let msg = '';
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const e = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message;
    if (typeof e === 'string') msg = e;
  } catch {
    // Non-JSON bodies are not echoed at all.
  }
  msg = msg.replace(/\s+/g, ' ').trim().slice(0, 160);
  for (let i = 0; i + 20 <= msg.length; i += 5) {
    if (prompt.includes(msg.slice(i, i + 20))) return '[provider message withheld: it may contain conversation text]';
  }
  return msg;
}

// ── OpenAI-compatible provider ────────────────────────────────────────────

export interface OpenAICompatibleConfig {
  /** e.g. "http://127.0.0.1:11434/v1" (Ollama), "http://127.0.0.1:1234/v1" (LM Studio), "https://api.openai.com/v1". */
  baseUrl: string;
  model: string;
  /** Sent as `Authorization: Bearer …`. Never stored in PCO, logs or errors. */
  apiKey?: string;
  transport?: HttpTransport;
  /**
   * json_schema (default): strict structured output. json_object: JSON mode
   * for servers without schema support (the schema is still enforced by Zod).
   */
  responseFormat?: 'json_schema' | 'json_object';
  timeoutMs?: number;
}

/**
 * One provider for every server that speaks the OpenAI Chat Completions API
 * (OpenAI, Ollama, LM Studio, vLLM, llama.cpp server, Groq, OpenRouter, …).
 */
export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): StructuredOutputProvider {
  if (!/^https?:\/\//i.test(config.baseUrl)) throw new ProviderError('config', 'baseUrl must be an http(s) URL');
  if (!config.model.trim()) throw new ProviderError('config', 'model is required');
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const transport = config.transport ?? fetchTransport();
  const timeoutMs = config.timeoutMs ?? 120_000;
  const format = config.responseFormat ?? 'json_schema';

  return {
    name: 'openai-compatible',
    model: config.model,
    locality: isLoopbackUrl(config.baseUrl) ? 'local' : 'remote',
    endpointHost: endpointHost(config.baseUrl),
    async generate(req) {
      const body = {
        model: config.model,
        temperature: req.temperature ?? 0,
        ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format:
          format === 'json_schema'
            ? { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.schema } }
            : { type: 'json_object' },
      };
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

      const res = await transport({ url, method: 'POST', headers, body: JSON.stringify(body), timeoutMs });
      if (res.status < 200 || res.status >= 300) {
        const detail = safeProviderMessage(res.body, req.system + req.user);
        throw new ProviderError('http', `semantic provider returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
      }
      let parsed: { choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      try {
        parsed = JSON.parse(res.body);
      } catch {
        throw new ProviderError('bad_response', 'semantic provider returned a non-JSON HTTP body');
      }
      const message = parsed.choices?.[0]?.message;
      if (typeof message?.refusal === 'string' && message.refusal) throw new ProviderError('bad_response', 'semantic provider refused the request');
      if (typeof message?.content !== 'string') throw new ProviderError('bad_response', 'semantic provider response has no message content');
      return {
        text: message.content,
        usage: { input_tokens: parsed.usage?.prompt_tokens, output_tokens: parsed.usage?.completion_tokens },
      };
    },
  };
}

// ── Scripted provider (tests, demos, offline replay) ──────────────────────

/**
 * Returns pre-recorded JSON. Not a model: its locality is "local" and its
 * name is "scripted" so it can never be mistaken for real semantic
 * extraction. Useful for tests, CIRA-Bench replays and demos.
 */
export function createScriptedProvider(
  respond: string | ((request: StructuredRequest) => string),
  options: { model?: string } = {},
): StructuredOutputProvider & { requests: StructuredRequest[] } {
  const requests: StructuredRequest[] = [];
  return {
    name: 'scripted',
    model: options.model ?? 'scripted',
    locality: 'local',
    endpointHost: 'in-process',
    requests,
    async generate(req) {
      requests.push(req);
      return { text: typeof respond === 'string' ? respond : respond(req) };
    },
  };
}
