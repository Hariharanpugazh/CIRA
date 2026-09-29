/**
 * Safety net for platform detection. Recorded against the pre-migration
 * code: the popup (`detectSource`), the content-script registry
 * (`getPlatformDefForUrl`) and the DOM adapters (`pickAdapter`) must keep
 * agreeing on these URLs.
 */
import { describe, expect, it } from 'vitest';
import { detectSource, getAvailableTargets } from '@/platform/detect';
import { getPlatformDefForUrl, getAllPlatforms } from '@/platform/registry';
import { pickAdapter } from '@/adapters';

const CASES: Array<[url: string, expected: string]> = [
  ['https://chatgpt.com/c/68d1f0a2-7b3c-8004-9d2e-0a1b2c3d4e5f', 'chatgpt'],
  ['https://chat.openai.com/', 'chatgpt'],
  ['https://claude.ai/chat/22222222', 'claude'],
  ['https://gemini.google.com/app/abc', 'gemini'],
  ['https://chat.deepseek.com/a/chat/s/1', 'deepseek'],
  ['https://www.perplexity.ai/search/x', 'perplexity'],
  ['https://copilot.microsoft.com/chats/1', 'copilot'],
  ['https://grok.com/chat/1', 'grok'],
  ['https://kimi.moonshot.cn/chat/1', 'kimi'],
  ['https://chat.qwen.ai/c/1', 'qwen'],
  ['https://poe.com/chat/1', 'poe'],
  ['https://huggingface.co/chat/conversation/1', 'huggingchat'],
  ['https://notebooklm.google.com/notebook/1', 'notebooklm'],
  ['https://you.com/search?q=1', 'you'],
  ['https://character.ai/chat/1', 'characterai'],
  ['https://pi.ai/talk', 'pi'],
  ['https://chat.mistral.ai/chat/1', 'mistral'],
];

describe('platform detection', () => {
  for (const [url, expected] of CASES) {
    it(`detects ${expected} for ${url}`, () => {
      expect(detectSource(url)).toBe(expected);
      expect(getPlatformDefForUrl(url).id).toBe(expected);
      expect(pickAdapter(new URL(url).hostname)?.id).toBe(expected);
    });
  }

  it('returns unknown for non-AI pages', () => {
    expect(detectSource('https://example.org/')).toBe('unknown');
    expect(detectSource(undefined)).toBe('unknown');
    expect(getPlatformDefForUrl('https://example.org/').id).toBe('unknown');
    expect(pickAdapter('example.org')).toBeNull();
  });

  it('lists relay targets excluding the current platform', () => {
    expect(getAvailableTargets('chatgpt')).not.toContain('chatgpt');
    expect(getAvailableTargets('chatgpt')).toContain('claude');
  });

  it('registry exposes all non-unknown platforms', () => {
    expect(getAllPlatforms().map((p) => p.id)).not.toContain('unknown');
    expect(getAllPlatforms().length).toBe(17);
  });
});
