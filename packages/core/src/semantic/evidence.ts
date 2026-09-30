/**
 * Locate a model-provided evidence quote inside a turn.
 *
 * Models are asked for verbatim quotes, not character offsets (they are bad
 * at counting). CIRA finds the quote itself: exact match first, then a
 * normalised match (case, whitespace runs, curly quotes, dashes) mapped back
 * to original offsets. A quote that cannot be found is not evidence.
 */
import type { Span } from '../types';

const FOLD: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"',
  '\u2013': '-', '\u2014': '-', '\u2212': '-', '\u00a0': ' ',
};

interface Folded {
  text: string;
  /** folded index → original index */
  map: number[];
}

function fold(s: string): Folded {
  let text = '';
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    let ch = FOLD[s[i]] ?? s[i];
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      ch = ' ';
      prevSpace = true;
    } else {
      prevSpace = false;
    }
    text += ch.toLowerCase();
    map.push(i);
  }
  return { text, map };
}

/** Strip wrapping quotes / ellipses models like to add. */
function cleanQuote(quote: string): string {
  return quote.trim().replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').replace(/^(\.\.\.|…)\s*|\s*(\.\.\.|…)$/g, '').trim();
}

export function locateQuote(content: string, quote: string): Span | undefined {
  const q = cleanQuote(quote);
  if (q.length < 2) return undefined;
  const exact = content.indexOf(q);
  if (exact >= 0) return { start: exact, end: exact + q.length };

  const hay = fold(content);
  const needle = fold(q).text.trim();
  if (needle.length < 2) return undefined;
  const at = hay.text.indexOf(needle);
  if (at < 0) return undefined;
  const start = hay.map[at];
  const end = hay.map[at + needle.length - 1] + 1;
  return end > start ? { start, end } : undefined;
}
