/**
 * Claude adapter (claude.ai)
 *
 * Selectors verified against:
 *  - ryanschiang/claude-export src/util/getContents.js
 *    https://raw.githubusercontent.com/ryanschiang/claude-export/main/src/util/getContents.js
 *    Uses `div.font-claude-message` and `div.font-user-message`.
 *  - Trifall/chat-export src/modules/claude/chat-content.ts
 *    https://raw.githubusercontent.com/Trifall/chat-export/main/src/modules/claude/chat-content.ts
 *    Notes the renamed `div.font-claude-response` and the `[data-testid="user-message"]` marker.
 *
 * We match all four so the same extractor handles every Claude build seen
 * in the wild over the last year.
 */

import type { Conversation, Message, Role } from '@/core/schema';
import type { Adapter } from './types';
import { makeMeta } from './types';
import { serializeToMarkdown } from './serializer';

const USER_SELECTORS = ['div.font-user-message', '[data-testid="user-message"]'];
const ASSISTANT_SELECTORS = ['div.font-claude-response', 'div.font-claude-message'];

interface Tagged {
    el: HTMLElement;
    role: Role;
    y: number;
}

function collectTagged(): Tagged[] {
    const tagged: Tagged[] = [];
    const seen = new Set<HTMLElement>();
    const visit = (selectors: string[], role: Role) => {
        for (const sel of selectors) {
            try {
                document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
                    if (seen.has(el)) return;
                    seen.add(el);
                    tagged.push({ el, role, y: el.getBoundingClientRect().top + window.scrollY });
                });
            } catch {
                // Bad selector? Skip.
            }
        }
    };
    visit(USER_SELECTORS, 'user');
    visit(ASSISTANT_SELECTORS, 'assistant');
    return tagged
        .sort((a, b) => a.y - b.y)
        .filter((t, i, all) => !all.some((other, j) => i !== j && t.el !== other.el && t.el.contains(other.el)));
}

function readTitle(): string {
    const trigger = document.querySelector<HTMLButtonElement>('button[data-testid="chat-menu-trigger"]');
    return trigger?.textContent?.trim() || document.title;
}

async function extract(): Promise<Conversation> {
    const tagged = collectTagged();
    const messages: Message[] = [];
    for (const t of tagged) {
        const content = serializeToMarkdown(t.el);
        if (content) messages.push({ role: t.role, content });
    }
    return { ...makeMeta('claude', 'claude.ai', readTitle()), messages };
}

export const claudeAdapter: Adapter = {
    id: 'claude',
    name: 'Claude',
    hostMatchers: [/(^|\.)claude\.ai$/i],
    composerSelectors: [
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"][role="textbox"]',
    ],
    extract,
};
