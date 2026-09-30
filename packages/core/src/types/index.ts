/**
 * PCO TypeScript types, inferred from the runtime schema so the two can never
 * drift apart.
 */
import type { z } from 'zod';
import type {
  AttachmentSchema,
  CodeArtifactSchema,
  ConstraintSchema,
  ContextItemSchema,
  ConversationSchema,
  DecisionSchema,
  ExtractorRefSchema,
  FactSchema,
  MetadataSchema,
  PCODocumentSchema,
  PreferenceSchema,
  ProvenanceSchema,
  QuestionSchema,
  ReferenceSchema,
  SourceRefSchema,
  SpanSchema,
  TaskSchema,
  TurnSchema,
} from '../pco/schema';
import type { CONTEXT_ITEM_TYPES, EXTRACTION_METHODS, ROLES, SOURCE_KINDS } from '../pco/schema';

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type LiteralKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: 0 };

/**
 * Runtime schemas are "loose" (unknown fields are preserved for forward
 * compatibility), which makes Zod infer `[key: string]: unknown` index
 * signatures. `Strict<T>` removes those so the public types stay precise
 * (typos are compile errors, `Omit` works). Pure records such as
 * `extensions: Record<string, unknown>` are kept as-is.
 */
export type Strict<T> = T extends Primitive
  ? T
  : T extends ReadonlyArray<infer U>
    ? Strict<U>[]
    : T extends object
      ? [LiteralKeys<T>] extends [never]
        ? T
        : { [K in keyof T as string extends K ? never : number extends K ? never : K]: Strict<T[K]> }
      : T;

type Infer<S extends z.ZodType> = Strict<z.infer<S>>;

export type SourceKind = (typeof SOURCE_KINDS)[number];
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];
export type Role = (typeof ROLES)[number];
export type ContextItemType = (typeof CONTEXT_ITEM_TYPES)[number];

export type SourceRef = Infer<typeof SourceRefSchema>;
export type ExtractorRef = Infer<typeof ExtractorRefSchema>;
export type Span = Infer<typeof SpanSchema>;
export type Provenance = Infer<typeof ProvenanceSchema>;
export type Attachment = Infer<typeof AttachmentSchema>;
export type Turn = Infer<typeof TurnSchema>;
export type PcoConversation = Infer<typeof ConversationSchema>;
export type PcoMetadata = Infer<typeof MetadataSchema>;

export type Fact = Infer<typeof FactSchema>;
export type Decision = Infer<typeof DecisionSchema>;
export type Constraint = Infer<typeof ConstraintSchema>;
export type Preference = Infer<typeof PreferenceSchema>;
export type Task = Infer<typeof TaskSchema>;
export type Question = Infer<typeof QuestionSchema>;
export type CodeArtifact = Infer<typeof CodeArtifactSchema>;
export type Reference = Infer<typeof ReferenceSchema>;

/** Discriminated union over `type`. */
export type ContextItem = Infer<typeof ContextItemSchema>;
export type ContextItemOf<T extends ContextItemType> = Extract<ContextItem, { type: T }>;

export type PCODocument = Infer<typeof PCODocumentSchema>;

/** `Omit` that distributes over unions (keeps the discriminant intact). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
