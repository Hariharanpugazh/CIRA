/**
 * Rule-based context compression.
 *
 * Given a Conversation, produce a structured prompt that captures:
 *   - Project / domain context
 *   - Key decisions
 *   - Open questions / current task
 *   - Important code blocks
 *
 * Phase 1 keeps this fully local and heuristic. Phase 2 will offer an
 * optional LLM-powered "Smart Summary" toggle.
 */
import type { CodeBlock, Conversation, Message } from '@/core/schema';

const CODE_FENCE = /```([\w+-]*)\n([\s\S]*?)```/g;

function extractCodeBlocks(content: string): { stripped: string; code: CodeBlock[] } {
  const code: CodeBlock[] = [];
  const stripped = content.replace(CODE_FENCE, (_, lang: string, body: string) => {
    code.push({ language: lang || 'text', code: body.trim() });
    return `[code:${lang || 'text'}]`;
  });
  return { stripped, code };
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])|\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

const DECISION_HINTS = [
  /\bdecided?\b/i,
  /\bchose\b|\bchosen\b/i,
  /\bwill use\b|\bgoing with\b|\bgo with\b/i,
  /\bselected?\b/i,
  /\bwe(?:'re| are) using\b/i,
];

const TASK_HINTS = [
  /\b(need|want|trying) to\b/i,
  /\bhow (do|can|should) i\b/i,
  /\bnext step\b/i,
  /\bcurrent(ly)? working on\b/i,
  /\btodo\b/i,
];

const CONTEXT_HINTS = [
  /\bproject\b/i,
  /\bbackend\b|\bfrontend\b|\bdatabase\b/i,
  /\bstack\b/i,
  /\busing\b/i,
];

function pickTop(sentences: string[], hints: RegExp[], max: number): string[] {
  const scored = sentences.map((s) => {
    const score = hints.reduce((acc, r) => acc + (r.test(s) ? 1 : 0), 0);
    return { s, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => `- ${x.s}`);
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((l) => {
    const key = l.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lastUserMessage(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return undefined;
}

export interface CompressOptions {
  /** Hard cap on characters in the final summary. */
  maxChars?: number;
  /** Max code blocks to include verbatim. */
  maxCodeBlocks?: number;
}

export function compress(conv: Conversation, opts: CompressOptions = {}): string {
  const maxChars = opts.maxChars ?? 6_000;
  const maxCodeBlocks = opts.maxCodeBlocks ?? 3;

  // 1. Extract code blocks across the whole conversation.
  const allCode: CodeBlock[] = [];
  const cleanedMessages = conv.messages.map((m) => {
    const { stripped, code } = extractCodeBlocks(m.content);
    allCode.push(...code);
    return { ...m, content: stripped };
  });

  // 2. Build sentence pool (skip the [code:...] markers).
  const userSentences = cleanedMessages
    .filter((m) => m.role === 'user')
    .flatMap((m) => splitSentences(m.content));
  const assistantSentences = cleanedMessages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => splitSentences(m.content));

  // 3. Score and pick.
  const projectContext = dedupe(
    pickTop([...userSentences, ...assistantSentences], CONTEXT_HINTS, 6),
  );
  const decisions = dedupe(
    pickTop([...userSentences, ...assistantSentences], DECISION_HINTS, 6),
  );
  const tasks = dedupe(pickTop(userSentences, TASK_HINTS, 4));

  // 4. Pick the most "interesting" code blocks: longest, then most recent.
  const rankedCode = [...allCode]
    .map((c, i) => ({ c, i, score: Math.min(c.code.length, 4_000) }))
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, maxCodeBlocks)
    .map((x) => x.c);

  const lastTask = lastUserMessage(conv.messages)?.slice(0, 600);

  // 5. Assemble.
  const sections: string[] = [];
  sections.push(
    `# Context handoff from ${conv.source.toUpperCase()}`,
    `Title: ${conv.title}`,
    `Captured: ${conv.capturedAt}`,
    '',
    'You are continuing a conversation that started in another AI assistant.',
    'Use the context below as if it were your own prior memory of this project.',
    '',
  );

  if (projectContext.length) {
    sections.push('## Project context', ...projectContext, '');
  }
  if (decisions.length) {
    sections.push('## Key decisions', ...decisions, '');
  }
  if (tasks.length) {
    sections.push('## Open tasks / questions', ...tasks, '');
  }
  if (lastTask) {
    sections.push('## Most recent user message', lastTask, '');
  }
  if (rankedCode.length) {
    sections.push('## Relevant code');
    for (const block of rankedCode) {
      sections.push('```' + (block.language || ''), block.code, '```', '');
    }
  }

  sections.push(
    '## Your job',
    'Acknowledge the handoff in one sentence, then continue helping with the most recent user message above.',
  );

  let out = sections.join('\n');
  if (out.length > maxChars) {
    out = out.slice(0, maxChars - 20) + '\n...[truncated]';
  }
  return out;
}
