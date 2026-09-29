import { describe, expect, it } from 'vitest';
import {
  compressLegacy,
  encode,
  legacyRuleCompressor,
  migrateLegacyConversation,
  scanDocument,
  scanForSecrets,
  type LegacyConversationV0,
} from '../src';
import { loadFixture } from './helpers';

const SNAPSHOTS = './__snapshots__/legacy-compress';

describe('legacy rule compressor (core)', () => {
  // Same snapshot files as the extension regression test: one source of truth.
  for (const name of ['simple-conversation', 'technical-project', 'constraints', 'decisions', 'mixed-context', 'legacy/chatgpt-popup-export']) {
    it(`matches the pre-migration output for ${name}`, async () => {
      await expect(compressLegacy(loadFixture<LegacyConversationV0>(name))).toMatchFileSnapshot(`${SNAPSHOTS}/${name.replace('/', '__')}.md`);
    });
  }

  it('is exposed through the Compressor interface with an honest method', () => {
    expect(legacyRuleCompressor.method).toBe('heuristic');
    const conv = loadFixture<LegacyConversationV0>('decisions');
    expect(legacyRuleCompressor.compress(conv)).toBe(compressLegacy(conv));
  });

  it('does not touch the PCO representation', () => {
    const conv = loadFixture<LegacyConversationV0>('mixed-context');
    const before = JSON.stringify(migrateLegacyConversation(conv, { now: '2026-01-01T00:00:00Z' }).document);
    compressLegacy(conv);
    expect(JSON.stringify(migrateLegacyConversation(conv, { now: '2026-01-01T00:00:00Z' }).document)).toBe(before);
  });
});

describe('safety scan', () => {
  // Assembled at runtime so the repository itself does not contain a token-shaped string.
  const fakeToken = ['ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');

  it('reports secrets with location and redacted preview only', () => {
    const doc = encode({
      source: { kind: 'cli', platform: 'test' },
      captured_at: '2026-09-29T00:00:00Z',
      turns: [
        { role: 'user', content: 'Here is my GitHub token: ' + fakeToken },
        { role: 'assistant', content: 'Please revoke it.' },
      ],
    });
    const report = scanDocument(doc);
    expect(report.hasFindings).toBe(true);
    expect(report.findings[0].location).toMatchObject({ kind: 'turn', turn_index: 0 });
    expect(JSON.stringify(report)).not.toContain(fakeToken);
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it('terminates on ordinary text and detects a key at the very end (regression)', () => {
    expect(scanForSecrets('Just a normal sentence without secrets.')).toEqual([]);
    const key = ['sk', '-proj-', 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'].join('');
    const found = scanForSecrets(`my key is ${key}`);
    expect(found.map((f) => f.type)).toContain('OpenAI API Key');
  });

  it('reports nothing for clean context', () => {
    const { document } = migrateLegacyConversation(loadFixture('decisions'));
    expect(scanDocument(document)).toEqual({ hasFindings: false, findings: [], warnings: [] });
  });
});
