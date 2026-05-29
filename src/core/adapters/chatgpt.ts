/**
 * ChatGPT adapter (chatgpt.com / chat.openai.com)
 *
 * Strategy: try the internal `/backend-api/conversation/{id}` first (the same
 * endpoint the page uses, gated by the same session cookie). When that is
 * unavailable — share pages, conversation id missing, fetch blocked — fall
 * back to the DOM walk.
 *
 * Selectors and endpoints verified against:
 *  - pionxzh/chatgpt-exporter src/api.ts
 *    https://raw.githubusercontent.com/pionxzh/chatgpt-exporter/master/src/api.ts
 *  - Trifall/chat-export src/modules/chatgpt/chat-content.ts
 *    https://raw.githubusercontent.com/Trifall/chat-export/main/src/modules/chatgpt/chat-content.ts
 */

import type { Conversation, Message, Role } from '@/core/schema';
import type { Adapter } from './types';
import { makeMeta } from './types';
import { serializeToMarkdown } from './serializer';

const TURN_RENDER_DELAY_MS = 220;
const NOISE_SELECTORS = [
    'span[data-state] > span > a[target="_blank"][rel="noopener"]',
    '[class*="text-token-text-tertiary"]',
];

interface SessionResponse {
    accessToken?: string;
}

interface ConversationNode {
    message?: ConversationNodeMessage;
    parent?: string;
    children: string[];
}

interface ConversationNodeMessage {
    author: { role: 'user' | 'assistant' | 'system' | 'tool' };
    content?: ContentBlock;
}

type ContentBlock =
    | { content_type: 'text'; parts: Array<string | unknown> }
    | { content_type: 'multimodal_text'; parts: Array<string | unknown> }
    | { content_type: 'code'; text: string; language?: string }
    | { content_type: string;[key: string]: unknown };

interface ConversationApiResponse {
    title?: string;
    current_node?: string;
    mapping?: Record<string, ConversationNode>;
}

function conversationIdFromUrl(href: string): string | null {
    const match = href.match(/\/(?:c|share)\/([0-9a-fA-F-]{8,})/);
    return match ? match[1] : null;
}

async function getAccessToken(): Promise<string | null> {
    try {
        const res = await fetch(`${location.origin}/api/auth/session`, { credentials: 'include' });
        if (!res.ok) return null;
        const json = (await res.json()) as SessionResponse;
        return json.accessToken ?? null;
    } catch {
        return null;
    }
}

async function fetchConversationApi(): Promise<ConversationApiResponse | null> {
    const id = conversationIdFromUrl(location.href);
    if (!id) return null;
    const token = await getAccessToken();
    if (!token) return null;
    try {
        const res = await fetch(`${location.origin}/backend-api/conversation/${id}`, {
            credentials: 'include',
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        return (await res.json()) as ConversationApiResponse;
    } catch {
        return null;
    }
}

function flattenApiTree(api: ConversationApiResponse): Message[] {
    if (!api.mapping || !api.current_node) return [];
    const path: ConversationNodeMessage[] = [];
    let cursor: string | undefined = api.current_node;
    while (cursor) {
        const node: ConversationNode | undefined = api.mapping[cursor];
        if (!node) break;
        if (node.message) path.unshift(node.message);
        cursor = node.parent;
    }
    return path
        .filter((m) => m.author.role === 'user' || m.author.role === 'assistant')
        .map(messageFromApi)
        .filter((m): m is Message => !!m && m.content.length > 0);
}

function messageFromApi(node: ConversationNodeMessage): Message | null {
    const block = node.content;
    if (!block) return null;
    let content = '';
    if (block.content_type === 'text' || block.content_type === 'multimodal_text') {
        const parts = (block as { parts: Array<string | unknown> }).parts ?? [];
        content = parts
            .map((p) => (typeof p === 'string' ? p : ''))
            .filter(Boolean)
            .join('\n\n')
            .trim();
    } else if (block.content_type === 'code') {
        const code = (block as { text: string; language?: string });
        content = `\`\`\`${code.language ?? ''}\n${code.text}\n\`\`\``;
    }
    if (!content) return null;
    const role: Role = node.author.role === 'user' ? 'user' : node.author.role === 'system' ? 'system' : 'assistant';
    return { role, content };
}

async function rest(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

async function extractFromDom(): Promise<Message[]> {
    const turns = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="conversation-turn-"]'));
    const messages: Message[] = [];

    for (const turn of turns) {
        const messageEl = turn.querySelector<HTMLElement>('[data-message-author-role]');
        if (!messageEl) continue;
        const role = messageEl.getAttribute('data-message-author-role');
        if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;

        // ChatGPT virtualizes the list, so off-screen turns return empty content.
        try {
            turn.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: role === 'assistant' ? 'end' : 'start' });
        } catch {
            turn.scrollIntoView();
        }
        await rest(TURN_RENDER_DELAY_MS);

        const contentEl = messageEl.querySelector<HTMLElement>('.markdown, .whitespace-pre-wrap') ?? messageEl;
        const content = serializeToMarkdown(contentEl, { extraNoiseSelectors: NOISE_SELECTORS });
        if (content) messages.push({ role: role as Role, content });
    }

    return messages;
}

function readTitle(): string {
    const heading = document.querySelector('h1')?.textContent?.trim();
    return heading || document.title;
}

async function extract(): Promise<Conversation> {
    const apiData = await fetchConversationApi();
    let messages: Message[] = [];
    let title = '';

    if (apiData) {
        messages = flattenApiTree(apiData);
        title = apiData.title ?? '';
    }

    if (messages.length === 0) {
        messages = await extractFromDom();
    }
    if (!title) title = readTitle();

    return { ...makeMeta('chatgpt', 'chatgpt.com', title), messages };
}

export const chatgptAdapter: Adapter = {
    id: 'chatgpt',
    name: 'ChatGPT',
    hostMatchers: [/(^|\.)chatgpt\.com$/i, /(^|\.)chat\.openai\.com$/i],
    composerSelectors: ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror', 'textarea[data-id="root"]'],
    extract,
};
