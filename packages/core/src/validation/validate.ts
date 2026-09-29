/**
 * PCO validation = structural (Zod schema) + semantic (cross-references,
 * uniqueness, calendar-valid timestamps, span bounds).
 *
 * `validate()` never throws and never mutates its input.
 */
import type { z } from 'zod';
import { CONTEXT_ITEM_TYPES, PCODocumentSchema } from '../pco/schema';
import { compareToCurrent, parseVersion, PCO_VERSION } from '../pco/version';
import type { PCODocument } from '../types';
import { formatIssue, type IssueCode, type IssuePath, type ValidationIssue } from './issues';

export interface ValidationResult {
  ok: boolean;
  /** Parsed document; present when `ok` is true. */
  document?: PCODocument;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Declared `pco_version` of the input, if readable. */
  declaredVersion?: string;
  supportedVersion: string;
}

export class PcoValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(`Invalid PCO document:\n${issues.map(formatIssue).join('\n')}`);
    this.name = 'PcoValidationError';
    this.issues = issues;
  }
}

const KNOWN_TYPES = new Set<string>(CONTEXT_ITEM_TYPES);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Collector {
  readonly errors: ValidationIssue[] = [];
  readonly warnings: ValidationIssue[] = [];
  error(code: IssueCode, message: string, path: IssuePath = []) {
    this.errors.push({ code, severity: 'error', message, path });
  }
  warn(code: IssueCode, message: string, path: IssuePath = []) {
    this.warnings.push({ code, severity: 'warning', message, path });
  }
}

const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** True when the ISO string names a real calendar instant (rejects 2026-02-30 etc.). */
export function isCalendarValidTimestamp(value: string): boolean {
  const m = ISO_PARTS.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m.map((x) => (x === undefined ? '0' : x));
  const year = Number(y), month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return false;
  return !Number.isNaN(Date.parse(value));
}

function mapZodIssue(issue: z.core.$ZodIssue): { code: IssueCode; message: string } {
  const last = issue.path[issue.path.length - 1];
  const isTimestampField = typeof last === 'string' && /(_at|^timestamp)$/.test(last);
  if (issue.code === 'invalid_format' && (issue as { format?: string }).format === 'datetime') {
    return { code: 'invalid_timestamp', message: `${issue.message} (expected ISO 8601 with offset)` };
  }
  if (isTimestampField && issue.code === 'invalid_type') {
    return { code: 'invalid_timestamp', message: issue.message };
  }
  return { code: 'schema', message: issue.message };
}

/**
 * Validate an arbitrary JSON value as a PCO document of the supported major
 * version. Older minor versions must be passed through `upgrade()` first.
 */
export function validate(input: unknown): ValidationResult {
  const c = new Collector();
  const base = { supportedVersion: PCO_VERSION };

  if (!isRecord(input)) {
    c.error('not_an_object', 'PCO document must be a JSON object');
    return { ok: false, errors: c.errors, warnings: c.warnings, ...base };
  }

  // 1. Version gate.
  const declared = input.pco_version;
  if (declared === undefined) {
    c.error('missing_version', 'pco_version is required', ['pco_version']);
    return { ok: false, errors: c.errors, warnings: c.warnings, ...base };
  }
  const parsed = parseVersion(declared);
  if (!parsed) {
    c.error('invalid_version', `pco_version must be "MAJOR.MINOR", got ${JSON.stringify(declared)}`, ['pco_version']);
    return { ok: false, errors: c.errors, warnings: c.warnings, ...base };
  }
  const declaredVersion = declared as string;
  const compat = compareToCurrent(parsed);
  if (compat === 'unsupported_major') {
    c.error(
      'unsupported_major_version',
      `pco_version ${declaredVersion} has a different major version than the supported ${PCO_VERSION}`,
      ['pco_version'],
    );
    return { ok: false, errors: c.errors, warnings: c.warnings, declaredVersion, ...base };
  }
  if (compat === 'older_minor') {
    c.error('requires_upgrade', `pco_version ${declaredVersion} is older than ${PCO_VERSION}; run upgrade() first`, ['pco_version']);
    return { ok: false, errors: c.errors, warnings: c.warnings, declaredVersion, ...base };
  }
  const newerMinor = compat === 'newer_minor';
  if (newerMinor) {
    c.warn(
      'newer_minor_version',
      `pco_version ${declaredVersion} is newer than ${PCO_VERSION}; unknown fields are preserved, unknown item types are ignored`,
      ['pco_version'],
    );
  }

  // 2. Unknown item types: error for the current version, warning (and
  //    dropped from the parsed result) for newer minor versions.
  let candidate: Record<string, unknown> = input;
  // Maps filtered item positions back to original indices for error paths.
  const indexMap: number[] = [];
  if (Array.isArray(input.items)) {
    const kept: unknown[] = [];
    input.items.forEach((item, i) => {
      const type = isRecord(item) ? item.type : undefined;
      if (typeof type === 'string' && !KNOWN_TYPES.has(type)) {
        const msg = `unknown item type "${type}"`;
        if (newerMinor) c.warn('unknown_item_type', `${msg}; item ignored`, ['items', i, 'type']);
        else c.error('unknown_item_type', `${msg}; expected one of ${CONTEXT_ITEM_TYPES.join(', ')}`, ['items', i, 'type']);
        return;
      }
      indexMap.push(i);
      kept.push(item);
    });
    candidate = { ...input, items: kept };
  }

  // 3. Structural validation.
  const structural = PCODocumentSchema.safeParse(candidate);
  if (!structural.success) {
    for (const issue of structural.error.issues) {
      const path = [...issue.path] as Array<string | number>;
      if (path[0] === 'items' && typeof path[1] === 'number') path[1] = indexMap[path[1]] ?? path[1];
      const mapped = mapZodIssue(issue);
      c.error(mapped.code, mapped.message, path);
    }
    return { ok: false, errors: c.errors, warnings: c.warnings, declaredVersion, ...base };
  }

  // 4. Semantic validation.
  semanticChecks(structural.data, c, indexMap);
  const ok = c.errors.length === 0;
  return { ok, document: ok ? structural.data : undefined, errors: c.errors, warnings: c.warnings, declaredVersion, ...base };
}

