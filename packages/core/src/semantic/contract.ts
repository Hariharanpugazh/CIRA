/**
 * Semantic extraction contract.
 *
 * 1. `ModelOutputSchema` — the ONLY shape a semantic provider may return
 *    (strict JSON; also exported as JSON Schema for structured-output APIs).
 * 2. `normalizeModelOutput()` — deterministic post-processing that turns
 *    validated model output into PCO candidates:
 *      - resolves every evidence quote to a real turn + span (no evidence → no item)
 *      - derives `origin` from the speaker of the evidence turn (the model's
 *        claim is only a hint)
 *      - applies attribution rules so assistant suggestions can never become
 *        user requirements or preferences
 *      - builds PCO provenance (conversation, turn, span, capture time, extractor)
 *
 * Output that does not match the schema is rejected as a whole
 * (`ContractError`); individual items that break the rules are dropped with
 * diagnostics. Diagnostics never contain conversation text.
 */
import { z } from 'zod';
import { CONTEXT_ITEM_TYPES } from '../pco/schema';
import { createProvenance } from '../provenance';
import type { ContextItem, ContextItemType, PcoConversation, Turn } from '../types';
import { makeId } from '../util/hash';
import { AssertionSchema, OriginSchema, type Assertion, type Evidence, type ExtractorInfo, type Origin, type SemanticAnnotation } from './annotations';
import { locateQuote } from './evidence';
import { extractorRef, type ExtractionDiagnostic } from './types';

// ── 1. Model-facing schema ────────────────────────────────────────────────

const STATUSES = ['proposed', 'accepted', 'rejected', 'superseded', 'open', 'in_progress', 'done', 'cancelled', 'answered'] as const;

export const ModelEvidenceSchema = z.object({
  /** Message reference exactly as given in the prompt, e.g. "m3". */
  message: z.string().min(1).max(16),
  /** Verbatim text copied from that message. */
  quote: z.string().min(1).max(2000),
});

export const ModelItemSchema = z.object({
  ref: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  type: z.enum(CONTEXT_ITEM_TYPES),
  content: z.string().min(1).max(2000),
  origin: OriginSchema,
  assertion: AssertionSchema,
  confidence: z.number().min(0).max(1),
  strength: z.enum(['must', 'must_not', 'should', 'should_not']).nullable(),
  status: z.enum(STATUSES).nullable(),
  language: z.string().max(40).nullable(),
  filename: z.string().max(260).nullable(),
  uri: z.string().max(2000).nullable(),
  title: z.string().max(300).nullable(),
  evidence: z.array(ModelEvidenceSchema).max(8),
});

export const ModelRelationSchema = z.object({
  type: z.enum(['supersedes', 'conflicts_with']),
  from: z.string().min(1).max(32),
  to: z.string().min(1).max(32),
});

export const ModelOutputSchema = z.object({
  items: z.array(ModelItemSchema).max(200),
  relations: z.array(ModelRelationSchema).max(200),
});

export type ModelItem = z.infer<typeof ModelItemSchema>;
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

type JsonObject = Record<string, unknown>;

/** Every object: all properties required, no additional properties (OpenAI "strict" rules). */
function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== 'object') return node;
  const o: JsonObject = {};
  for (const [k, v] of Object.entries(node as JsonObject)) o[k] = strictify(v);
  if (o.type === 'object' && o.properties && typeof o.properties === 'object') {
    o.required = Object.keys(o.properties as JsonObject);
    o.additionalProperties = false;
  }
  return o;
}

/** JSON Schema for structured-output APIs (strict-mode compatible). */
export function modelOutputJsonSchema(): JsonObject {
  const s = z.toJSONSchema(ModelOutputSchema, { target: 'draft-7' }) as JsonObject;
  delete s.$schema;
  return strictify(s) as JsonObject;
}

export class ContractError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'ContractError';
    this.issues = issues;
  }
}

