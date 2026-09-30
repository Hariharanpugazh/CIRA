/**
 * Portable Context Object (PCO) v0.1 — runtime schema.
 *
 * This file is the single source of truth for the PCO wire format. The
 * TypeScript types (`../types`) are inferred from it and the published JSON
 * Schema (`packages/pco/schema`) is generated from it.
 *
 * Wire format conventions:
 *  - snake_case field names
 *  - timestamps are ISO 8601 strings with an explicit offset (`Z` or ±hh:mm)
 *  - IDs are 1–128 chars of [A-Za-z0-9._-], starting alphanumeric, unique
 *    across the whole document (conversations, turns and items share one
 *    namespace)
 *  - objects are "loose": unknown fields are preserved so newer minor
 *    versions can add fields without breaking older readers. Prefer the
 *    namespaced top-level `extensions` object for implementation-specific data.
 */
import { z } from 'zod';

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const IdSchema = z
  .string()
  .regex(ID_PATTERN, 'must be 1-128 chars of [A-Za-z0-9._-] starting with a letter or digit')
  .describe('Document-unique identifier.');

export const TimestampSchema = z.iso
  .datetime({ offset: true })
  .describe('ISO 8601 timestamp with explicit UTC offset.');

export const VersionSchema = z
  .string()
  .regex(/^\d{1,4}\.\d{1,4}$/, 'must be "MAJOR.MINOR"')
  .describe('PCO specification version, "MAJOR.MINOR".');

// ── Source & provenance ───────────────────────────────────────────────────

export const SOURCE_KINDS = ['browser', 'ide', 'cli', 'agent', 'mobile', 'api', 'manual', 'unknown'] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);

/**
 * Where context came from. `platform` is an open string (e.g. "chatgpt",
 * "vscode", "claude-code"); Core deliberately does not enumerate platforms —
 * that knowledge belongs to connectors.
 */
export const SourceRefSchema = z.looseObject({
  kind: SourceKindSchema,
  platform: z.string().min(1).max(128),
  client: z.string().min(1).max(256).optional().describe('Connector that captured it, e.g. "cira-browser-extension@0.1.0".'),
});

export const EXTRACTION_METHODS = ['deterministic', 'heuristic', 'manual', 'model', 'migration'] as const;
export const ExtractionMethodSchema = z.enum(EXTRACTION_METHODS);

export const ExtractorRefSchema = z.looseObject({
  method: ExtractionMethodSchema,
  agent: z.string().min(1).max(256).describe('Extractor identity, e.g. "cira.heuristic-statements@0.1.0".'),
});

export const SpanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .describe('Half-open UTF-16 code unit range [start, end) within the referenced turn content.');

export const ProvenanceSchema = z.looseObject({
  source: SourceRefSchema,
  conversation_id: IdSchema.optional(),
  turn_id: IdSchema.optional(),
  span: SpanSchema.optional(),
  captured_at: TimestampSchema,
  extracted_by: ExtractorRefSchema,
});

// ── Conversations ─────────────────────────────────────────────────────────

export const ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export const RoleSchema = z.enum(ROLES);

export const AttachmentSchema = z.looseObject({
  kind: z.enum(['image', 'file', 'code']),
  name: z.string(),
  media_type: z.string().optional(),
  uri: z.string().optional(),
});

export const TurnSchema = z.looseObject({
  id: IdSchema,
  index: z.number().int().nonnegative(),
  role: RoleSchema,
  content: z.string(),
  timestamp: TimestampSchema.optional(),
  attachments: z.array(AttachmentSchema).optional(),
});

export const ConversationSchema = z.looseObject({
  id: IdSchema,
  source: SourceRefSchema,
  title: z.string().optional(),
  url: z.string().optional(),
  captured_at: TimestampSchema,
  turns: z.array(TurnSchema),
});

// ── Context items ─────────────────────────────────────────────────────────

export const CONTEXT_ITEM_TYPES = [
  'fact',
  'decision',
  'constraint',
  'preference',
  'task',
  'question',
  'code_artifact',
  'reference',
] as const;
export const ContextItemTypeSchema = z.enum(CONTEXT_ITEM_TYPES);

const itemBase = {
  id: IdSchema,
  content: z.string().min(1),
  provenance: ProvenanceSchema,
  confidence: z.number().min(0).max(1).describe('How reliable the extraction is (0..1). Rule-based estimate unless extracted_by.method says otherwise.'),
  importance: z.number().min(0).max(1).optional(),
  created_at: TimestampSchema,
  tags: z.array(z.string()).optional(),
};

export const FactSchema = z.looseObject({ ...itemBase, type: z.literal('fact') });

export const DecisionSchema = z.looseObject({
  ...itemBase,
  type: z.literal('decision'),
  status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']).optional(),
  rationale: z.string().optional(),
});

export const ConstraintSchema = z.looseObject({
  ...itemBase,
  type: z.literal('constraint'),
  strength: z.enum(['must', 'must_not', 'should', 'should_not']),
});

export const PreferenceSchema = z.looseObject({ ...itemBase, type: z.literal('preference') });

export const TaskSchema = z.looseObject({
  ...itemBase,
  type: z.literal('task'),
  status: z.enum(['open', 'in_progress', 'done', 'cancelled']),
});

export const QuestionSchema = z.looseObject({
  ...itemBase,
  type: z.literal('question'),
  status: z.enum(['open', 'answered']).optional(),
});

/** `content` holds the code itself. */
export const CodeArtifactSchema = z.looseObject({
  ...itemBase,
  type: z.literal('code_artifact'),
  language: z.string(),
  filename: z.string().optional(),
});

export const ReferenceSchema = z.looseObject({
  ...itemBase,
  type: z.literal('reference'),
  uri: z.string().min(1),
  title: z.string().optional(),
});

export const ContextItemSchema = z.discriminatedUnion('type', [
  FactSchema,
  DecisionSchema,
  ConstraintSchema,
  PreferenceSchema,
  TaskSchema,
  QuestionSchema,
  CodeArtifactSchema,
  ReferenceSchema,
]);

// ── Document ──────────────────────────────────────────────────────────────

export const MetadataSchema = z.looseObject({
  title: z.string().optional(),
  description: z.string().optional(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  created_by: z.looseObject({ agent: z.string().min(1) }).optional(),
  tags: z.array(z.string()).optional(),
});

export const PCODocumentSchema = z
  .looseObject({
    pco_version: VersionSchema,
    id: IdSchema,
    metadata: MetadataSchema,
    conversations: z.array(ConversationSchema),
    items: z.array(ContextItemSchema),
    extensions: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Namespaced implementation-specific data, e.g. { "cira.browser": {...} }.'),
  })
  .describe('CIRA Portable Context Object');
