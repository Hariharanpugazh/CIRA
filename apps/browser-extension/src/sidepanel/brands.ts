/** Display names / fallback avatar colors for platforms (moved out of SidePanel.tsx). */
import { getAllPlatforms } from '@/platform/registry';

export interface PlatformBrand {
  name: string;
  initial: string;
  color: string;
}

export const PLATFORM_BRAND: Record<string, PlatformBrand> = {
  chatgpt: { name: 'ChatGPT', initial: 'G', color: '#10a37f' },
  claude: { name: 'Claude', initial: 'C', color: '#d97757' },
  gemini: { name: 'Gemini', initial: 'G', color: '#4285f4' },
  deepseek: { name: 'DeepSeek', initial: 'D', color: '#4d6bfe' },
  perplexity: { name: 'Perplexity', initial: 'P', color: '#20808d' },
  copilot: { name: 'Copilot', initial: 'M', color: '#0a6cff' },
  grok: { name: 'Grok', initial: 'X', color: '#1d9bf0' },
  mistral: { name: 'Mistral', initial: 'M', color: '#fa520f' },
  qwen: { name: 'Qwen', initial: 'Q', color: '#615ced' },
  poe: { name: 'Poe', initial: 'P', color: '#5d3fd3' },
  kimi: { name: 'Kimi', initial: 'K', color: '#6c5ce7' },
  huggingchat: { name: 'HuggingChat', initial: 'H', color: '#ff9d00' },
  notebooklm: { name: 'NotebookLM', initial: 'N', color: '#1a73e8' },
  you: { name: 'You.com', initial: 'Y', color: '#7c3aed' },
  characterai: { name: 'Character.AI', initial: 'A', color: '#5b6ee1' },
  pi: { name: 'Pi', initial: '\u03C0', color: '#a78bfa' },
  zai: { name: 'Z.ai', initial: 'Z', color: '#2d9cdb' },
  unknown: { name: 'this chat', initial: '?', color: '#7d7d7d' },
};

export function brandFor(source: string): PlatformBrand {
  return PLATFORM_BRAND[source] ?? PLATFORM_BRAND.unknown;
}

/** Same target list the side panel always offered: every known platform except the current one. */
export function relayTargets(current: string): string[] {
  return getAllPlatforms()
    .map((p) => p.id)
    .filter((id) => id !== current && id in PLATFORM_BRAND && id !== 'unknown');
}
