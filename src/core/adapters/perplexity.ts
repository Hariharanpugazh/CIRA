/**
 * Perplexity adapter (perplexity.ai / www.perplexity.ai)
 *
 * Verified against the maintained Greasy Fork exporter (script 518844):
 *   https://greasyfork.org/scripts/518844/code.user.js
 *
 * Key markers in the live DOM:
 *   - Thread root:        `.max-w-threadContentWidth, [class*="threadContentWidth"]`
 *   - User-turn marker:   contains `button[data-testid='copy-query-button']`
 *                         or `span[data-lexical-text='true']`
 *   - User text body:     `.whitespace-pre-line.text-pretty.break-words`
 *   - Assistant marker:   contains `.prose.text-pretty.dark:prose-invert`
 *                         or `[data-testid='answer']`
 */

import type { Conversation, Message, Role } from '@/core/schema';
import type { Adapter } from './types';
import { makeMeta } from './types';
import { serializeToMarkdown } from './serializer';

const ASSISTANT_BODY = ".prose.text-pretty.dark\\:prose-invert, [class*='prose'][class*='prose-invert'], [data-testid='answer']";
const USER_TEXT = ".whitespace-pre-line.text-pretty.break-words";
const USER_MARKER = "button[data-testid='copy-query-button'], span[data-lexical-text='true']";

interface Tagged {
    el: HTMLElement;
    role: Role;
    y: number;
}

function findRoot(): Element {
    return (
        document.querySelector('.max-w-threadContentWidth') ??
        document.querySelector('[class*="threadContentWidth"]') ??
        document.querySelector('main') ??
        document.body
    );
}

function collectTurns(): Tagged[] {
    const root = findRoot();
    const tagged: Tagged[] = [];
    const seen = new Set<HTMLElement>();
    const tag = (el: HTMLElement, role: Role) => {
        if (seen.has(el)) return;
        seen.add(el);
        tagged.push({ el, role, y: el.getBoundingClientRect().top + window.scrollY });
    };

    root.querySelectorAll<HTMLElement>(USER_TEXT).forEach((el) => {
        if (el.closest(USER_MARKER) || el.querySelector(USER_MARKER)) tag(el, 'user');
        else tag(el, 'user');
    });
    root.querySelectorAll<HTMLElement>(ASSISTANT_BODY).forEach((el) => tag(el, 'assistant'));

    return tagged.sort((a, b) => a.y - b.y);
}

async function extract(): Promise<Conversation> {
    const tagged = collectTurns();
    const messages: Message[] = [];
    for (const t of tagged) {
        const content = serializeToMarkdown(t.el);
        if (content) messages.push({ role: t.role, content });
    }
    return { ...makeMeta('perplexity', 'perplexity.ai', document.title), messages };
}

export const perplexityAdapter: Adapter = {
    id: 'perplexity',
    name: 'Perplexity',
    hostMatchers: [/(^|\.)perplexity\.ai$/i],
    composerSelectors: [
        'textarea[placeholder*="Ask" i]',
        'textarea[aria-label*="query" i]',
        'div[contenteditable="true"][role="textbox"]',
    ],
    extract,
};
