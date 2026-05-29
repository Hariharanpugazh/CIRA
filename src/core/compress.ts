import { encode } from 'gpt-tokenizer';
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

function dedupe(lines: string[], threshold = 120): string[] {
  const seen = new Set<string>();
  return lines.filter((l) => {
    const key = l.toLowerCase().replace(/\s+/g, ' ').slice(0, threshold);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lastMessages(messages: Message[], n: number): Message[] {
  const result: Message[] = [];
  for (let i = messages.length - 1; i >= 0 && result.length < n; i--) {
    result.unshift(messages[i]);
  }
  return result;
}

function lastUserMessage(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return undefined;
}

export function countTokens(text: string): number {
  return encode(text).length;
}

export interface CompressOptions {
  maxChars?: number;
  maxCodeBlocks?: number;
  maxTokens?: number;
  preserveLastN?: number;
  deduplicateThreshold?: number;
}

export function compress(conv: Conversation, opts: CompressOptions = {}): string {
  const maxChars = opts.maxChars ?? 6_000;
  const maxCodeBlocks = opts.maxCodeBlocks ?? 3;
  const preserveLastN = opts.preserveLastN ?? 0;
  const deduplicateThreshold = opts.deduplicateThreshold ?? 120;

  const allCode: CodeBlock[] = [];
  const cleanedMessages = conv.messages.map((m) => {
    const { stripped, code } = extractCodeBlocks(m.content);
    allCode.push(...code);
    return { ...m, content: stripped };
  });

  const userSentences = cleanedMessages
    .filter((m) => m.role === 'user')
    .flatMap((m) => splitSentences(m.content));
  const assistantSentences = cleanedMessages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => splitSentences(m.content));

  const projectContext = dedupe(
    pickTop([...userSentences, ...assistantSentences], CONTEXT_HINTS, 6),
    deduplicateThreshold,
  );
  const decisions = dedupe(
    pickTop([...userSentences, ...assistantSentences], DECISION_HINTS, 6),
    deduplicateThreshold,
  );
  const tasks = dedupe(pickTop(userSentences, TASK_HINTS, 4), deduplicateThreshold);

  const rankedCode = [...allCode]
    .map((c, i) => ({ c, i, score: Math.min(c.code.length, 4_000) }))
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, maxCodeBlocks)
    .map((x) => x.c);

  const lastTask = lastUserMessage(conv.messages)?.slice(0, 600);

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

  if (preserveLastN > 0) {
    const recent = lastMessages(conv.messages, preserveLastN);
    sections.push('## Recent messages (verbatim)');
    for (const msg of recent) {
      sections.push(`**${msg.role}:** ${msg.content.slice(0, 400)}`, '');
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

export interface CompressWithTuningResult {
  summary: string;
  method: 'rule-based' | 'llm-fallback';
  tokenCount: number;
}

export async function compressWithTuning(
  conv: Conversation,
  targetTokens: number,
): Promise<CompressWithTuningResult> {
  const maxChars = targetTokens * 4;
  const summary = compress(conv, { maxChars, maxCodeBlocks: 3, preserveLastN: 2 });
  const tokenCount = countTokens(summary);

  if (tokenCount <= targetTokens) {
    return { summary, method: 'rule-based', tokenCount };
  }

  const aggressivelyTrimmed = compress(conv, {
    maxChars: Math.floor(targetTokens * 3.5),
    maxCodeBlocks: 1,
    preserveLastN: 1,
  });
  const trimmedTokens = countTokens(aggressivelyTrimmed);

  if (trimmedTokens <= targetTokens) {
    return { summary: aggressivelyTrimmed, method: 'rule-based', tokenCount: trimmedTokens };
  }

  return { summary: aggressivelyTrimmed, method: 'llm-fallback', tokenCount: trimmedTokens };
}

export function formatContextTag(summary: string): string {
  const truncated = summary.length > 2_000 ? summary.slice(0, 2_000) + '\n...[truncated]' : summary;
  return `<cira-context>\n${truncated}\n</cira-context>`;
}
