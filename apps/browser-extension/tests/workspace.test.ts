/** Side panel state machine: selection, search, navigation and guards. */
import { describe, expect, it } from 'vitest';
import { buildSelectedContext } from '@/shared/context-selection';
import {
  currentSelection,
  initialWorkspace,
  selectedItemIds,
  selectionKey,
  visibleMessages,
  workspaceReducer as reduce,
  type WorkspaceAction,
  type WorkspaceState,
} from '@/sidepanel/state/workspace';
import { selectionConversation } from './helpers/selection-conversation';

const run = (state: WorkspaceState, ...actions: WorkspaceAction[]) => actions.reduce(reduce, state);
const captured = () => run(initialWorkspace, { type: 'capture/start' }, { type: 'capture/ok', conversation: selectionConversation() });
const selected = (s: WorkspaceState) => [...s.selectedMessages].sort((a, b) => a - b);
const draftFor = (s: WorkspaceState) =>
  buildSelectedContext(s.conversation!, { messageIndexes: selected(s) }, { client: 'test@0', now: new Date('2026-09-30T10:00:00Z') }).draft;
const toReview = (s: WorkspaceState) => run(s, { type: 'review/start' }, { type: 'review/ok', draft: draftFor(s), key: selectionKey(s.selectedMessages) });

describe('message selection', () => {
  it('previews are compact: code fences collapse to a marker, full text is kept', () => {
    const m = captured().messages[1];
    expect(m.preview).toBe("We'll use Django for the backend. [text block]");
    expect(m.content).toContain('├── frontend/');
    expect(m.long).toBe(true);
  });

  it('capture shows every message, all selected by default', () => {
    const s = captured();
    expect(s.step).toBe('select');
    expect(s.busy).toBeNull();
    expect(s.messages.map((m) => m.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(selected(s)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('select all / clear all / invert / individual toggle', () => {
    let s = run(captured(), { type: 'messages/none' });
    expect(selected(s)).toEqual([]);
    s = run(s, { type: 'message/toggle', index: 2 }, { type: 'message/toggle', index: 4 });
    expect(selected(s)).toEqual([2, 4]);
    s = run(s, { type: 'message/toggle', index: 2 });
    expect(selected(s)).toEqual([4]);
    s = run(s, { type: 'messages/invert' });
    expect(selected(s)).toEqual([0, 1, 2, 3, 5]);
    s = run(s, { type: 'messages/all' });
    expect(selected(s)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('shift-click selects a contiguous range from the last clicked message', () => {
    const s = run(captured(), { type: 'messages/none' }, { type: 'message/toggle', index: 1 }, { type: 'message/toggle', index: 4, range: true });
    expect(selected(s)).toEqual([1, 2, 3, 4]);
    const back = run(s, { type: 'message/toggle', index: 2, range: true });
    expect(selected(back)).toEqual([1]); // #3 was on, so the range 2..4 (from anchor 4) is cleared
  });

  it('search filters what is visible but never changes the selection', () => {
    let s = run(captured(), { type: 'message/toggle', index: 3 }); // deselect #4
    const before = selected(s);
    s = run(s, { type: 'query', query: 'django' });
    expect(visibleMessages(s).map((m) => m.index)).toEqual([1]);
    expect(selected(s)).toEqual(before);
    s = run(s, { type: 'query', query: 'use  redis' }); // all terms, any order
    expect(visibleMessages(s).map((m) => m.index)).toEqual([5]);
    s = run(s, { type: 'query', query: '' });
    expect(visibleMessages(s)).toHaveLength(6);
    expect(selected(s)).toEqual(before);
  });

  it('bulk actions while searching apply to the matches only', () => {
    let s = run(captured(), { type: 'messages/none' }, { type: 'query', query: 'we\'ll use' });
    s = run(s, { type: 'messages/all' });
    expect(selected(s)).toEqual([1, 5]);
    s = run(s, { type: 'query', query: '' }, { type: 'messages/invert' });
    expect(selected(s)).toEqual([0, 2, 3, 4]);
  });
});

describe('navigation and guards', () => {
  it('cannot review with no messages selected', () => {
    const s = run(captured(), { type: 'messages/none' }, { type: 'review/start' });
    expect(s.step).toBe('select');
    expect(s.busy).toBeNull();
    expect(s.error).toBe('Select at least one message to continue.');
  });

  it('Review → Select keeps the message selection; Send → Review keeps item removals', () => {
    let s = run(captured(), { type: 'message/toggle', index: 5 });
    s = toReview(s);
    expect(s.step).toBe('review');
    const firstItem = s.draft!.items[0].id;
    s = run(s, { type: 'item/toggle', id: firstItem }, { type: 'send/open' });
    expect(s.step).toBe('send');
    s = run(s, { type: 'back' });
    expect(s.step).toBe('review');
    expect(s.removedItems.has(firstItem)).toBe(true);
    s = run(s, { type: 'back' });
    expect(s.step).toBe('select');
    expect(selected(s)).toEqual([0, 1, 2, 3, 4]);
    // Re-extracting after changing messages keeps the earlier removal.
    s = toReview(run(s, { type: 'message/toggle', index: 4 }));
    expect(selectedItemIds(s)).not.toContain(firstItem);
  });

  it('item selection: toggle, all, none; cannot continue with zero items', () => {
    let s = toReview(captured());
    const ids = s.draft!.items.map((i) => i.id);
    s = run(s, { type: 'item/toggle', id: ids[1] });
    expect(selectedItemIds(s)).toEqual(ids.filter((id) => id !== ids[1]));
    s = run(s, { type: 'items/none' }, { type: 'send/open' });
    expect(s.step).toBe('review');
    expect(s.error).toBe('Select at least one context item to continue.');
    s = run(s, { type: 'items/all' }, { type: 'send/open' });
    expect(s.step).toBe('send');
    expect(currentSelection(s)).toEqual({ messageIndexes: [0, 1, 2, 3, 4, 5], itemIds: ids });
  });

  it('needs a target or Save locally before submitting', () => {
    let s = run(toReview(captured()), { type: 'send/open' }, { type: 'saveLocally', value: false }, { type: 'submit/start', kind: 'saving', label: 'Saving…' });
    expect(s.busy).toBeNull();
    expect(s.error).toBe('Choose a target AI or Save locally.');
    s = run(s, { type: 'target', target: 'claude' }, { type: 'submit/start', kind: 'sending', label: 'Sending to Claude…' });
    expect(s.busy).toEqual({ kind: 'sending', label: 'Sending to Claude…' });
  });

  it('loading and error states', () => {
    let s = run(initialWorkspace, { type: 'capture/start' });
    expect(s.busy?.label).toBe('Reading conversation…');
    s = run(s, { type: 'capture/fail', error: 'Reload this tab to activate CIRA.' });
    expect(s).toMatchObject({ step: 'idle', busy: null, error: 'Reload this tab to activate CIRA.' });
    s = run(s, { type: 'error/dismiss' });
    expect(s.error).toBeNull();
    s = run(captured(), { type: 'review/start' });
    expect(s.busy?.label).toBe('Extracting context…');
    s = run(s, { type: 'review/fail', error: 'boom' });
    expect(s).toMatchObject({ step: 'select', busy: null, error: 'boom' });
  });

  it('a new capture resets the flow but keeps the active context', () => {
    const active = { id: 'pco_x' } as WorkspaceState['active'];
    const s = run(toReview(captured()), { type: 'active/set', active }, { type: 'capture/ok', conversation: selectionConversation() });
    expect(s).toMatchObject({ step: 'select', draft: null, active });
    expect(s.removedItems.size).toBe(0);
  });
});
