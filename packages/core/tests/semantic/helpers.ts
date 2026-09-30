import { buildConversation, type ConversationInput, type ExtractionInput, type ModelItem, type ModelOutput, type Role } from '../../src';

export const NOW = '2026-09-30T10:00:00.000Z';

export function conversationInput(turns: Array<[Role, string]>, extra: Partial<ConversationInput> = {}): ConversationInput {
  return {
    source: { kind: 'browser', platform: 'chatgpt', client: 'test' },
    url: 'https://chatgpt.com/c/semantic-test',
    title: 'Semantic test',
    captured_at: '2026-09-30T09:00:00.000Z',
    turns: turns.map(([role, content]) => ({ role, content })),
    ...extra,
  };
}

export function extractionInput(turns: Array<[Role, string]>, extra: Partial<ConversationInput> = {}): ExtractionInput {
  const conversation = buildConversation(conversationInput(turns, extra));
  return { conversation, source: conversation.source, now: NOW };
}

/** The Phase 02 reference conversation. */
export const STACK_TURNS: Array<[Role, string]> = [
  ['user', "I'm building a TypeScript project. I prefer React and Tailwind. The backend must use Django. Authentication is required."],
  ['assistant', 'React + TypeScript + Tailwind for frontend. Django REST Framework for backend. JWT authentication. You could use PostgreSQL for the database.'],
];

/** Model item with nullable fields defaulted. */
export function mi(partial: Partial<ModelItem> & Pick<ModelItem, 'ref' | 'type' | 'content' | 'evidence'>): ModelItem {
  return {
    origin: 'user',
    assertion: 'explicit',
    confidence: 0.9,
    strength: null,
    status: null,
    language: null,
    filename: null,
    uri: null,
    title: null,
    ...partial,
  };
}

export const out = (items: ModelItem[], relations: ModelOutput['relations'] = []): ModelOutput => ({ items, relations });

/** What a correct model returns for STACK_TURNS (used as scripted provider output). */
export const STACK_MODEL_OUTPUT: ModelOutput = out([
  mi({ ref: 'i1', type: 'fact', content: 'The project uses TypeScript', evidence: [{ message: 'm0', quote: "I'm building a TypeScript project." }] }),
  mi({ ref: 'i2', type: 'preference', content: 'Prefers React and Tailwind', evidence: [{ message: 'm0', quote: 'I prefer React and Tailwind.' }] }),
  mi({ ref: 'i3', type: 'constraint', strength: 'must', content: 'Backend must use Django', evidence: [{ message: 'm0', quote: 'The backend must use Django.' }] }),
  mi({ ref: 'i4', type: 'constraint', strength: 'must', content: 'Authentication is required', evidence: [{ message: 'm0', quote: 'Authentication is required.' }] }),
  mi({ ref: 'i5', type: 'decision', status: 'proposed', origin: 'assistant', assertion: 'suggested', content: 'Use Django REST Framework for the backend', evidence: [{ message: 'm1', quote: 'Django REST Framework for backend.' }] }),
  mi({ ref: 'i6', type: 'decision', status: 'proposed', origin: 'assistant', assertion: 'suggested', content: 'Use JWT authentication', evidence: [{ message: 'm1', quote: 'JWT authentication.' }] }),
  mi({ ref: 'i7', type: 'decision', status: 'proposed', origin: 'assistant', assertion: 'suggested', content: 'Use PostgreSQL for the database', evidence: [{ message: 'm1', quote: 'You could use PostgreSQL for the database.' }] }),
]);
