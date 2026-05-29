import type { Source } from '@/core/schema';
import { SITE_PATTERNS } from './urls';

export function detectSource(url: string | undefined): Source {
  if (!url) return 'unknown';
  for (const [source, pattern] of Object.entries(SITE_PATTERNS)) {
    if (pattern.test(url)) return source as Source;
  }
  return 'unknown';
}

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

const RELAY_TARGETS: Source[] = ['claude', 'chatgpt', 'gemini', 'deepseek', 'perplexity', 'copilot', 'grok', 'kimi', 'qwen', 'poe'];

export function getAvailableTargets(current: Source): Source[] {
  return RELAY_TARGETS.filter((s) => s !== current);
}
