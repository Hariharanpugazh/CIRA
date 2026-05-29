/**
 * DeepSeek adapter (chat.deepseek.com)
 *
 * Verified against AstridStark25963/deepseek-chat-exporter (Greasy Fork 566716):
 *   https://greasyfork.org/scripts/566716/code.user.js
 *
 *   - Each message wrapper: `.ds-message`
 *   - Assistant content:    `.ds-markdown` (presence makes the message
 *                            assistant; absence means user)
 *   - Reasoning extras:     `.ds-think-content` (chain-of-thought)
 *   - Code blocks:          `.md-code-block` with a banner button to strip
 */

import type { Conversation, Message, Role } from '@/core/schema';
import type { Adapter } from './types';
import { makeMeta } from './types';
import { serializeToMarkdown } from './serializer';

const NOISE_SELECTORS = [
    '.ds-icon-button',
    '.ds-atom-button',
    '.ds-icon',
    '.md-code-block-banner-wrap',
];

async function extract(): Promise<Conversation> {
    const wrappers = Array.from(document.querySelectorAll<HTMLElement>('.ds-message'));
    const messages: Message[] = [];

    for (const wrapper of wrappers) {
        const assistantContent = wrapper.querySelector<HTMLElement>('.ds-markdown:not(.ds-think-content .ds-markdown)');
        let role: Role;
        let target: HTMLElement;
        if (assistantContent) {
            role = 'assistant';
            target = assistantContent;
        } else {
            role = 'user';
            target = wrapper;
        }
        const content = serializeToMarkdown(target, { extraNoiseSelectors: NOISE_SELECTORS });
        if (!content) continue;

        if (role === 'assistant') {
            const think = wrapper.querySelector<HTMLElement>('.ds-think-content .ds-markdown');
            const thinkText = think ? serializeToMarkdown(think, { extraNoiseSelectors: NOISE_SELECTORS }) : '';
            messages.push({
                role,
                content: thinkText ? `${content}\n\n<details><summary>Reasoning</summary>\n\n${thinkText}\n\n</details>` : content,
            });
        } else {
            messages.push({ role, content });
        }
    }

    return { ...makeMeta('deepseek', 'chat.deepseek.com', document.title), messages };
}

export const deepseekAdapter: Adapter = {
    id: 'deepseek',
    name: 'DeepSeek',
    hostMatchers: [/(^|\.)chat\.deepseek\.com$/i],
    composerSelectors: ['textarea#chat-input', 'textarea[placeholder*="Send" i]', 'textarea'],
    extract,
};
