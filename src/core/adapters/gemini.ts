/**
 * Gemini adapter (gemini.google.com)
 *
 * Verified against maciejkos's June 2025 export gist:
 *   https://gist.githubusercontent.com/maciejkos/98afba3ff3443f2066e67f47bbe2ad0e/raw
 *
 * The Gemini SPA uses Angular custom elements:
 *   - `user-query` for each user turn (text in `div.query-text`)
 *   - `model-response` for each assistant turn
 *     (markdown body in `message-content.model-response-text
 *     div.markdown.markdown-main-panel`)
 * The chat scroller is `#chat-history > infinite-scroller`. We don't
 * auto-scroll: the side panel renders the visible turns and Gemini already
 * keeps the full history mounted once the user has scrolled through it.
 */

import type { Conversation, Message, Role } from '@/core/schema';
import type { Adapter } from './types';
import { makeMeta } from './types';
import { serializeToMarkdown } from './serializer';

interface Tagged {
    el: HTMLElement;
    role: Role;
    y: number;
}

function collectTurns(): Tagged[] {
    const userEls = Array.from(document.querySelectorAll<HTMLElement>('user-query'));
    const modelEls = Array.from(document.querySelectorAll<HTMLElement>('model-response'));
    const tagged: Tagged[] = [
        ...userEls.map((el): Tagged => ({ el, role: 'user', y: el.getBoundingClientRect().top + window.scrollY })),
        ...modelEls.map((el): Tagged => ({ el, role: 'assistant', y: el.getBoundingClientRect().top + window.scrollY })),
    ];
    return tagged.sort((a, b) => a.y - b.y);
}

function readUserContent(turn: HTMLElement): string {
    const text = turn.querySelector<HTMLElement>('div.query-text');
    return serializeToMarkdown(text ?? turn, { keepImages: true });
}

function readAssistantContent(turn: HTMLElement): string {
    const markdown = turn.querySelector<HTMLElement>('message-content.model-response-text div.markdown, message-content div.markdown.markdown-main-panel, div.markdown.markdown-main-panel');
    return serializeToMarkdown(markdown ?? turn);
}

function readTitle(): string {
    const heading = document.querySelector<HTMLElement>('header h1, [data-test-id="conversation-title"]');
    return heading?.textContent?.trim() || document.title;
}

async function extract(): Promise<Conversation> {
    const tagged = collectTurns();
    const messages: Message[] = [];
    for (const t of tagged) {
        const content = t.role === 'user' ? readUserContent(t.el) : readAssistantContent(t.el);
        if (content) messages.push({ role: t.role, content });
    }
    return { ...makeMeta('gemini', 'gemini.google.com', readTitle()), messages };
}

export const geminiAdapter: Adapter = {
    id: 'gemini',
    name: 'Gemini',
    hostMatchers: [/(^|\.)gemini\.google\.com$/i],
    composerSelectors: [
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        'textarea[aria-label*="prompt" i]',
    ],
    extract,
};
