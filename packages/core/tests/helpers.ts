import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PCODocument } from '../src';

export const FIXTURES_DIR = resolve(__dirname, 'fixtures');

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, `${name}.json`), 'utf8')) as T;
}

/** A small, hand-written, valid PCO v0.1 document. */
export function makeValidDoc(): PCODocument {
  const source = { kind: 'browser' as const, platform: 'chatgpt', client: 'test' };
  return {
    pco_version: '0.1',
    id: 'pco_test',
    metadata: {
      title: 'Test context',
      created_at: '2026-09-20T10:00:00.000Z',
      updated_at: '2026-09-20T10:05:00.000Z',
    },
    conversations: [
      {
        id: 'conv_a',
        source,
        title: 'A',
        url: 'https://chatgpt.com/c/a',
        captured_at: '2026-09-20T10:00:00.000Z',
        turns: [
          { id: 'conv_a_t0', index: 0, role: 'user', content: 'Do not use Firebase.' },
          { id: 'conv_a_t1', index: 1, role: 'assistant', content: 'Understood.' },
        ],
      },
    ],
    items: [
      {
        id: 'itm_1',
        type: 'constraint',
        strength: 'must_not',
        content: 'Do not use Firebase.',
        confidence: 0.7,
        created_at: '2026-09-20T10:05:00.000Z',
        provenance: {
          source,
          conversation_id: 'conv_a',
          turn_id: 'conv_a_t0',
          span: { start: 0, end: 20 },
          captured_at: '2026-09-20T10:00:00.000Z',
          extracted_by: { method: 'heuristic', agent: 'test@0' },
        },
      },
    ],
  };
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
