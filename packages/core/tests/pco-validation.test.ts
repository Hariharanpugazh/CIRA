import { describe, expect, it } from 'vitest';
import {
  assertValid,
  parsePco,
  PcoUpgradeError,
  PcoValidationError,
  upgrade,
  validate,
  type Upgrader,
} from '../src';
import { clone, makeValidDoc } from './helpers';

const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

describe('PCO schema + validation', () => {
  it('accepts a valid document', () => {
    const r = validate(makeValidDoc());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.document?.items[0].type).toBe('constraint');
    expect(r.declaredVersion).toBe('0.1');
  });

  it('accepts every context item type', () => {
    const doc = makeValidDoc();
    const base = doc.items[0];
    const common = {
      content: base.content,
      confidence: base.confidence,
      created_at: base.created_at,
      provenance: base.provenance,
    };
    doc.items = [
      { ...common, id: 'i_fact', type: 'fact' },
      { ...common, id: 'i_dec', type: 'decision', status: 'accepted', rationale: 'r' },
      { ...common, id: 'i_con', type: 'constraint', strength: 'must' },
      { ...common, id: 'i_pref', type: 'preference' },
      { ...common, id: 'i_task', type: 'task', status: 'open' },
      { ...common, id: 'i_q', type: 'question' },
      { ...common, id: 'i_code', type: 'code_artifact', language: 'ts', filename: 'a.ts' },
      { ...common, id: 'i_ref', type: 'reference', uri: 'https://example.org' },
    ];
    expect(validate(doc).errors).toEqual([]);
  });

  it('preserves unknown fields and extensions (forward compatibility)', () => {
    const doc = { ...makeValidDoc(), extensions: { 'cira.test': { a: 1 } }, future_field: true };
    const r = validate(doc);
    expect(r.ok).toBe(true);
    expect((r.document as Record<string, unknown>).future_field).toBe(true);
    expect(r.document?.extensions).toEqual({ 'cira.test': { a: 1 } });
  });

  it('rejects non-objects', () => {
    expect(codes(validate(null).errors)).toEqual(['not_an_object']);
    expect(codes(validate([]).errors)).toEqual(['not_an_object']);
  });

  it('rejects missing required fields', () => {
    const doc = clone(makeValidDoc()) as Record<string, unknown>;
    delete doc.metadata;
    const r = validate(doc);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'schema' && e.path[0] === 'metadata')).toBe(true);

    const d2 = clone(makeValidDoc());
    delete (d2.items[0] as Partial<typeof d2.items[0]>).content;
    expect(validate(d2).errors.some((e) => e.path.join('.') === 'items.0.content')).toBe(true);
  });

  it('rejects malformed provenance', () => {
    const doc = clone(makeValidDoc());
    (doc.items[0].provenance as Record<string, unknown>).extracted_by = { method: 'magic' };
    const r = validate(doc);
    expect(r.ok).toBe(false);
    expect(r.errors.every((e) => e.path.slice(0, 3).join('.') === 'items.0.provenance')).toBe(true);
  });

  it('requires provenance on items', () => {
    const doc = clone(makeValidDoc());
    delete (doc.items[0] as Partial<typeof doc.items[0]>).provenance;
    expect(validate(doc).ok).toBe(false);
  });

  it('rejects out-of-range confidence', () => {
    const doc = clone(makeValidDoc());
    doc.items[0].confidence = 1.5;
    expect(validate(doc).ok).toBe(false);
  });

  describe('item types', () => {
    it('rejects unknown item types for the current version', () => {
      const doc = clone(makeValidDoc()) as unknown as { items: Array<Record<string, unknown>> };
      doc.items.push({ ...doc.items[0], id: 'x', type: 'emotion' });
      const r = validate(doc);
      expect(r.ok).toBe(false);
      expect(r.errors).toEqual([expect.objectContaining({ code: 'unknown_item_type', path: ['items', 1, 'type'] })]);
    });
  });

  describe('versions', () => {
    it('requires pco_version', () => {
      const doc = clone(makeValidDoc()) as Record<string, unknown>;
      delete doc.pco_version;
      expect(codes(validate(doc).errors)).toEqual(['missing_version']);
    });

    it('rejects malformed versions', () => {
      expect(codes(validate({ ...makeValidDoc(), pco_version: 'v1' }).errors)).toEqual(['invalid_version']);
      expect(codes(validate({ ...makeValidDoc(), pco_version: 1 }).errors)).toEqual(['invalid_version']);
    });

    it('rejects an unknown major version', () => {
      const r = validate({ ...makeValidDoc(), pco_version: '1.0' });
      expect(r.ok).toBe(false);
      expect(codes(r.errors)).toEqual(['unsupported_major_version']);
    });

    it('reads a newer minor version with a warning, ignoring unknown item types', () => {
      const doc = clone(makeValidDoc()) as unknown as Record<string, unknown> & { items: Array<Record<string, unknown>> };
      doc.pco_version = '0.7';
      doc.items.push({ ...doc.items[0], id: 'x', type: 'emotion', mood: 'calm' });
      const r = validate(doc);
      expect(r.ok).toBe(true);
      expect(codes(r.warnings)).toEqual(['newer_minor_version', 'unknown_item_type']);
      expect(r.document?.items.map((i) => i.id)).toEqual(['itm_1']);
    });

    it('asks for upgrade() on older minor versions', () => {
      expect(codes(validate({ ...makeValidDoc(), pco_version: '0.0' }).errors)).toEqual(['requires_upgrade']);
    });
  });

  describe('semantic checks', () => {
    it('detects duplicate IDs across conversations, turns and items', () => {
      const doc = clone(makeValidDoc());
      doc.items.push({ ...doc.items[0] });
      doc.conversations[0].turns[1].id = 'conv_a_t0';
      const r = validate(doc);
      expect(codes(r.errors).filter((c) => c === 'duplicate_id')).toHaveLength(2);
    });

    it('detects an item reusing the document id', () => {
      const doc = clone(makeValidDoc());
      doc.items[0].id = doc.id;
      expect(codes(validate(doc).errors)).toContain('duplicate_id');
    });

    it('detects provenance pointing at a missing conversation', () => {
      const doc = clone(makeValidDoc());
      doc.items[0].provenance.conversation_id = 'conv_missing';
      expect(codes(validate(doc).errors)).toContain('unknown_conversation');
    });

    it('detects provenance pointing at a missing turn', () => {
      const doc = clone(makeValidDoc());
      doc.items[0].provenance.turn_id = 'conv_a_t9';
      expect(codes(validate(doc).errors)).toEqual(['unknown_turn']);
    });

    it('detects a turn that belongs to another conversation', () => {
      const doc = clone(makeValidDoc());
      doc.conversations.push({ ...clone(doc.conversations[0]), id: 'conv_b', turns: [{ id: 'conv_b_t0', index: 0, role: 'user', content: 'hello there' }] });
      doc.items[0].provenance.turn_id = 'conv_b_t0';
      expect(codes(validate(doc).errors)).toEqual(['turn_not_in_conversation']);
    });

    it('requires conversation_id when turn_id is set', () => {
      const doc = clone(makeValidDoc());
      delete doc.items[0].provenance.conversation_id;
      expect(codes(validate(doc).errors)).toContain('turn_without_conversation');
    });

    it('detects invalid spans', () => {
      const outOfRange = clone(makeValidDoc());
      outOfRange.items[0].provenance.span = { start: 0, end: 999 };
      expect(codes(validate(outOfRange).errors)).toEqual(['invalid_span']);

      const inverted = clone(makeValidDoc());
      inverted.items[0].provenance.span = { start: 10, end: 5 };
      expect(codes(validate(inverted).errors)).toEqual(['invalid_span']);

      const noTurn = clone(makeValidDoc());
      delete noTurn.items[0].provenance.turn_id;
      expect(codes(validate(noTurn).errors)).toEqual(['span_without_turn']);

      const negative = clone(makeValidDoc());
      negative.items[0].provenance.span = { start: -1, end: 5 };
      expect(validate(negative).ok).toBe(false);
    });

    it('detects invalid timestamps (format and calendar)', () => {
      const badFormat = clone(makeValidDoc());
      badFormat.metadata.created_at = '20/09/2026';
      expect(codes(validate(badFormat).errors)).toEqual(['invalid_timestamp']);

      const noOffset = clone(makeValidDoc());
      noOffset.items[0].created_at = '2026-09-20T10:00:00';
      expect(codes(validate(noOffset).errors)).toEqual(['invalid_timestamp']);

      const impossibleDate = clone(makeValidDoc());
      impossibleDate.conversations[0].captured_at = '2026-02-30T10:00:00Z';
      const r = validate(impossibleDate);
      expect(r.ok).toBe(false);
      expect(codes(r.errors)).toContain('invalid_timestamp');
    });

    it('detects duplicate turn indices', () => {
      const doc = clone(makeValidDoc());
      doc.conversations[0].turns[1].index = 0;
      expect(codes(validate(doc).errors)).toEqual(['duplicate_turn_index']);
    });

    it('warns when updated_at precedes created_at', () => {
      const doc = clone(makeValidDoc());
      doc.metadata.updated_at = '2026-01-01T00:00:00Z';
      const r = validate(doc);
      expect(r.ok).toBe(true);
      expect(codes(r.warnings)).toEqual(['timestamp_order']);
    });

    it('accepts items without conversation provenance (manual context)', () => {
      const doc = clone(makeValidDoc());
      doc.items[0].provenance = {
        source: { kind: 'manual', platform: 'user' },
        captured_at: '2026-09-20T10:00:00Z',
        extracted_by: { method: 'manual', agent: 'cli' },
      };
      expect(validate(doc).errors).toEqual([]);
    });
  });

  it('assertValid throws PcoValidationError with issues', () => {
    const doc = clone(makeValidDoc());
    doc.items[0].provenance.conversation_id = 'nope';
    expect(() => assertValid(doc)).toThrow(PcoValidationError);
    expect(assertValid(makeValidDoc()).id).toBe('pco_test');
  });

  it('does not mutate its input', () => {
    const doc = clone(makeValidDoc()) as unknown as Record<string, unknown> & { items: Array<Record<string, unknown>> };
    doc.pco_version = '0.9';
    doc.items.push({ ...doc.items[0], id: 'x', type: 'emotion' });
    const snapshot = JSON.stringify(doc);
    validate(doc);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('upgrade()', () => {
  it('is the identity for current documents', () => {
    const doc = makeValidDoc();
    const r = upgrade(doc);
    expect(r.document).toBe(doc);
    expect(r.applied).toEqual([]);
  });

  it('leaves newer minor versions untouched', () => {
    const doc = { ...makeValidDoc(), pco_version: '0.4' };
    expect(upgrade(doc).document).toBe(doc);
  });

  it('applies a registered upgrade chain', () => {
    const upgraders: Upgrader[] = [
      {
        from: '0.0',
        to: '0.1',
        upgrade: (d) => {
          const { title, ...rest } = d as { title?: string } & Record<string, unknown>;
          const metadata = { ...(rest.metadata as object), title };
          return { ...rest, metadata };
        },
      },
    ];
    const old = { ...makeValidDoc(), pco_version: '0.0', title: 'Old title' } as Record<string, unknown>;
    delete (old.metadata as Record<string, unknown>).title;
    const r = upgrade(old, { upgraders });
    expect(r.applied).toEqual(['0.0→0.1']);
    const v = validate(r.document);
    expect(v.ok).toBe(true);
    expect(v.document?.metadata.title).toBe('Old title');
  });

  it('throws for unknown majors and missing paths', () => {
    expect(() => upgrade({ ...makeValidDoc(), pco_version: '2.0' })).toThrow(PcoUpgradeError);
    expect(() => upgrade({ ...makeValidDoc(), pco_version: '0.0' })).toThrow(/no upgrade path/);
  });

  it('parsePco() combines upgrade + validate and reports upgrade failures as errors', () => {
    expect(parsePco(makeValidDoc()).ok).toBe(true);
    const r = parsePco({ ...makeValidDoc(), pco_version: '3.1' });
    expect(r.ok).toBe(false);
    expect(codes(r.errors)).toEqual(['unsupported_major_version']);
  });
});
