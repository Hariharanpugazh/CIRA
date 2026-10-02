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

export type ProviderPreset = 
  | 'ollama' 
  | 'openai' 
  | 'anthropic' 
  | 'google' 
  | 'xai' 
  | 'groq' 
  | 'openrouter' 
  | 'lm-studio'
  | 'custom';

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
export const LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1';

export interface ProviderPresetInfo {
  label: string;
  baseUrl: string;
  requiresApiKey: boolean;
  modelPlaceholder: string;
  modelSuggestions?: string[];
  helpText?: string;
}

export const PROVIDER_PRESETS: Record<ProviderPreset, ProviderPresetInfo> = {
  ollama: {
    label: 'Ollama (local)',
    baseUrl: OLLAMA_BASE_URL,
    requiresApiKey: false,
    modelPlaceholder: 'e.g. qwen2.5:7b',
    modelSuggestions: ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.3:70b', 'mistral:7b', 'phi4:14b'],
    helpText: 'Run models locally. Requires OLLAMA_ORIGINS=chrome-extension://* to allow browser access.',
  },
  'lm-studio': {
    label: 'LM Studio (local)',
    baseUrl: LM_STUDIO_BASE_URL,
    requiresApiKey: false,
    modelPlaceholder: 'e.g. TheBloke/Llama-2-7B-Chat-GGUF',
    helpText: 'Local models via LM Studio. The model name comes from what you loaded in LM Studio.',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    modelPlaceholder: 'e.g. gpt-4o-mini',
    modelSuggestions: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    helpText: 'OpenAI models. API key required.',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    requiresApiKey: true,
    modelPlaceholder: 'e.g. claude-3-5-sonnet-20241022',
    modelSuggestions: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
    helpText: 'Anthropic Claude models via their direct API.',
  },
  google: {
    label: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    requiresApiKey: true,
    modelPlaceholder: 'e.g. gemini-2.5-flash',
    modelSuggestions: ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
    helpText: 'Google Gemini models via OpenAI-compatible endpoint. Note: gemini-1.5-* and 2.0-* models are retired and return 404; use a 2.5+ model.',
  },
  xai: {
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    requiresApiKey: true,
    modelPlaceholder: 'e.g. grok-2-latest',
    modelSuggestions: ['grok-2-latest', 'grok-2-1212', 'grok-beta'],
    helpText: 'xAI Grok models. API key required.',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresApiKey: true,
    modelPlaceholder: 'e.g. llama-3.3-70b-versatile',
    modelSuggestions: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    helpText: 'Fast inference on Groq LPUs. API key required.',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    modelPlaceholder: 'e.g. anthropic/claude-3.5-sonnet',
    modelSuggestions: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'google/gemini-2.5-flash'],
    helpText: 'Unified access to 200+ models. API key required.',
  },
  custom: {
    label: 'Custom OpenAI-compatible',
    baseUrl: '',
    requiresApiKey: false,
    modelPlaceholder: 'model name',
    helpText: 'Any OpenAI-compatible Chat Completions endpoint (vLLM, llama.cpp server, etc.).',
  },
};

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
  
  const presetKey = p.preset as string;
  const preset: ProviderPreset = presetKey && presetKey in PROVIDER_PRESETS ? (presetKey as ProviderPreset) : 'ollama';
  const presetInfo = PROVIDER_PRESETS[preset];
  
  const baseUrl = typeof p.baseUrl === 'string' && p.baseUrl.trim() ? p.baseUrl.trim() : presetInfo.baseUrl;
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
    return `Processing locally at ${providerHost(p)}. Selected messages stay on this machine.`;
  }
  const host = isValidBaseUrl(p.baseUrl) ? providerHost(p) : 'the configured AI provider';
  return `Selected messages will be sent to ${host}. Unselected messages are never sent.`;
}

// ── Ollama setup guidance ───────────────────────────────────────────────────

export type OllamaOS = 'windows' | 'mac' | 'linux';

/** The origin browser extensions need Ollama to allow. */
export const OLLAMA_EXTENSION_ORIGIN = 'chrome-extension://*';

/** Best-effort OS detection from a user-agent string (defaults to windows). */
export function detectOS(userAgent: string): OllamaOS {
  const ua = userAgent.toLowerCase();
  if (ua.includes('mac') || ua.includes('darwin')) return 'mac';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('linux') || ua.includes('x11')) return 'linux';
  return 'windows';
}

export interface OllamaSetupStep {
  os: OllamaOS;
  osLabel: string;
  /** The one command the user copies and runs. */
  command: string;
  /** How to make Ollama pick it up afterwards. */
  restartHint: string;
}

/**
 * The exact, copy-pasteable command to allow browser extensions to reach
 * Ollama on each OS, plus the restart note. This is the whole fix for the
 * HTTP 403 Ollama returns to extensions by default.
 */
export function ollamaSetupStep(os: OllamaOS): OllamaSetupStep {
  switch (os) {
    case 'mac':
      return {
        os,
        osLabel: 'macOS',
        command: `launchctl setenv OLLAMA_ORIGINS "${OLLAMA_EXTENSION_ORIGIN}"`,
        restartHint: 'Then quit Ollama from the menu bar and reopen it.',
      };
    case 'linux':
      return {
        os,
        osLabel: 'Linux',
        command: `systemctl edit ollama   # add:  Environment="OLLAMA_ORIGINS=${OLLAMA_EXTENSION_ORIGIN}"`,
        restartHint: 'Then run: sudo systemctl restart ollama',
      };
    case 'windows':
    default:
      return {
        os: 'windows',
        osLabel: 'Windows',
        command: `setx OLLAMA_ORIGINS "${OLLAMA_EXTENSION_ORIGIN}"`,
        restartHint: 'Then fully quit Ollama from the system tray (right-click → Quit) and reopen it.',
      };
  }
}

/** True when a semantic failure is Ollama's CORS/origin rejection for a local provider. */
export function isOllamaCorsError(code: string, p: ProviderSettings): boolean {
  return code === 'forbidden' && isLocalProvider(p);
}
