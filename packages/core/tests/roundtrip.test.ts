/**
 * Conversation → PCO → decode → equivalent context.
 *
 * "Equivalent" means: every statement we expect the encoder to capture is
 * present after decoding, in the right section, and its provenance resolves
 * to the original platform, conversation, turn, role and exact source text.
 */
import { describe, expect, it } from 'vitest';
import {
  decode,
  encode,
  fromLegacyConversation,
  parsePco,
  renderMarkdown,
  type ContextItemType,
} from '../src';
import { loadFixture } from './helpers';

const NOW = '2026-09-29T12:00:00.000Z';

interface Expectation {
  type: ContextItemType;
  content: string;
  turn: number;
  role: 'user' | 'assistant';
}

const EXPECTED: Record<string, { platform: string; title: string; items: Expectation[] }> = {
  'technical-project': {
    platform: 'claude',
    title: 'CIRA sync service',
    items: [
      { type: 'fact', content: "We're building a sync service for CIRA.", turn: 0, role: 'user' },
      { type: 'constraint', content: 'Do not use Firebase.', turn: 0, role: 'user' },
      { type: 'constraint', content: 'The API must be versioned.', turn: 0, role: 'user' },
      { type: 'code_artifact', content: "export const router = createRouter({ prefix: '/v1' });", turn: 1, role: 'assistant' },
      { type: 'decision', content: 'Sounds good, we decided to use Fastify.', turn: 2, role: 'user' },
      { type: 'task', content: 'Next step: add request validation with Zod.', turn: 2, role: 'user' },
      { type: 'question', content: 'Should we store sessions in Redis?', turn: 2, role: 'user' },
    ],
  },
  'mixed-context': {
    platform: 'perplexity',
    title: 'Note-taking app sync',
    items: [
      { type: 'fact', content: "I'm working on a note-taking app.", turn: 0, role: 'user' },
      { type: 'preference', content: "I'd rather keep the UI minimal.", turn: 0, role: 'user' },
      { type: 'constraint', content: 'The app must support Markdown.', turn: 0, role: 'user' },
      { type: 'reference', content: 'https://automerge.org/', turn: 1, role: 'assistant' },
      { type: 'code_artifact', content: 'const doc = Automerge.init();', turn: 1, role: 'assistant' },
      { type: 'decision', content: "Let's use Automerge.", turn: 2, role: 'user' },
      { type: 'constraint', content: 'Avoid any paid services.', turn: 2, role: 'user' },
    ],
  },
};

describe('round trip: conversation → PCO → decoded context', () => {
  for (const [fixture, expected] of Object.entries(EXPECTED)) {
    it(`preserves important context for ${fixture}`, () => {
      const pco = encode(fromLegacyConversation(loadFixture(fixture)).input, { now: NOW });

      // Serialise and re-read exactly as a consumer would.
      const reread = parsePco(JSON.parse(JSON.stringify(pco)));
      expect(reread.ok).toBe(true);
      const decoded = decode(reread.document!);

      expect(decoded.title).toBe(expected.title);
      expect(decoded.conversations[0].platform).toBe(expected.platform);

      const all = decoded.sections.flatMap((s) => s.items.map((d) => ({ section: s.type, ...d })));
      for (const e of expected.items) {
        const found = all.find((d) => d.section === e.type && d.item.content === e.content);
        expect(found, `${e.type}: ${e.content}`).toBeDefined();
        expect(found!.provenance).toMatchObject({
          platform: expected.platform,
          conversation_title: expected.title,
          turn_index: e.turn,
          role: e.role,
        });
        // The span points at the exact source text (code/link spans include the markup).
        expect(found!.provenance.excerpt).toContain(e.type === 'code_artifact' ? e.content : e.content.replace(/\.$/, ''));
      }

      const md = renderMarkdown(decoded);
      for (const e of expected.items) expect(md).toContain(e.type === 'reference' ? e.content : e.content.split('\n')[0]);
    });
  }

  it('orders sections with constraints first and filters by type and confidence', () => {
    const pco = encode(fromLegacyConversation(loadFixture('technical-project')).input, { now: NOW });
    const full = decode(pco);
    expect(full.sections[0].type).toBe('constraint');

    const filtered = decode(pco, { types: ['decision', 'constraint', 'task'] });
    expect(filtered.sections.map((s) => s.type)).toEqual(['constraint', 'decision', 'task']);
    expect(filtered.total_items).toBeLessThan(filtered.available_items);

    const confident = decode(pco, { minConfidence: 0.9 });
    expect(confident.sections.map((s) => s.type)).toEqual(['code_artifact']);
  });

  it('renders readable markdown with provenance and an honest extraction note', () => {
    const pco = encode(fromLegacyConversation(loadFixture('mixed-context')).input, { now: NOW });
    const md = renderMarkdown(decode(pco));
    expect(md).toMatch(/^# Context: Note-taking app sync/);
    expect(md).toContain('## Constraints');
    expect(md).toContain('- **MUST:** The app must support Markdown. _(perplexity · "Note-taking app sync" · turn 0 (user) · heuristic 0.70)_');
    expect(md).toContain('- [Automerge](https://automerge.org/)');
    expect(md).toContain('```js\nconst doc = Automerge.init();\n```');
    expect(md).toContain('heuristic (keyword/phrase rules; may miss or misclassify statements)');
    expect(md).not.toMatch(/semantic|intelligent|AI-powered|LLM/i);

    const bare = renderMarkdown(decode(pco), { provenance: false });
    expect(bare).not.toContain('_(perplexity');
  });
});
