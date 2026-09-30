/**
 * Generic Markdown rendering of a decoded context. Readable by humans and
 * usable as agent context. Target-specific prompt framing belongs in
 * connectors, not here.
 */
import { describeProvenance } from '../provenance';
import type { DecodedContext, DecodedItem } from './decode';

export interface RenderMarkdownOptions {
  /** Append a provenance note to each item. Default true. */
  provenance?: boolean;
  /** Show confidence next to heuristic/model items. Default true. */
  confidence?: boolean;
  /** Heading level for the title (1–3). Default 1. */
  headingLevel?: 1 | 2 | 3;
}

const METHOD_NOTE: Record<string, string> = {
  deterministic: 'deterministic (literal copies of code blocks and links)',
  heuristic: 'heuristic (keyword/phrase rules; may miss or misclassify statements)',
  manual: 'manual (entered by a person)',
  model: 'model (extracted by a language model)',
  migration: 'migration (converted from an older format)',
};

function fence(code: string, language: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${language === 'text' ? '' : language}\n${code}\n${ticks}`;
}

function note(d: DecodedItem, opts: Required<RenderMarkdownOptions>): string {
  if (!opts.provenance) return '';
  let s = describeProvenance(d.provenance);
  if (opts.confidence && d.provenance.method !== 'deterministic' && d.provenance.method !== 'manual') {
    s += ` ${d.item.confidence.toFixed(2)}`;
  }
  // Semantic attribution (only present for semantic/hybrid documents).
  const a = d.annotation;
  if (a && (a.assertion === 'suggested' || a.assertion === 'inferred' || a.assertion === 'quoted')) {
    s += ` · ${a.assertion}${a.assertion === 'suggested' && a.origin !== 'user' ? ` by ${a.origin}` : ''}`;
  }
  return ` _(${s})_`;
}

function renderItem(d: DecodedItem, opts: Required<RenderMarkdownOptions>): string {
  const item = d.item;
  const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();
  switch (item.type) {
    case 'constraint':
      return `- **${item.strength.replace('_', ' ').toUpperCase()}:** ${oneLine(item.content)}${note(d, opts)}`;
    case 'decision':
      return `- ${oneLine(item.content)}${item.status ? ` [${item.status}]` : ''}${note(d, opts)}`;
    case 'task':
      return `- [${item.status === 'done' ? 'x' : ' '}] ${oneLine(item.content)}${note(d, opts)}`;
    case 'reference':
      return `- ${item.title ? `[${item.title}](${item.uri})` : `<${item.uri}>`}${note(d, opts)}`;
    case 'code_artifact': {
      const head = `${item.language}${item.filename ? ` — \`${item.filename}\`` : ''}`;
      return `**${head}**${note(d, opts)}\n\n${fence(item.content, item.language)}`;
    }
    default:
      return `- ${oneLine(item.content)}${note(d, opts)}`;
  }
}

export function renderMarkdown(ctx: DecodedContext, options: RenderMarkdownOptions = {}): string {
  const opts: Required<RenderMarkdownOptions> = {
    provenance: options.provenance ?? true,
    confidence: options.confidence ?? true,
    headingLevel: options.headingLevel ?? 1,
  };
  const h = (n: number) => '#'.repeat(Math.min(6, opts.headingLevel - 1 + n));
  const out: string[] = [];

  out.push(`${h(1)} ${ctx.title ? `Context: ${ctx.title}` : 'Context'}`, '');
  out.push(`PCO \`${ctx.document_id}\` · v${ctx.pco_version} · updated ${ctx.updated_at}`, '');

  if (ctx.conversations.length) {
    out.push('Sources:');
    for (const c of ctx.conversations) {
      out.push(`- ${c.platform} (${c.kind})${c.title ? ` — "${c.title}"` : ''}, ${c.turn_count} turns, captured ${c.captured_at}${c.url ? ` — ${c.url}` : ''}`);
    }
    out.push('');
  }

  if (ctx.methods.length) {
    out.push(`> Extraction: ${ctx.methods.map((m) => METHOD_NOTE[m] ?? m).join('; ')}.`);
    if (ctx.methods.includes('heuristic')) {
      out.push('> Confidence values are rule-based estimates, not model judgements. Check important items against the source turn.');
    }
    if (ctx.methods.includes('model')) {
      out.push('> Model-extracted items are backed by verbatim evidence from the selected messages. Items marked "suggested by assistant" are proposals, not user requirements.');
    }
    out.push('');
  }

  if (ctx.total_items < ctx.available_items) {
    out.push(`_Showing ${ctx.total_items} of ${ctx.available_items} items (filtered)._`, '');
  }

  if (ctx.sections.length === 0) {
    out.push('_No context items._', '');
  }

  for (const section of ctx.sections) {
    out.push(`${h(2)} ${section.label}`, '');
    const sep = section.type === 'code_artifact' ? '\n\n' : '\n';
    out.push(section.items.map((d) => renderItem(d, opts)).join(sep), '');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
