/**
 * Extraction mode + semantic provider settings (pure; shared by the side
 * panel and the service worker).
 *
 * Stored in chrome.storage.local under `cira.settings`. The optional API key
 * is NOT part of these settings: it lives in chrome.storage.session (trusted
 * extension contexts only, cleared when the browser closes) and is only read
 * by the service worker. It never enters a PCO, a log line or a content script.
 */
import { endpointHost, isLoopbackUrl, type ExtractionMode } from '@cira/core';

export type { ExtractionMode };

export const EXTRACTION_MODES: readonly ExtractionMode[] = ['deterministic', 'semantic', 'hybrid'];

export type ProviderPreset = 'ollama' | 'openai-compatible';

export interface ProviderSettings {
  preset: ProviderPreset;
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1 */
  baseUrl: string;
  /** Model name; never guessed or downloaded by CIRA. */
  model: string;
}

export interface ExtractionSettings {
  extractionMode: ExtractionMode;
  provider: ProviderSettings;
}

export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
/** Kept below the 5-minute cap Chrome puts on a single service-worker task. */
export const BROWSER_SEMANTIC_TIMEOUT_MS = 120_000;
/** chrome.storage.session key for the optional API key. */
export const API_KEY_STORAGE_KEY = 'cira.semantic.apiKey';

export const DEFAULT_PROVIDER: ProviderSettings = { preset: 'ollama', baseUrl: OLLAMA_BASE_URL, model: '' };
export const DEFAULT_SETTINGS: ExtractionSettings = { extractionMode: 'deterministic', provider: DEFAULT_PROVIDER };

export const MODE_LABEL: Record<ExtractionMode, string> = {
  deterministic: 'Deterministic',
  semantic: 'Semantic',
  hybrid: 'Hybrid',
};

export const MODE_DESCRIPTION: Record<ExtractionMode, string> = {
  deterministic: 'Fast, private, no AI model required.',
  semantic: 'Uses an AI model to identify important context.',
  hybrid: 'Combines deterministic and semantic extraction.',
};

/** Tolerant parse of whatever is stored; anything unknown falls back to the defaults. */
export function normalizeSettings(raw: unknown): ExtractionSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const p = (r.provider && typeof r.provider === 'object' ? r.provider : {}) as Record<string, unknown>;
  const mode = EXTRACTION_MODES.includes(r.extractionMode as ExtractionMode) ? (r.extractionMode as ExtractionMode) : 'deterministic';
  const preset: ProviderPreset = p.preset === 'openai-compatible' ? 'openai-compatible' : 'ollama';
  const baseUrl = typeof p.baseUrl === 'string' && p.baseUrl.trim() ? p.baseUrl.trim() : preset === 'ollama' ? OLLAMA_BASE_URL : '';
  const model = typeof p.model === 'string' ? p.model.trim() : '';
  return { extractionMode: mode, provider: { preset, baseUrl, model } };
}

export function isValidBaseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** What is missing before semantic extraction can run (null when ready). */
export function providerProblem(p: ProviderSettings): string | null {
  if (!isValidBaseUrl(p.baseUrl)) return 'Enter a valid http(s) endpoint URL for the semantic provider.';
  if (!isLoopbackUrl(p.baseUrl) && new URL(p.baseUrl).protocol !== 'https:') return 'Remote providers must use https://.';
  if (!p.model.trim()) return 'Enter the model name to use (CIRA never downloads or picks a model for you).';
  return null;
}

export function isLocalProvider(p: ProviderSettings): boolean {
  return isValidBaseUrl(p.baseUrl) && isLoopbackUrl(p.baseUrl);
}

export function providerHost(p: ProviderSettings): string {
  return endpointHost(p.baseUrl);
}

/**
 * Chrome match pattern for the one origin the provider lives on. Match
 * patterns ignore ports, so `http://127.0.0.1/*` covers :11434 and :1234.
 */
export function providerOriginPattern(baseUrl: string): string | null {
  if (!isValidBaseUrl(baseUrl)) return null;
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.hostname}/*`;
}

/** One-line privacy statement for the selected mode. */
export function privacyHint(mode: ExtractionMode, p: ProviderSettings): string {
  if (mode === 'deterministic') return 'Nothing is sent to an AI provider.';
  if (isLocalProvider(p)) {
    return p.preset === 'ollama' ? 'Processing locally with Ollama. Selected messages stay on this machine.' : `Processing locally at ${providerHost(p)}. Selected messages stay on this machine.`;
  }
  const host = isValidBaseUrl(p.baseUrl) ? providerHost(p) : 'the configured AI provider';
  return `Selected messages will be sent to ${host}. Unselected messages are never sent.`;
}
