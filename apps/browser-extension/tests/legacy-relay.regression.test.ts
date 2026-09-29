/**
 * Browser regression safety net.
 *
 * Locks the exact relay text the extension injects. The snapshots were
 * recorded from the pre-migration `src/core/compress.ts`, before the
 * compressor moved into @cira/core. If this fails, relay behaviour changed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRelaySummary } from '@/shared/relay';
import type { Conversation } from '@/shared/schema';

const FIXTURES = resolve(__dirname, '../../../packages/core/tests/fixtures');
const SNAPSHOTS = '../../../packages/core/tests/__snapshots__/legacy-compress';

const CASES = [
  'simple-conversation',
  'technical-project',
  'constraints',
  'decisions',
  'mixed-context',
  'legacy/chatgpt-popup-export',
];

function load(name: string): Conversation {
  return JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as Conversation;
}

describe('legacy relay text (extension path)', () => {
  for (const name of CASES) {
    it(`produces unchanged relay text for ${name}`, async () => {
      await expect(buildRelaySummary(load(name))).toMatchFileSnapshot(`${SNAPSHOTS}/${name.replace('/', '__')}.md`);
    });
  }

  it('honours preserveLastN and maxChars options', async () => {
    const out = buildRelaySummary(load('technical-project'), { preserveLastN: 2, maxChars: 700 });
    await expect(out).toMatchFileSnapshot(`${SNAPSHOTS}/technical-project.options.md`);
  });
});
