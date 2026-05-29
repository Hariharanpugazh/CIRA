/**
 * Generic adapter — used when the active site is matched by manifest hosts
 * but doesn't have a verified per-platform adapter yet (Copilot, Grok,
 * Mistral, Qwen, Poe, Kimi, HuggingChat, etc.).
 *
 * Scans for any of the role markers used by mainstream LLM web apps. When the
 * page yields no recognisable turns, the side panel surfaces a real failure
 * message instead of silently looking empty.
 */

import type { Conversation, Message, Role, Source } from '@/core/schema';
import type { Adapter } from './types';
import { makeMeta } from './types';
import { serializeToMarkdown } from './serializer';

const USER_SELECTORS = [
    '[data-message-author-role="user"]',
    '[data-role="user"]',
    '[data-testid*="user-message" i]',
    '[class*="user-message" i]',
    '[class*="user-bubble" i]',
];

const ASSISTANT_SELECTORS = [
    '[data-message-author-role="assistant"]',
    '[data-role="model"]',
    '[data-role="assistant"]',
    '[data-testid*="assistant" i]',
    '[data-testid*="model" i]',
    '[class*="assistant-message" i]',
    '[class*="model-response" i]',
    '[class*="bot-message" i]',
];

interface Tagged { el: HTMLElement; role: Role; y: number }

function collect(selectors: string[], role: Role, into: Tagged[], seen: Set<HTMLElement>): void {
    for (const sel of selectors) {
        try {
            document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
                if (seen.has(el)) return;
                seen.add(el);
                into.push({ el, role, y: el.getBoundingClientRect().top + window.scrollY });
            });
        } catch {
            // skip invalid selectors
        }
    }
}

function makeGenericExtract(source: Source) {
    return async (): Promise<Conversation> => {
        const tagged: Tagged[] = [];
        const seen = new Set<HTMLElement>();
        collect(USER_SELECTORS, 'user', tagged, seen);
        collect(ASSISTANT_SELECTORS, 'assistant', tagged, seen);

        const filtered = tagged
            .sort((a, b) => a.y - b.y)
            .filter((t, i, all) => !all.some((other, j) => i !== j && t.el !== other.el && t.el.contains(other.el)));

        const messages: Message[] = [];
        for (const t of filtered) {
            const content = serializeToMarkdown(t.el);
            if (content) messages.push({ role: t.role, content });
        }
        return { ...makeMeta(source, location.hostname, document.title), messages };
    };
}

export function makeGenericAdapter(opts: {
    id: Source;
    name: string;
    hostMatchers: RegExp[];
    composerSelectors?: string[];
}): Adapter {
    return {
        id: opts.id,
        name: opts.name,
        hostMatchers: opts.hostMatchers,
        composerSelectors: opts.composerSelectors ?? [
            'textarea[placeholder*="message" i]',
            'textarea[placeholder*="Ask" i]',
            'div[contenteditable="true"]',
            'textarea',
        ],
        extract: makeGenericExtract(opts.id),
    };
}
