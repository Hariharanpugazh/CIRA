/**
 * The published JSON Schema and examples must match what @cira/core
 * generates today (no drift), and must be usable by non-TypeScript
 * consumers through a standard JSON Schema validator.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { validate } from '@cira/core';
import { buildExamples, buildSchema, EXAMPLES_DIR, SCHEMA_FILE, serialize } from '../src/build';

const onDisk = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('@cira/pco artifacts', () => {
  it('schema file matches the Zod source of truth (run `pnpm generate:schema` if this fails)', () => {
    expect(onDisk(SCHEMA_FILE)).toBe(serialize(buildSchema()));
  });

  it('example files match the current encoder output', () => {
    for (const { name, document } of buildExamples()) {
      expect(onDisk(join(EXAMPLES_DIR, name)), name).toBe(serialize(document));
    }
    expect(readdirSync(EXAMPLES_DIR).sort()).toEqual(buildExamples().map((e) => e.name).sort());
  });

  describe('JSON Schema works with a standard validator (Ajv, draft 2020-12)', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const check = ajv.compile(JSON.parse(onDisk(SCHEMA_FILE)));

    for (const name of readdirSync(EXAMPLES_DIR)) {
      it(`accepts ${name} (and so does validate())`, () => {
        const doc = JSON.parse(onDisk(join(EXAMPLES_DIR, name)));
        expect(check(doc), JSON.stringify(check.errors)).toBe(true);
        expect(validate(doc).ok).toBe(true);
      });
    }

    it('rejects structurally invalid documents', () => {
      const doc = JSON.parse(onDisk(join(EXAMPLES_DIR, 'decisions.pco.json')));
      expect(check({ ...doc, pco_version: 'one' })).toBe(false);
      expect(check({ ...doc, items: [{ ...doc.items[0], type: 'emotion' }] })).toBe(false);
      expect(check({ ...doc, items: [{ ...doc.items[0], confidence: 2 }] })).toBe(false);
      const noProvenance = { ...doc.items[0] };
      delete noProvenance.provenance;
      expect(check({ ...doc, items: [noProvenance] })).toBe(false);
    });
  });
});
