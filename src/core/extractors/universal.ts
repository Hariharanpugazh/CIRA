import { cleanText } from '@/shared/dom';
import type { Conversation, MediaAttachment, Message, Role } from '@/core/schema';
import { getPlatformDefForUrl, getPlatformId, type PlatformDef } from '@/core/platforms/registry';
import { pickAdapter } from '@/core/adapters';

function trySelectors(selectors: string[]): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  for (const sel of selectors) {
    try {
      const els = document.querySelectorAll<HTMLElement>(sel);
      for (const el of els) {
        if (!seen.has(el)) seen.add(el);
      }
    } catch {
      continue;
    }
  }
  return Array.from(seen);
}

function readRole(el: Element): Role {
  const role = el.getAttribute('data-message-author-role')
    ?? el.getAttribute('data-role')
    ?? el.getAttribute('data-testid');
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  if (role === 'user-message') return 'user';
  if (role === 'model') return 'assistant';
  return 'assistant';
}

function readContent(el: Element): string {
  const parts: string[] = [];
  el.querySelectorAll('pre').forEach((pre) => {
    pre.setAttribute('data-cira-preserve', '1');
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
    if (e.tagName === 'IMG') {
      const alt = e.getAttribute('alt') || '';
      if (alt) parts.push(`[Image: ${alt}]`);
      return;
    }
    e.childNodes.forEach(walk);
    if (/^(P|DIV|LI|H[1-6])$/.test(e.tagName)) parts.push('\n');
  };

  walk(el);
  return cleanText(parts.join(''));
}

function inferRoleFromDef(def: PlatformDef, el: Element): Role {
  for (const sel of def.extractors.userMessages) {
    try {
      if (el.matches(sel) || el.querySelector(sel)) return 'user';
    } catch {
      continue;
    }
  }
  for (const sel of def.extractors.assistantMessages) {
    try {
      if (el.matches(sel) || el.querySelector(sel)) return 'assistant';
    } catch {
      continue;
    }
  }
  return readRole(el);
}

function mergeMessages(userEls: HTMLElement[], assistantEls: HTMLElement[], def: PlatformDef): Message[] {
  const all = [...userEls, ...assistantEls].sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  return all
    .map((node) => ({
      role: inferRoleFromDef(def, node) === 'user' ? 'user' as Role : 'assistant' as Role,
      content: readContent(node),
    }))
    .filter((m) => m.content.length > 0);
}

function extractTitle(def: PlatformDef): string {
  for (const sel of def.extractors.title) {
    try {
      if (sel === 'title') return document.title;
    } catch {
      continue;
    }
  }
  return document.title || 'Untitled';
}

/**
 * Legacy fallback used when no adapter matches the active host. Same logic
 * the project shipped with — broad selectors per platform definition.
 */
function extractWithLegacy(): Conversation {
  const def = getPlatformDefForUrl(location.href);
  const source = getPlatformId();

  const userEls = trySelectors(def.extractors.userMessages);
  const assistantEls = trySelectors(def.extractors.assistantMessages);

  const messages = mergeMessages(userEls, assistantEls, def);
  const title = extractTitle(def).replace(/\s*[-|·]\s*.+$/i, '').trim()
    || messages.find((m) => m.role === 'user')?.content.slice(0, 80)
    || 'Conversation';

  return {
    source,
    title,
    url: location.href,
    capturedAt: new Date().toISOString(),
    messages,
  };
}

/**
 * Public extractor. When the active host has a verified adapter we delegate
 * to it; otherwise we fall back to the original broad-selector extraction.
 */
export async function extractConversation(): Promise<Conversation> {
  const adapter = pickAdapter(location.hostname);
  if (adapter) {
    try {
      const result = await adapter.extract();
      if (result.messages.length > 0) return result;
    } catch {
      // Fall through to legacy on any adapter failure.
    }
  }
  return extractWithLegacy();
}

/**
 * Synchronous extractor for callers that can't await (the live-sync
 * MutationObserver loop). Skips adapters that need async work and uses the
 * legacy broad-selector path. Good enough for fingerprinting and live diff.
 */
export function extractConversationSync(): Conversation {
  return extractWithLegacy();
}

export function extractMedia(): MediaAttachment[] {
  const attachments: MediaAttachment[] = [];
  try {
    document.querySelectorAll('pre code[class*="language-"], pre code').forEach((code) => {
      const lang = code.className.match(/language-([\w+-]+)/)?.[1] ?? 'text';
      const text = code.textContent ?? '';
      if (text.length > 0) {
        attachments.push({
          url: '',
          type: 'code',
          name: `code.${lang}`,
          mimeType: `text/x-${lang}`,
        });
      }
    });
  } catch {
    // ignore
  }
  return attachments;
}
