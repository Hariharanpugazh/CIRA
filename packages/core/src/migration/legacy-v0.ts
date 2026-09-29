/**
 * Legacy CIRA conversation (pre-PCO, "v0") → PCO migration.
 *
 * v0 is the shape produced by the browser extension's DOM adapters, stored
 * in its IndexedDB history and emitted by the popup's "Export → JSON":
 *
 *   { source, title, url, capturedAt, messages: [{ role, content, code?, attachments? }] }
 *
 * The IndexedDB record variant (`codeBlocks`, `platform`, numeric `id`,
 * `tags`, `archived`) is accepted as well.
 *
 * Migration is lossless for text: message content is kept verbatim. Code
 * blocks that only exist in `code`/`codeBlocks` (not in the content) are
 * appended to the turn as fenced blocks so they become code artifacts.
 * Attachment `dataUrl` payloads are dropped (only name/type/URL are kept).
 */
import { z } from 'zod';
import { encode, type EncodeOptions } from '../encoder/encode';
import type { ConversationInput } from '../encoder/types';
import type { Attachment, PCODocument, SourceKind, Strict } from '../types';
import { isCalendarValidTimestamp } from '../validation/validate';

export const LegacyRoleV0Schema = z.enum(['user', 'assistant', 'system']);

export const LegacyCodeBlockV0Schema = z.looseObject({
  language: z.string(),
  code: z.string(),
});

export const LegacyMediaAttachmentV0Schema = z.looseObject({
  url: z.string(),
  type: z.enum(['image', 'file', 'code']),
  name: z.string(),
  mimeType: z.string(),
  dataUrl: z.string().optional(),
});

export const LegacyMessageV0Schema = z.looseObject({
  role: LegacyRoleV0Schema,
  content: z.string(),
  code: z.array(LegacyCodeBlockV0Schema).optional(),
  /** IndexedDB record variant. */
  codeBlocks: z.array(LegacyCodeBlockV0Schema).optional(),
  attachments: z.array(LegacyMediaAttachmentV0Schema).optional(),
});

export const LegacyConversationV0Schema = z.looseObject({
  source: z.string().min(1),
  /** IndexedDB record variant. */
  platform: z.string().optional(),
  title: z.string(),
  url: z.string(),
  capturedAt: z.string(),
  messages: z.array(LegacyMessageV0Schema),
});

export type LegacyRoleV0 = z.infer<typeof LegacyRoleV0Schema>;
export type LegacyCodeBlockV0 = Strict<z.infer<typeof LegacyCodeBlockV0Schema>>;
export type LegacyMediaAttachmentV0 = Strict<z.infer<typeof LegacyMediaAttachmentV0Schema>>;
export type LegacyMessageV0 = Strict<z.infer<typeof LegacyMessageV0Schema>>;
export type LegacyConversationV0 = Strict<z.infer<typeof LegacyConversationV0Schema>>;

export class LegacyMigrationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Not a legacy CIRA conversation:\n${issues.join('\n')}`);
    this.name = 'LegacyMigrationError';
    this.issues = issues;
  }
}

export function isLegacyConversation(value: unknown): value is LegacyConversationV0 {
  return LegacyConversationV0Schema.safeParse(value).success;
}

export interface LegacySourceOptions {
  kind?: SourceKind;
  /** Connector identity, e.g. "cira-browser-extension@0.1.0". */
  client?: string;
  /** Used when the legacy capturedAt is missing or invalid. */
  now?: Date | string;
}

export interface LegacyConversionResult {
  input: ConversationInput;
  warnings: string[];
}

function appendMissingCode(content: string, blocks: readonly LegacyCodeBlockV0[] | undefined): string {
  if (!blocks?.length) return content;
  let out = content;
  for (const b of blocks) {
    const code = b.code.replace(/\n$/, '');
    if (!code.trim() || out.includes(code.trim())) continue;
    out += `${out ? '\n\n' : ''}\`\`\`${b.language || ''}\n${code}\n\`\`\``;
  }
  return out;
}

function toAttachment(a: LegacyMediaAttachmentV0): Attachment {
  const att: Attachment = { kind: a.type, name: a.name, media_type: a.mimeType };
  if (a.url && !/^(data|blob):/i.test(a.url)) att.uri = a.url;
  return att;
}

/** Legacy conversation → encoder input. Validates the legacy shape first. */
export function fromLegacyConversation(raw: unknown, options: LegacySourceOptions = {}): LegacyConversionResult {
  const parsed = LegacyConversationV0Schema.safeParse(raw);
  if (!parsed.success) {
    throw new LegacyMigrationError(parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`));
  }
  const conv = parsed.data;
  const warnings: string[] = [];

  let capturedAt = conv.capturedAt;
  if (!isCalendarValidTimestamp(capturedAt)) {
    const reparsed = Date.parse(capturedAt);
    const fallback = Number.isNaN(reparsed)
      ? typeof options.now === 'string'
        ? options.now
        : (options.now ?? new Date()).toISOString()
      : new Date(reparsed).toISOString();
    warnings.push(`capturedAt ${JSON.stringify(capturedAt)} is not ISO 8601 with offset; using ${fallback}`);
    capturedAt = fallback;
  }

  let droppedData = 0;
  const input: ConversationInput = {
    source: {
      kind: options.kind ?? 'browser',
      platform: conv.platform && conv.source === 'unknown' ? conv.platform : conv.source,
      ...(options.client ? { client: options.client } : {}),
    },
    url: conv.url || undefined,
    title: conv.title || undefined,
    captured_at: capturedAt,
    turns: conv.messages.map((m) => {
      const attachments = m.attachments?.map((a) => {
        if (a.dataUrl) droppedData++;
        return toAttachment(a);
      });
      return {
        role: m.role,
        content: appendMissingCode(m.content, [...(m.code ?? []), ...(m.codeBlocks ?? [])]),
        ...(attachments?.length ? { attachments } : {}),
      };
    }),
  };
  if (droppedData) warnings.push(`dropped inline data for ${droppedData} attachment(s); names, types and URLs are kept`);
  return { input, warnings };
}

export interface LegacyMigrationResult {
  document: PCODocument;
  warnings: string[];
}

/** One-step migration: legacy conversation → validated-shape PCO document. */
export function migrateLegacyConversation(
  raw: unknown,
  options: LegacySourceOptions & EncodeOptions = {},
): LegacyMigrationResult {
  const { input, warnings } = fromLegacyConversation(raw, options);
  const document = encode(input, options);
  return { document, warnings };
}
