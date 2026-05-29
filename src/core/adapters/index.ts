import type { Adapter } from './types';
import { chatgptAdapter } from './chatgpt';
import { claudeAdapter } from './claude';
import { geminiAdapter } from './gemini';
import { deepseekAdapter } from './deepseek';
import { perplexityAdapter } from './perplexity';
import { makeGenericAdapter } from './generic';

const VERIFIED: Adapter[] = [
    chatgptAdapter,
    claudeAdapter,
    geminiAdapter,
    deepseekAdapter,
    perplexityAdapter,
];

const GENERIC: Adapter[] = [
    makeGenericAdapter({
        id: 'copilot', name: 'Copilot',
        hostMatchers: [/(^|\.)copilot\.microsoft\.com$/i],
    }),
    makeGenericAdapter({
        id: 'grok', name: 'Grok',
        hostMatchers: [/(^|\.)grok\.com$/i, /(^|\.)x\.com$/i],
    }),
    makeGenericAdapter({
        id: 'mistral', name: 'Mistral',
        hostMatchers: [/(^|\.)chat\.mistral\.ai$/i],
    }),
    makeGenericAdapter({
        id: 'qwen', name: 'Qwen',
        hostMatchers: [/(^|\.)chat\.qwen\.ai$/i, /(^|\.)tongyi\.aliyun\.com$/i],
    }),
    makeGenericAdapter({
        id: 'kimi', name: 'Kimi',
        hostMatchers: [/(^|\.)kimi\.moonshot\.cn$/i],
    }),
    makeGenericAdapter({
        id: 'poe', name: 'Poe',
        hostMatchers: [/(^|\.)poe\.com$/i],
    }),
    makeGenericAdapter({
        id: 'huggingchat', name: 'HuggingChat',
        hostMatchers: [/(^|\.)huggingface\.co$/i],
    }),
    makeGenericAdapter({
        id: 'notebooklm', name: 'NotebookLM',
        hostMatchers: [/(^|\.)notebooklm\.google\.com$/i],
    }),
    makeGenericAdapter({
        id: 'you', name: 'You.com',
        hostMatchers: [/(^|\.)you\.com$/i],
    }),
    makeGenericAdapter({
        id: 'characterai', name: 'Character.AI',
        hostMatchers: [/(^|\.)character\.ai$/i],
    }),
    makeGenericAdapter({
        id: 'pi', name: 'Pi',
        hostMatchers: [/(^|\.)pi\.ai$/i],
    }),
    makeGenericAdapter({
        id: 'zai', name: 'Z.ai',
        hostMatchers: [/(^|\.)z\.ai$/i],
    }),
];

const ADAPTERS = [...VERIFIED, ...GENERIC];

export function pickAdapter(host: string = location.hostname): Adapter | null {
    for (const adapter of ADAPTERS) {
        if (adapter.hostMatchers.some((re) => re.test(host))) return adapter;
    }
    return null;
}

export { ADAPTERS };