function semanticChecks(doc: PCODocument, c: Collector, itemIndexMap: number[]): void {
  const itemPath = (i: number) => ['items', itemIndexMap[i] ?? i] as Array<string | number>;

  // Calendar-valid timestamps (the schema only checks the format).
  const checkTs = (value: string | undefined, path: Array<string | number>) => {
    if (value !== undefined && !isCalendarValidTimestamp(value)) {
      c.error('invalid_timestamp', `"${value}" is not a valid calendar timestamp`, path);
    }
  };
  checkTs(doc.metadata.created_at, ['metadata', 'created_at']);
  checkTs(doc.metadata.updated_at, ['metadata', 'updated_at']);
  if (
    isCalendarValidTimestamp(doc.metadata.created_at) &&
    isCalendarValidTimestamp(doc.metadata.updated_at) &&
    Date.parse(doc.metadata.updated_at) < Date.parse(doc.metadata.created_at)
  ) {
    c.warn('timestamp_order', 'metadata.updated_at is earlier than metadata.created_at', ['metadata', 'updated_at']);
  }

  // One ID namespace for the whole document.
  const seen = new Map<string, string>();
  const claim = (id: string, path: Array<string | number>) => {
    const prev = seen.get(id);
    if (prev) c.error('duplicate_id', `id "${id}" is already used at ${prev}`, [...path, 'id']);
    else seen.set(id, path.join('.'));
  };
  seen.set(doc.id, 'id');

  const conversations = new Map<string, { index: number; turns: Map<string, { length: number }> }>();
  const turnOwner = new Map<string, string>();

  doc.conversations.forEach((conv, ci) => {
    const cPath = ['conversations', ci];
    claim(conv.id, cPath);
    checkTs(conv.captured_at, [...cPath, 'captured_at']);
    const turns = new Map<string, { length: number }>();
    const indices = new Set<number>();
    conv.turns.forEach((turn, ti) => {
      const tPath = [...cPath, 'turns', ti];
      claim(turn.id, tPath);
      checkTs(turn.timestamp, [...tPath, 'timestamp']);
      if (indices.has(turn.index)) {
        c.error('duplicate_turn_index', `turn index ${turn.index} appears more than once in conversation "${conv.id}"`, [...tPath, 'index']);
      }
      indices.add(turn.index);
      turns.set(turn.id, { length: turn.content.length });
      turnOwner.set(turn.id, conv.id);
    });
    conversations.set(conv.id, { index: ci, turns });
  });

  doc.items.forEach((item, i) => {
    const iPath = itemPath(i);
    claim(item.id, iPath);
    checkTs(item.created_at, [...iPath, 'created_at']);
    const p = item.provenance;
    const pPath = [...iPath, 'provenance'];
    checkTs(p.captured_at, [...pPath, 'captured_at']);

    let conv: { index: number; turns: Map<string, { length: number }> } | undefined;
    if (p.conversation_id !== undefined) {
      conv = conversations.get(p.conversation_id);
      if (!conv) {
        c.error('unknown_conversation', `provenance references conversation "${p.conversation_id}" which is not in this document`, [...pPath, 'conversation_id']);
      } else {
        const convSource = doc.conversations[conv.index].source;
        if (convSource.platform !== p.source.platform || convSource.kind !== p.source.kind) {
          c.warn(
            'source_mismatch',
            `provenance source ${p.source.kind}/${p.source.platform} differs from conversation source ${convSource.kind}/${convSource.platform}`,
            [...pPath, 'source'],
          );
        }
      }
    }

    let turnLength: number | undefined;
    if (p.turn_id !== undefined) {
      if (p.conversation_id === undefined) {
        c.error('turn_without_conversation', 'provenance.turn_id requires provenance.conversation_id', [...pPath, 'turn_id']);
      } else if (conv) {
        const t = conv.turns.get(p.turn_id);
        if (t) {
          turnLength = t.length;
        } else if (turnOwner.has(p.turn_id)) {
          c.error('turn_not_in_conversation', `turn "${p.turn_id}" belongs to conversation "${turnOwner.get(p.turn_id)}", not "${p.conversation_id}"`, [...pPath, 'turn_id']);
        } else {
          c.error('unknown_turn', `provenance references turn "${p.turn_id}" which is not in this document`, [...pPath, 'turn_id']);
        }
      }
    }

    if (p.span !== undefined) {
      if (p.turn_id === undefined) {
        c.error('span_without_turn', 'provenance.span requires provenance.turn_id', [...pPath, 'span']);
      } else if (p.span.end <= p.span.start) {
        c.error('invalid_span', `span end (${p.span.end}) must be greater than start (${p.span.start})`, [...pPath, 'span']);
      } else if (turnLength !== undefined && p.span.end > turnLength) {
        c.error('invalid_span', `span end (${p.span.end}) exceeds turn content length (${turnLength})`, [...pPath, 'span']);
      }
    }
  });
}

/** Validate and return the typed document, or throw `PcoValidationError`. */
export function assertValid(input: unknown): PCODocument {
  const result = validate(input);
  if (!result.ok || !result.document) throw new PcoValidationError(result.errors);
  return result.document;
}
