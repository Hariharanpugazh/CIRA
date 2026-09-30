/**
 * User-controlled selection → Phase 01 encoder → final PCO.
 * The encoder must see ONLY the selected messages, provenance must keep the
 * original message numbers, and removed items must not reach the PCO or the
 * relay text.
 */
import { describe, expect, it } from 'vitest';
import { migrateLegacyConversation, validate } from '@cira/core';
import {
  buildPcoHandoff,
  buildSelectedContext,
  itemMessageNumber,
  SELECTION_EXTENSION,
  SelectionError,
  selectMessages,
} from '@/shared/context-selection';
import { selectionConversation } from './helpers/selection-conversation';

const CLIENT = 'cira-browser-extension@0.1.0';
const NOW = new Date('2026-09-30T10:05:00.000Z');
const opts = { client: CLIENT, now: NOW };
const ALL = [0, 1, 2, 3, 4, 5];

describe('buildSelectedContext', () => {
  it('select all produces the same transcript and items as the Phase 01 full capture', () => {
    const conv = selectionConversation();
    const legacy = migrateLegacyConversation(conv, { client: CLIENT, createdBy: CLIENT, now: NOW }).document;
    const { document } = buildSelectedContext(conv, { messageIndexes: ALL }, opts);

    const { extensions, ...rest } = document;
    expect(rest).toEqual(legacy);
    expect(extensions?.[SELECTION_EXTENSION]).toEqual({
      selection: { message_indexes: ALL, total_messages: 6, extracted_items: legacy.items.length, selected_items: legacy.items.length },
    });
    expect(validate(document).ok).toBe(true);
  });

  it('passes only the selected messages to the encoder and keeps their original numbers', () => {
    const conv = selectionConversation();
    const { document } = buildSelectedContext(conv, { messageIndexes: [4, 0, 2] }, opts);
    const turns = document.conversations[0].turns;

    expect(turns.map((t) => [t.index, t.content])).toEqual([0, 2, 4].map((i) => [i, conv.messages[i].content]));
    const json = JSON.stringify(document);
    for (const i of [1, 3, 5]) expect(json).not.toContain(conv.messages[i].content.slice(0, 20));
    expect(json).not.toContain('Django for the backend');
    expect(json).not.toContain('login(user');

    // Provenance still points at the original messages (turn ids `_t0`, `_t2`, `_t4`).
    for (const item of document.items) {
      expect(item.provenance.turn_id).toMatch(/_t[024]$/);
      const n = itemMessageNumber(document, item)!;
      const turn = turns.find((t) => t.index === n - 1)!;
      expect(turn.content.slice(item.provenance.span!.start, item.provenance.span!.end)).toContain(item.content.slice(0, 10));
    }
    expect(document.items.map((i) => [i.type, i.content, itemMessageNumber(document, i)])).toEqual([
      ['fact', "I'm building a TypeScript project.", 1],
      ['preference', 'I prefer React and Tailwind.', 1],
      ['fact', 'The project needs authentication.', 3],
      ['constraint', 'Do not use Firebase.', 3],
      ['question', 'Can you also add rate limiting?', 5],
    ]);
    expect(validate(document).ok).toBe(true);
  });

  it('items from a selected message are identical to the same items in a full capture', () => {
    const conv = selectionConversation();
    const full = buildSelectedContext(conv, { messageIndexes: ALL }, opts).document;
    const part = buildSelectedContext(conv, { messageIndexes: [1] }, opts).document;
    expect(part.items).toEqual(full.items.filter((i) => i.provenance.turn_id?.endsWith('_t1')));
  });

  it('drops deselected context items from the final PCO (the draft keeps them for review)', () => {
    const conv = selectionConversation();
    const { draft } = buildSelectedContext(conv, { messageIndexes: ALL }, opts);
    const removed = draft.items.find((i) => i.type === 'preference')!;
    const keep = draft.items.filter((i) => i.id !== removed.id).map((i) => i.id);

    const { draft: again, document } = buildSelectedContext(conv, { messageIndexes: ALL, itemIds: keep }, opts);
    expect(again.items).toHaveLength(draft.items.length);
    expect(document.items.map((i) => i.id)).toEqual(keep);
    expect(JSON.stringify(document.items)).not.toContain('I prefer React and Tailwind.');
    // The transcript is the selected messages, verbatim (a removed item is not a removed message).
    expect(document.conversations[0].turns).toHaveLength(6);
    expect((document.extensions?.[SELECTION_EXTENSION] as { selection: { selected_items: number } }).selection.selected_items).toBe(keep.length);
    expect(validate(document).ok).toBe(true);
  });

  it('rejects an empty selection and unknown item IDs', () => {
    const conv = selectionConversation();
    expect(() => buildSelectedContext(conv, { messageIndexes: [] }, opts)).toThrow(SelectionError);
    expect(() => buildSelectedContext(conv, { messageIndexes: [99, -1] }, opts)).toThrow(/Select at least one message/);
    expect(() => buildSelectedContext(conv, { messageIndexes: [0], itemIds: ['itm_nope'] }, opts)).toThrow(/Unknown context item/);
  });

  it('returns a valid PCO with no items when the selection has no transferable context', () => {
    const conv = { ...selectionConversation(), messages: [{ role: 'assistant' as const, content: 'Sure, happy to help.' }] };
    const { draft } = buildSelectedContext(conv, { messageIndexes: [0] }, opts);
    expect(draft.items).toEqual([]);
    expect(validate(draft).ok).toBe(true);
  });

  it('is deterministic, so the side panel draft and the service worker rebuild agree on item IDs', () => {
    const conv = selectionConversation();
    const a = buildSelectedContext(conv, { messageIndexes: [0, 2] }, { client: CLIENT, now: new Date('2026-09-30T10:00:00Z') });
    const b = buildSelectedContext(conv, { messageIndexes: [2, 0] }, { client: CLIENT, now: new Date('2026-09-30T11:00:00Z') });
    expect(b.draft.items.map((i) => i.id)).toEqual(a.draft.items.map((i) => i.id));
    expect(b.draft.id).toBe(a.draft.id);
  });
});

describe('relay text for a reviewed context', () => {
  it('contains only kept items, never deselected messages or removed items', () => {
    const conv = selectionConversation();
    const { draft } = buildSelectedContext(conv, { messageIndexes: [0, 1, 2] }, opts);
    const removed = draft.items.find((i) => i.content === 'Do not use Firebase.')!;
    const { document } = buildSelectedContext(conv, { messageIndexes: [0, 1, 2], itemIds: draft.items.filter((i) => i !== removed).map((i) => i.id) }, opts);
    const text = buildPcoHandoff(document, { source: conv.source, title: conv.title, capturedAt: conv.capturedAt });

    expect(text.startsWith('# Context handoff from CHATGPT\nTitle: TypeScript React Django Stack')).toBe(true);
    expect(text).toContain('Selected: 3 of 6 messages, 5 context items');
    expect(text).toContain("- I'm building a TypeScript project.");
    expect(text).toContain('- I prefer React and Tailwind.');
    expect(text).toContain("- We'll use Django for the backend.");
    expect(text).toContain('```\nproject/\n├── frontend/\n└── backend/\n```');
    expect(text).not.toContain('Firebase');
    expect(text).not.toContain('rate limit');
    expect(text).not.toContain('login(user');
  });

  it('selectMessages keeps conversation order and drops the rest', () => {
    const conv = selectionConversation();
    const sub = selectMessages(conv, [3, 1]);
    expect(sub.messages).toEqual([conv.messages[1], conv.messages[3]]);
    expect(sub.title).toBe(conv.title);
  });
});
