/**
 * Semantic provider configuration for the CLI.
 *
 * Sources (flags win over environment):
 *   --base-url  / CIRA_SEMANTIC_BASE_URL   default http://127.0.0.1:11434/v1 (a local Ollama)
 *   --model     / CIRA_SEMANTIC_MODEL      required for semantic/hybrid modes
 *                 CIRA_SEMANTIC_API_KEY    environment ONLY (never a flag: shell history)
 *   --response-format / CIRA_SEMANTIC_RESPONSE_FORMAT   json_schema (default) | json_object
 *   --allow-remote                          required for any non-loopback endpoint
 *
 * Credentials are passed to the provider in memory only. They are never
 * written to PCO files, logs or error messages.
 */
import {
  createOpenAICompatibleProvider,
  createSemanticExtractor,
  type ContextExtractor,
  type HttpTransport,
  type StructuredOutputProvider,
} from '@cira/core';
import { CliError, UsageError, type CliIO } from './io';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';

export interface SemanticFlags {
  baseUrl?: string;
  model?: string;
  responseFormat?: string;
  allowRemote?: boolean;
  timeoutMs?: number;
}

export interface SemanticSetup {
  extractor: ContextExtractor;
  provider: StructuredOutputProvider;
}

export function createCliSemanticExtractor(io: CliIO, flags: SemanticFlags, selectedMessages: number, transport?: HttpTransport): SemanticSetup {
  const baseUrl = flags.baseUrl ?? io.env.CIRA_SEMANTIC_BASE_URL ?? DEFAULT_BASE_URL;
  const model = flags.model ?? io.env.CIRA_SEMANTIC_MODEL;
  if (!model) {
    throw new UsageError('semantic extraction needs a model: pass --model <name> or set CIRA_SEMANTIC_MODEL (or use --mode deterministic)');
  }
  const format = flags.responseFormat ?? io.env.CIRA_SEMANTIC_RESPONSE_FORMAT ?? 'json_schema';
  const envTimeout = io.env.CIRA_SEMANTIC_TIMEOUT ? Number(io.env.CIRA_SEMANTIC_TIMEOUT) * 1000 : undefined;
  const timeoutMs = flags.timeoutMs ?? (envTimeout && Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : undefined);
  if (format !== 'json_schema' && format !== 'json_object') throw new UsageError('--response-format must be json_schema or json_object');

  let provider: StructuredOutputProvider;
  try {
    provider = createOpenAICompatibleProvider({
      baseUrl,
      model,
      apiKey: io.env.CIRA_SEMANTIC_API_KEY || undefined,
      responseFormat: format,
      ...(transport ? { transport } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }

  if (provider.locality === 'remote' && !flags.allowRemote) {
    throw new CliError(
      `refusing to send ${selectedMessages} selected message(s) to remote endpoint ${provider.endpointHost}. ` +
        'Pass --allow-remote to confirm, or use a local model (e.g. Ollama at http://127.0.0.1:11434/v1).',
    );
  }
  io.stderr(
    `semantic extraction: ${selectedMessages} selected message(s) → ${provider.endpointHost} (${provider.locality}, model ${provider.model})\n`,
  );
  return { provider, extractor: createSemanticExtractor({ provider }) };
}

/** "1,3,5-7" (1-based message numbers, as shown in the UI) → 0-based positions. */
export function parseMessageSelection(value: string): number[] {
  const out = new Set<number>();
  for (const part of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new UsageError(`invalid --messages "${value}": use numbers and ranges like 1,3,5-7`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a) throw new UsageError(`invalid --messages range "${part}" (messages are numbered from 1)`);
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  if (out.size === 0) throw new UsageError('--messages selects no messages');
  return [...out].sort((x, y) => x - y);
}
