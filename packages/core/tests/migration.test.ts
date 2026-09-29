/**
 * Legacy CIRA conversation (v0) → PCO.
 *
 * `legacy/chatgpt-popup-export.json` has the exact shape of the extension's
 * popup "Export → JSON" output (a serialised `Conversation`), including the
 * optional `code` and `attachments` fields. `legacy/dexie-conversation-record.json`
 * has the shape of a row in the extension's IndexedDB history.
 */
import { describe, expect, it } from 'vitest';
import {
  fromLegacyConversation,
  isLegacyConversation,
  LegacyMigrationError,
  migrateLegacyConversation,
  validate,
} from '../src';
import { loadFixture } from './helpers';

const NOW = '2026-09-29T12:00:00.000Z';

describe('legacy v0 → PCO migration', () => {
  it('migrates a popup JSON export into a valid PCO', () => {
    const raw = loadFixture<Record<string, unknown>>('legacy/chatgpt-popup-export');
    const { document, warnings } = migrateLegacyConversation(raw, { now: NOW, client: 'cira-browser-extension@0.1.0' });

    const r = validate(document);
    expect(r.errors).toEqual([]);

    const conv = document.conversations[0];
    expect(conv.source).toEqual({ kind: 'browser', platform: 'chatgpt', client: 'cira-browser-extension@0.1.0' });
    expect(conv.url).toBe(raw.url);
    expect(conv.title).toBe(raw.title);
    expect(conv.captured_at).toBe(raw.capturedAt);
    expect(conv.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(document.metadata.title).toBe('Vite + React extension setup');

    // Attachment kept without its data URL, and the loss is reported.
    expect(conv.turns[1].attachments).toEqual([
      { kind: 'image', name: 'diagram.png', media_type: 'image/png', uri: 'https://files.oaiusercontent.com/file-abc123/diagram.png' },
    ]);
    expect(warnings.some((w) => w.includes('dropped inline data'))).toBe(true);

    const types = document.items.map((i) => i.type);
    expect(types).toContain('fact');
    expect(types).toContain('constraint');
    expect(types).toContain('question');
    expect(types).toContain('decision');
    expect(types).toContain('task');
    expect(types).toContain('reference');
  });

  it('keeps message content verbatim and appends code that only existed in `code`', () => {
    const raw = loadFixture<{ messages: Array<{ content: string }> }>('legacy/chatgpt-popup-export');
    const { document } = migrateLegacyConversation(raw, { now: NOW });
    const turn = document.conversations[0].turns[1];
    expect(turn.content.startsWith(raw.messages[1].content)).toBe(true);
    const code = document.items.filter((i) => i.type === 'code_artifact').map((i) => [i.type === 'code_artifact' && i.language, i.content]);
    expect(code).toContainEqual(['json', '{\n  "side_panel": { "default_path": "src/sidepanel/index.html" }\n}']);
    expect(code).toContainEqual(['ts', 'chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });']);
  });

  it('migrates the IndexedDB record variant (codeBlocks, numeric id)', () => {
    const { document } = migrateLegacyConversation(loadFixture('legacy/dexie-conversation-record'), { now: NOW });
    expect(validate(document).ok).toBe(true);
    expect(document.conversations[0].source.platform).toBe('claude');
    const summary = document.items.map((i) => [i.type, i.content]);
    expect(summary).toContainEqual(['constraint', 'The client must retry on HTTP 429.']);
    expect(summary).toContainEqual(['question', 'Should we use exponential backoff?']);
    expect(summary).toContainEqual(['decision', "We'll use exponential backoff with jitter."]);
    expect(summary).toContainEqual(['code_artifact', 'const delay = Math.min(30_000, 2 ** attempt * 1000) * Math.random();']);
  });

  it('migrates every fixture without errors', () => {
    for (const name of ['simple-conversation', 'technical-project', 'constraints', 'decisions', 'mixed-context']) {
      expect(isLegacyConversation(loadFixture(name)), name).toBe(true);
      expect(validate(migrateLegacyConversation(loadFixture(name), { now: NOW }).document).errors, name).toEqual([]);
    }
  });

  it('normalises a non-ISO capturedAt and reports it', () => {
    const raw = { ...loadFixture<Record<string, unknown>>('decisions'), capturedAt: 'Sat, 20 Sep 2026 10:00:00 GMT' };
    const { input, warnings } = fromLegacyConversation(raw);
    expect(input.captured_at).toBe('2026-09-20T10:00:00.000Z');
    expect(warnings[0]).toMatch(/capturedAt/);
  });

  it('rejects inputs that are not legacy conversations', () => {
    expect(isLegacyConversation({ pco_version: '0.1' })).toBe(false);
    expect(() => fromLegacyConversation({ source: 'chatgpt', messages: 'nope' })).toThrow(LegacyMigrationError);
    expect(() => fromLegacyConversation({ source: 'chatgpt', title: 't', url: 'u', capturedAt: NOW, messages: [{ role: 'robot', content: 'x' }] })).toThrow(/messages\.0\.role/);
  });
});
