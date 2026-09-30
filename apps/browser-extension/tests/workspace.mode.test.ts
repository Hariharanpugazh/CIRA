import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings, privacyHint, providerProblem, OLLAMA_BASE_URL } from '@/shared/extraction-settings';
import { draftKeyFor, initialWorkspace, workspaceReducer, type WorkspaceState } from '@/sidepanel/state/workspace';
import { selectionConversation } from './helpers/selection-conversation';

const captured = (): WorkspaceState => workspaceReducer(initialWorkspace, { type: 'capture/ok', conversation: selectionConversation() });

describe('extraction mode state', () => {
  it('defaults to deterministic, and unknown stored settings fall back to it', () => {
    expect(initialWorkspace.mode).toBe('deterministic');
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ extractionMode: 'magic', provider: { baseUrl: 42 } })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ extractionMode: 'hybrid', provider: { preset: 'ollama', model: ' qwen2.5:7b ' } })).toEqual({
      extractionMode: 'hybrid',
      provider: { preset: 'ollama', baseUrl: OLLAMA_BASE_URL, model: 'qwen2.5:7b' },
    });
  });

  it('settings/loaded and mode/set update the mode without touching the selection', () => {
    let s = captured();
    s = workspaceReducer(s, { type: 'message/toggle', index: 3 });
    const selected = [...s.selectedMessages];
    s = workspaceReducer(s, { type: 'settings/loaded', settings: { ...DEFAULT_SETTINGS, extractionMode: 'semantic' } });
    expect(s.mode).toBe('semantic');
    s = workspaceReducer(s, { type: 'mode/set', mode: 'hybrid' });
    expect(s.mode).toBe('hybrid');
    expect([...s.selectedMessages]).toEqual(selected);
  });

  it('the draft key includes mode and provider, so a mode change re-extracts', () => {
    const sel = new Set([0, 2]);
    const p = { preset: 'ollama' as const, baseUrl: OLLAMA_BASE_URL, model: 'a' };
    expect(draftKeyFor(sel, 'deterministic', p)).toBe('deterministic:0,2');
    expect(draftKeyFor(sel, 'semantic', p)).not.toBe(draftKeyFor(sel, 'hybrid', p));
    expect(draftKeyFor(sel, 'semantic', p)).not.toBe(draftKeyFor(sel, 'semantic', { ...p, model: 'b' }));
  });

  it('semantic failure keeps the conversation, selection and step; Switch clears it', () => {
    let s = workspaceReducer(captured(), { type: 'mode/set', mode: 'semantic' });
    s = workspaceReducer(s, { type: 'review/start' });
    expect(s.busy?.label).toBe('Extracting context… Using semantic model…');
    s = workspaceReducer(s, { type: 'review/semantic-fail', failure: { code: 'unreachable', message: 'Could not reach 127.0.0.1:11434.' } });
    expect(s.step).toBe('select');
    expect(s.busy).toBeNull();
    expect(s.conversation).not.toBeNull();
    expect(s.selectedMessages.size).toBe(6);
    expect(s.semanticError?.code).toBe('unreachable');
    s = workspaceReducer(s, { type: 'mode/set', mode: 'deterministic' });
    expect(s.semanticError).toBeNull();
    expect(workspaceReducer(s, { type: 'review/start' }).busy?.label).toBe('Extracting context…');
  });

  it('reset keeps the chosen mode and provider', () => {
    const s = workspaceReducer(workspaceReducer(captured(), { type: 'mode/set', mode: 'hybrid' }), { type: 'reset' });
    expect(s.mode).toBe('hybrid');
    expect(s.step).toBe('idle');
  });

  it('privacy hint and provider checks', () => {
    const local = { preset: 'ollama' as const, baseUrl: OLLAMA_BASE_URL, model: 'm' };
    expect(privacyHint('deterministic', local)).toBe('Nothing is sent to an AI provider.');
    expect(privacyHint('semantic', local)).toMatch(/^Processing locally with Ollama/);
    expect(privacyHint('hybrid', { preset: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'm' })).toMatch(
      /^Selected messages will be sent to api\.example\.com/,
    );
    expect(providerProblem(local)).toBeNull();
    expect(providerProblem({ ...local, model: '' })).toMatch(/model name/);
    expect(providerProblem({ ...local, baseUrl: 'http://example.com/v1' })).toMatch(/https/);
    expect(providerProblem({ ...local, baseUrl: 'https://user:pw@example.com/v1' })).toMatch(/valid/);
  });
});
