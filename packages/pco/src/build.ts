/**
 * Builds the published PCO artifacts from @cira/core, the single source of
 * truth. Used by `pnpm generate:schema` and by the drift test.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { migrateLegacyConversation, PCO_VERSION, PCODocumentSchema, type PCODocument } from '@cira/core';

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_FILE = resolve(PACKAGE_DIR, 'schema', `pco-${PCO_VERSION}.schema.json`);
export const EXAMPLES_DIR = resolve(PACKAGE_DIR, 'examples');

/** Legacy conversations (in @cira/core's test fixtures) the examples are encoded from. */
const EXAMPLE_SOURCES = ['simple-conversation', 'technical-project', 'constraints', 'decisions', 'mixed-context'] as const;
const FIXTURES_DIR = resolve(PACKAGE_DIR, '..', 'core', 'tests', 'fixtures');
const EXAMPLE_TIME = '2026-09-29T12:00:00.000Z';

export function buildSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(PCODocumentSchema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://cira.dev/schema/pco-${PCO_VERSION}.schema.json`,
    title: `CIRA Portable Context Object v${PCO_VERSION}`,
    $comment:
      'GENERATED from packages/core/src/pco/schema.ts. Do not edit by hand; run `pnpm generate:schema`. ' +
      'Structural rules only: cross-reference checks (unique IDs, provenance → conversation/turn, span bounds, calendar-valid timestamps) are semantic and implemented by @cira/core validate().',
    ...Object.fromEntries(Object.entries(generated).filter(([k]) => k !== '$schema')),
  };
}

export function buildExamples(): Array<{ name: string; document: PCODocument }> {
  return EXAMPLE_SOURCES.map((name) => {
    const legacy = JSON.parse(readFileSync(resolve(FIXTURES_DIR, `${name}.json`), 'utf8'));
    const { document } = migrateLegacyConversation(legacy, {
      now: EXAMPLE_TIME,
      client: 'cira-examples',
      createdBy: 'cira-examples',
    });
    return { name: `${name}.pco.json`, document };
  });
}

export function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}
