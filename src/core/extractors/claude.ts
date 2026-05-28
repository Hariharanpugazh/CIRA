/**
 * Claude (claude.ai) DOM -> Conversation extractor.
 *
 * Claude's UI doesn't expose a single canonical role attribute, so we look for
 * the human/assistant turn containers and infer roles from class names.
 */
import { cleanText } from '@/shared/dom';
import type { Conversation, Message, Role } from '@/core/schema';

/**
 * Best-effort role inference. Claude uses `data-testid="user-message"` for the
 * user turn and assistant turns are rendered inside a different container.
 */
function inferRole(el: Element): Role {
  if (el.getAttribute('data-testid') === 'user-message') return 'user';
  if (el.closest('[data-testid="user-message"]')) return 'user';
  // Assistant turns commonly carry a `font-claude-message` class.
  if (el.classList.contains('font-claude-message')) return 'assistant';
  if (el.querySelector('.font-claude-message')) return 'assistant';
  return 'assistant';
}

function readContent(el: Element): string {
  const parts: string[] = [];

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node as Element;
    if (e.tagName === 'PRE') {
      const codeEl = e.querySelector('code');
      const lang = codeEl?.className.match(/language-([\w+-]+)/)?.[1] ?? '';
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

export function extractClaude(): Conversation {
  // Collect user + assistant turns. Selectors are intentionally broad.
  const userTurns = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="user-message"]'),
  );
  const assistantTurns = Array.from(
    document.querySelectorAll<HTMLElement>('.font-claude-message'),
  );

  // Merge in document order.
  const all = [...userTurns, ...assistantTurns].sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  const messages: Message[] = all
    .map((node) => ({ role: inferRole(node), content: readContent(node) }))
    .filter((m) => m.content.length > 0);

  const firstUser = messages.find((m) => m.role === 'user');
  const title =
    document.title.replace(/\s*[-|·]\s*Claude.*$/i, '').trim() ||
    firstUser?.content.slice(0, 80) ||
    'Claude conversation';

  return {
    source: 'claude',
    title,
    url: location.href,
    capturedAt: new Date().toISOString(),
    messages,
  };
}
