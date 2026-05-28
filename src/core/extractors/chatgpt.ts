/**
 * ChatGPT DOM -> Conversation extractor.
 *
 * Targets the public ChatGPT web UI at chat.openai.com / chatgpt.com.
 * Uses resilient selectors with fallbacks because the DOM changes often.
 */
import { cleanText } from '@/shared/dom';
import type { Conversation, Message, Role } from '@/core/schema';

/**
 * Heuristic: ChatGPT marks each turn with `data-message-author-role="user|assistant"`.
 */
function readRole(el: Element): Role {
  const role = el.getAttribute('data-message-author-role');
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  return 'assistant';
}

/**
 * Convert a turn's HTML into markdown-ish plain text.
 * Code blocks are preserved as fenced markdown.
 */
function readContent(el: Element): string {
  const parts: string[] = [];
  el.querySelectorAll('pre').forEach((pre) => {
    pre.setAttribute('data-cira-code', 'yes');
  });

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const e = node as Element;
    if (e.tagName === 'PRE') {
      const codeEl = e.querySelector('code');
      const lang =
        codeEl?.className.match(/language-([\w+-]+)/)?.[1] ??
        e.getAttribute('data-language') ??
        '';
      const code = codeEl?.textContent ?? e.textContent ?? '';
      parts.push(`\n\n\`\`\`${lang}\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`);
      return;
    }
    if (e.tagName === 'BR') {
      parts.push('\n');
      return;
    }
    e.childNodes.forEach(walk);
    if (/^(P|DIV|LI|H[1-6])$/.test(e.tagName)) parts.push('\n');
  };

  walk(el);
  return cleanText(parts.join(''));
}

export function extractChatGPT(): Conversation {
  // Primary selector: ChatGPT tags every turn with data-message-author-role.
  const turnNodes = Array.from(
    document.querySelectorAll<HTMLElement>('[data-message-author-role]'),
  );

  const messages: Message[] = turnNodes
    .map((node) => ({
      role: readRole(node),
      content: readContent(node),
    }))
    .filter((m) => m.content.length > 0);

  const firstUser = messages.find((m) => m.role === 'user');
  const title =
    document.title.replace(/\s*[-|·]\s*ChatGPT.*$/i, '').trim() ||
    firstUser?.content.slice(0, 80) ||
    'ChatGPT conversation';

  return {
    source: 'chatgpt',
    title,
    url: location.href,
    capturedAt: new Date().toISOString(),
    messages,
  };
}
