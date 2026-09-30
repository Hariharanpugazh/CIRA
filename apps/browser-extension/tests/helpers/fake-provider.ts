/**
 * Fake OpenAI-compatible endpoint for browser semantic tests. It records every
 * request (so tests can check exactly which messages left the extension) and
 * answers like a well-behaved model: one evidence-backed item per message.
 */
import type { HttpRequest, HttpResponse, HttpTransport } from '@cira/core';
import type { Conversation } from '@/shared/schema';

export interface PromptMessage {
  ref: string;
  role: string;
  content: string;
}

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: { model: string; messages: Array<{ role: string; content: string }> };
  /** Messages the extension put in the prompt. */
  sent: PromptMessage[];
}

/** Ten short messages, alternating user / assistant, each with one clear idea. */
export function tenMessageConversation(): Conversation {
  const lines: Array<['user' | 'assistant', string]> = [
    ['user', 'I prefer PostgreSQL for the database.'],
    ['assistant', 'MongoDB may be easier for a document-heavy app.'],
    ['user', 'The API must use TypeScript.'],
    ['assistant', 'You could deploy it on Fly.io.'],
    ['user', 'Do not use Firebase.'],
    ['assistant', 'Consider Redis for caching.'],
    ['user', 'We need rate limiting on login.'],
    ['assistant', 'Maybe use GraphQL instead of REST.'],
    ['user', 'The deadline is next Friday.'],
    ['assistant', 'I can write the migration scripts.'],
  ];
  return {
    source: 'chatgpt',
    title: 'Ten message planning chat',
    url: 'https://chatgpt.com/c/10000000-0000-4000-8000-000000000010',
    capturedAt: '2026-09-30T10:00:00.000Z',
    messages: lines.map(([role, content]) => ({ role, content })),
  };
}

export function promptMessages(body: RecordedCall['body']): PromptMessage[] {
  const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
  return JSON.parse(user.slice(user.indexOf('\n') + 1)) as PromptMessage[];
}

/** A valid model answer: users state facts/constraints, the assistant only proposes. */
export function goodAnswer(sent: PromptMessage[]): string {
  const items = sent.map((m, i) => {
    const user = m.role === 'user';
    const constraint = user && /must|do not/i.test(m.content);
    return {
      ref: `i${i + 1}`,
      type: user ? (constraint ? 'constraint' : 'fact') : 'decision',
      content: m.content.replace(/\.$/, ''),
      origin: user ? 'user' : 'assistant',
      assertion: user ? 'explicit' : 'suggested',
      confidence: 0.9,
      strength: constraint ? (/do not/i.test(m.content) ? 'must_not' : 'must') : null,
      status: user ? null : 'proposed',
      language: null,
      filename: null,
      uri: null,
      title: null,
      evidence: [{ message: m.ref, quote: m.content }],
    };
  });
  return JSON.stringify({ items, relations: [] });
}

export type Reply = { status: number; body: string } | ((sent: PromptMessage[]) => { status: number; body: string });

export const chatCompletion = (content: string): { status: number; body: string } => ({
  status: 200,
  body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }),
});

export function fakeOpenAI(reply: Reply = (sent) => chatCompletion(goodAnswer(sent))): { transport: HttpTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: HttpTransport = async (req: HttpRequest): Promise<HttpResponse> => {
    const body = JSON.parse(req.body) as RecordedCall['body'];
    const sent = promptMessages(body);
    calls.push({ url: req.url, headers: req.headers, body, sent });
    return typeof reply === 'function' ? reply(sent) : reply;
  };
  return { transport, calls };
}
