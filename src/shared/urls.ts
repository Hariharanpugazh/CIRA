import type { Source } from '@/core/schema';

export const TARGET_URLS: Record<string, string> = {
  chatgpt: 'https://chatgpt.com/',
  claude: 'https://claude.ai/new',
  gemini: 'https://gemini.google.com/',
  deepseek: 'https://chat.deepseek.com/',
  perplexity: 'https://perplexity.ai/',
  copilot: 'https://copilot.microsoft.com/',
  grok: 'https://grok.com/',
  kimi: 'https://kimi.moonshot.cn/',
  qwen: 'https://chat.qwen.ai/',
  poe: 'https://poe.com/',
  huggingchat: 'https://huggingface.co/chat/',
  notebooklm: 'https://notebooklm.google.com/',
  you: 'https://you.com/',
  characterai: 'https://character.ai/',
  pi: 'https://pi.ai/',
  zai: 'https://z.ai/',
  mistral: 'https://chat.mistral.ai/',
};

export const SITE_PATTERNS: Record<string, RegExp> = {
  chatgpt: /chat\.openai\.com|chatgpt\.com/,
  claude: /claude\.ai/,
  gemini: /gemini\.google\.com/,
  deepseek: /chat\.deepseek\.com/,
  perplexity: /perplexity\.ai/,
  copilot: /copilot\.microsoft\.com/,
  grok: /grok\.com|x\.com\/i\/grok/,
  kimi: /kimi\.moonshot\.cn/,
  qwen: /tongyi\.aliyun\.com|chat\.qwen\.ai/,
  poe: /poe\.com/,
  huggingchat: /huggingface\.co\/chat/,
  notebooklm: /notebooklm\.google\.com/,
  you: /you\.com/,
  characterai: /character\.ai/,
  pi: /pi\.ai/,
  zai: /z\.ai/,
  mistral: /chat\.mistral\.ai/,
};

export const RELAY_TARGETS: Source[] = ['claude', 'chatgpt', 'gemini', 'deepseek', 'perplexity', 'copilot', 'grok', 'kimi', 'qwen', 'poe'];

export const TARGET_LABELS: Record<string, string> = {
  claude: 'Relay to Claude', chatgpt: 'Relay to ChatGPT',
  gemini: 'Relay to Gemini', deepseek: 'Relay to DeepSeek',
  perplexity: 'Relay to Perplexity', copilot: 'Relay to Copilot',
  grok: 'Relay to Grok', kimi: 'Relay to Kimi',
  qwen: 'Relay to Qwen', poe: 'Relay to Poe',
};

export const PLATFORM_BADGE: Record<string, string> = {
  chatgpt: 'C', claude: 'A', gemini: 'G', deepseek: 'D',
  perplexity: 'P', copilot: 'M', grok: 'X', kimi: 'K',
  qwen: 'Q', poe: 'E', huggingchat: 'H', notebooklm: 'N',
  you: 'Y', characterai: 'A', pi: '\u03C0', zai: 'Z', mistral: 'M',
  unknown: '?',
};
