/** Text utilities shared by extractors. All offsets are UTF-16 code units. */

export interface FencedBlock {
  start: number;
  end: number;
  info: string;
  body: string;
}

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

/** Find fenced Markdown code blocks (```info\n…```). */
export function findFencedBlocks(text: string): FencedBlock[] {
  const out: FencedBlock[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, info: m[1].trim(), body: m[2].replace(/\n$/, '') });
  }
  return out;
}

/** Replace ranges with spaces (keeping newlines) so offsets stay aligned. */
export function maskRanges(text: string, ranges: ReadonlyArray<{ start: number; end: number }>): string {
  if (ranges.length === 0) return text;
  const chars = text.split('');
  for (const r of ranges) {
    for (let i = r.start; i < r.end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

export interface Segment {
  text: string;
  start: number;
  end: number;
}

const LIST_MARKER = /^(?:[-*•]|\d{1,3}[.)])\s+/;
const SENTENCE_BREAK = /(?<=[.!?])\s+/g;

/**
 * Split text into sentence-like segments with exact offsets. Lines are split
 * first, then sentences within a line. List markers are excluded from the
 * segment. Segments shorter than `minLength` characters are dropped.
 */
export function splitSegments(text: string, minLength = 6): Segment[] {
  const out: Segment[] = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    let cursor = 0;
    const pieces: Array<{ piece: string; offset: number }> = [];
    for (const m of line.matchAll(SENTENCE_BREAK)) {
      const idx = m.index ?? 0;
      pieces.push({ piece: line.slice(cursor, idx), offset: cursor });
      cursor = idx + m[0].length;
    }
    pieces.push({ piece: line.slice(cursor), offset: cursor });

    for (const { piece, offset } of pieces) {
      const leading = piece.length - piece.trimStart().length;
      let body = piece.trim();
      let bodyOffset = offset + leading;
      const marker = LIST_MARKER.exec(body);
      if (marker) {
        body = body.slice(marker[0].length);
        bodyOffset += marker[0].length;
      }
      if (body.length < minLength || !/[A-Za-z\u00C0-\uFFFF]{2}/.test(body)) continue;
      const start = lineStart + bodyOffset;
      out.push({ text: body, start, end: start + body.length });
    }
    lineStart += line.length + 1;
  }
  return out;
}

/** Normalised key for de-duplication. */
export function normalizeForDedupe(s: string): string {
  return s.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').replace(/[.!?;:,]+$/, '').trim();
}
