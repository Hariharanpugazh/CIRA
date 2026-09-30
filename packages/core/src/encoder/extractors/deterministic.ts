/**
 * Deterministic extractors: exact, rule-free structure (fenced code, URLs).
 * Confidence is 1.0 because the item is a literal copy of the source text.
 */
import { findFencedBlocks } from '../text';
import type { ItemDraft, ItemExtractor } from '../types';

export const codeBlockExtractor: ItemExtractor = {
  id: 'cira.code-blocks',
  version: '0.1.0',
  method: 'deterministic',
  extract({ turn }) {
    const drafts: ItemDraft[] = [];
    for (const block of findFencedBlocks(turn.content)) {
      if (!block.body.trim()) continue;
      const [lang = '', ...rest] = block.info.split(/\s+/).filter(Boolean);
      const filename = rest.find((t) => /[./]/.test(t));
      const draft: ItemDraft = {
        type: 'code_artifact',
        content: block.body,
        language: lang.toLowerCase() || 'text',
        confidence: 1,
        span: { start: block.start, end: block.end },
      };
      if (filename) draft.filename = filename;
      drafts.push(draft);
    }
    return drafts;
  },
};

const MD_LINK = /(!?)\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>()[\]"'`]+/g;

export const referenceExtractor: ItemExtractor = {
  id: 'cira.references',
  version: '0.1.0',
  method: 'deterministic',
  extract({ prose }) {
    const drafts: ItemDraft[] = [];
    const covered: Array<{ start: number; end: number }> = [];

    for (const m of prose.matchAll(MD_LINK)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      covered.push({ start, end });
      if (m[1] === '!') continue; // images are attachments, not references
      drafts.push({
        type: 'reference',
        content: m[3],
        uri: m[3],
        title: m[2].trim(),
        confidence: 1,
        span: { start, end },
      });
    }

    for (const m of prose.matchAll(BARE_URL)) {
      const start = m.index ?? 0;
      if (covered.some((r) => start >= r.start && start < r.end)) continue;
      const uri = m[0].replace(/[.,;:!?]+$/, '');
      drafts.push({ type: 'reference', content: uri, uri, confidence: 1, span: { start, end: start + uri.length } });
    }
    return drafts;
  },
};