/** Parse raw provider text → validated ModelOutput. Throws ContractError. */
export function parseModelOutput(raw: string): ModelOutput {
  let json: unknown;
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    json = JSON.parse(text);
  } catch {
    throw new ContractError('semantic provider returned invalid JSON');
  }
  const r = ModelOutputSchema.safeParse(json);
  if (!r.success) {
    // Paths and messages only; never echo values (they may contain conversation text).
    throw new ContractError(
      'semantic provider output does not match the extraction schema',
      r.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '$'}: ${i.code}`),
    );
  }
  return r.data;
}

// ── 2. Normalisation ──────────────────────────────────────────────────────

export type EvidencePolicy = 'strict' | 'lenient';

export interface NormalizeOptions {
  extractor: ExtractorInfo;
  now: string;
  /**
   * strict (default): an item whose quotes cannot be located in the selected
   * messages is rejected. lenient: kept with confidence ≤ 0.4 if at least its
   * message reference is valid.
   */
  evidencePolicy?: EvidencePolicy;
}

export interface NormalizedResult {
  items: ContextItem[];
  annotations: Record<string, SemanticAnnotation>;
  relations: Array<{ type: 'supersedes' | 'conflicts_with'; from: string; to: string }>;
  diagnostics: ExtractionDiagnostic[];
}

/** Message reference used in prompts for a turn: "m" + original index. */
export function messageRef(turn: Pick<Turn, 'index'>): string {
  return `m${turn.index}`;
}

const DECISION_STATUS = new Set(['proposed', 'accepted', 'rejected', 'superseded']);
const TASK_STATUS = new Set(['open', 'in_progress', 'done', 'cancelled']);
const QUESTION_STATUS = new Set(['open', 'answered']);

interface Candidate {
  type: ContextItemType;
  origin: Origin;
  assertion: Assertion;
  status: string | null;
}

/**
 * Attribution rules. Deterministic; applied after `origin` has been derived
 * from the evidence turn. Returns the adjusted candidate and a reason when
 * something changed.
 */
export function applyAttributionRules(c: Candidate): { candidate: Candidate; reason?: string } {
  const { type, origin } = c;
  // Only the user (or a system prompt) can impose requirements or hold preferences.
  if ((type === 'constraint' || type === 'preference') && origin === 'assistant') {
    return { candidate: { ...c, type: 'decision', status: 'proposed', assertion: 'suggested' }, reason: `assistant ${type} recorded as a proposed decision` };
  }
  // Tool output is information, not intent.
  if ((type === 'constraint' || type === 'preference' || type === 'decision' || type === 'task') && origin === 'tool') {
    return { candidate: { ...c, type: 'fact', status: null, assertion: 'quoted' }, reason: `tool ${type} recorded as a quoted fact` };
  }
  // The assistant can propose, never accept on the user's behalf.
  if (type === 'decision' && origin === 'assistant' && c.status !== 'proposed' && c.status !== 'rejected') {
    return { candidate: { ...c, status: 'proposed', assertion: c.assertion === 'quoted' ? 'quoted' : 'suggested' }, reason: 'assistant decision recorded as proposed' };
  }
  if (type === 'decision' && c.status === 'accepted' && origin !== 'user' && origin !== 'system') {
    return { candidate: { ...c, status: 'proposed' }, reason: 'only the user can accept a decision' };
  }
  return { candidate: c };
}

function diag(level: ExtractionDiagnostic['level'], code: string, message: string, ref?: string): ExtractionDiagnostic {
  return ref ? { level, code, message, ref } : { level, code, message };
}

export function normalizeModelOutput(output: ModelOutput, conversation: PcoConversation, options: NormalizeOptions): NormalizedResult {
  const policy = options.evidencePolicy ?? 'strict';
  const agent = extractorRef(options.extractor);
  const byRef = new Map(conversation.turns.map((t) => [messageRef(t), t] as const));
  const diagnostics: ExtractionDiagnostic[] = [];
  const items: ContextItem[] = [];
  const annotations: Record<string, SemanticAnnotation> = {};
  const refToId = new Map<string, string>();

  for (const m of output.items) {
    if (refToId.has(m.ref)) {
      diagnostics.push(diag('warning', 'duplicate_ref', `item ${m.ref} appears more than once; later copy dropped`, m.ref));
      continue;
    }

    // Evidence: resolve message refs + quotes against the SELECTED turns only.
    const located: Array<{ turn: Turn; span?: { start: number; end: number } }> = [];
    let unknownRefs = 0;
    for (const ev of m.evidence) {
      const turn = byRef.get(ev.message.trim());
      if (!turn) {
        unknownRefs++;
        continue;
      }
      const span = locateQuote(turn.content, ev.quote);
      located.push(span ? { turn, span } : { turn });
    }
    if (unknownRefs) diagnostics.push(diag('warning', 'unknown_message_ref', `item ${m.ref} cites ${unknownRefs} message(s) outside the selection`, m.ref));

    const verified = located.filter((e) => e.span);
    if (m.evidence.length === 0) {
      diagnostics.push(diag('warning', 'missing_evidence', `item ${m.ref} rejected: no evidence`, m.ref));
      continue;
    }
    if (verified.length === 0 && (policy === 'strict' || located.length === 0)) {
      diagnostics.push(diag('warning', 'unsupported_item', `item ${m.ref} rejected: evidence not found in the selected messages`, m.ref));
      continue;
    }
    const evidence = verified.length ? verified : located;
    const primary = evidence[0];

    // Attribution: the speaker of the evidence turn.
    const derived: Origin = primary.turn.role;
    if (m.origin !== derived) {
      diagnostics.push(diag('info', 'origin_corrected', `item ${m.ref}: origin ${m.origin} corrected to ${derived} (speaker of the evidence)`, m.ref));
    }
    const { candidate, reason } = applyAttributionRules({ type: m.type, origin: derived, assertion: m.assertion, status: m.status });
    if (reason) diagnostics.push(diag('info', 'attribution_rule', `item ${m.ref}: ${reason}`, m.ref));

    // Confidence caps.
    let confidence = m.confidence;
    if (candidate.assertion === 'inferred') confidence = Math.min(confidence, 0.8);
    if (verified.length === 0) confidence = Math.min(confidence, 0.4);

    // Type-specific fields.
    const content = m.content.trim();
    const base = { content, confidence };
    let draft: Record<string, unknown>;
    switch (candidate.type) {
      case 'constraint':
        if (!m.strength) {
          diagnostics.push(diag('warning', 'missing_field', `item ${m.ref} rejected: constraint without strength`, m.ref));
          continue;
        }
        draft = { ...base, type: 'constraint', strength: m.strength };
        break;
      case 'decision':
        draft = { ...base, type: 'decision', ...(candidate.status && DECISION_STATUS.has(candidate.status) ? { status: candidate.status } : {}) };
        break;
      case 'task':
        draft = { ...base, type: 'task', status: candidate.status && TASK_STATUS.has(candidate.status) ? candidate.status : 'open' };
        break;
      case 'question':
        draft = { ...base, type: 'question', ...(candidate.status && QUESTION_STATUS.has(candidate.status) ? { status: candidate.status } : {}) };
        break;
      case 'code_artifact':
        draft = { ...base, type: 'code_artifact', language: (m.language ?? 'text').toLowerCase() || 'text', ...(m.filename ? { filename: m.filename } : {}) };
        break;
      case 'reference': {
        const uri = m.uri ?? (/^https?:\/\/\S+$/.test(content) ? content : null);
        if (!uri) {
          diagnostics.push(diag('warning', 'missing_field', `item ${m.ref} rejected: reference without uri`, m.ref));
          continue;
        }
        draft = { ...base, type: 'reference', uri, ...(m.title ? { title: m.title } : {}) };
        break;
      }
      default:
        draft = { ...base, type: candidate.type };
    }

    const span = primary.span;
    const id = makeId('itm', agent, primary.turn.id, candidate.type, span?.start, span?.end, content);
    if (annotations[id]) {
      diagnostics.push(diag('info', 'duplicate_item', `item ${m.ref} duplicates an earlier item; dropped`, m.ref));
      refToId.set(m.ref, id);
      continue;
    }
    const provenance = createProvenance({ conversation, turn: primary.turn, span, method: 'model', agent });
    items.push({ ...draft, id, provenance, created_at: options.now } as ContextItem);
    const ev: Evidence[] = evidence.map((e) => ({ turn_id: e.turn.id, ...(e.span ? { span: e.span } : {}) }));
    annotations[id] = { origin: candidate.origin, assertion: candidate.assertion, evidence: ev, extractors: [agent] };
    refToId.set(m.ref, id);
  }

  const relations: NormalizedResult['relations'] = [];
  for (const r of output.relations) {
    const from = refToId.get(r.from);
    const to = refToId.get(r.to);
    if (!from || !to || from === to) {
      diagnostics.push(diag('info', 'relation_dropped', `relation ${r.type} ${r.from}→${r.to} dropped: unknown or rejected item`));
      continue;
    }
    relations.push({ type: r.type, from, to });
  }
  return { items, annotations, relations, diagnostics };
}
