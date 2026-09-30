/** validate / migrate / export / save / list — thin wrappers over @cira/core. */
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  CONTEXT_ITEM_TYPES,
  decode,
  formatIssue,
  getSemanticExtension,
  validateSemanticExtension,
  fromLegacyConversation,
  encode,
  isContextItemType,
  isLegacyConversation,
  parsePco,
  renderMarkdown,
  scanDocument,
  type ContextItemType,
  type ConversationInput,
  type PCODocument,
} from '@cira/core';
import { existsSync } from 'node:fs';
import { CliError, openStore, readJson, UsageError, type CliIO } from '../io';

export const CLI_AGENT = 'cira-cli@0.1.0';

export function reportSafety(io: CliIO, doc: PCODocument): void {
  const report = scanDocument(doc);
  if (!report.hasFindings) return;
  io.stderr(`\nSAFETY WARNING: ${report.findings.length} potential secret(s) detected in this context.\n`);
  for (const w of report.warnings) io.stderr(`  ${w}\n`);
  for (const f of report.findings.slice(0, 10)) {
    const where = f.location.kind === 'turn' ? `turn ${f.location.turn_index} of ${f.location.conversation_id}` : `item ${f.location.item_id}`;
    io.stderr(`  - ${f.type} (${f.confidence}) in ${where}: ${f.preview}\n`);
  }
  io.stderr('  CIRA secret detection is pattern-based and not exhaustive. Review before sharing.\n');
}

/** Read + upgrade + validate a PCO file. Throws CliError with a readable report. */
export async function loadPco(file: string, io: CliIO): Promise<PCODocument> {
  const raw = await readJson(file);
  const r = parsePco(raw);
  for (const w of r.warnings) io.stderr(`${formatIssue(w)}\n`);
  if (!r.ok || !r.document) {
    const hint = isLegacyConversation(raw) ? `\nThis looks like a legacy CIRA conversation export. Convert it with: cira migrate ${file}` : '';
    throw new CliError(`${file} is not a valid PCO document:\n${r.errors.map(formatIssue).join('\n')}${hint}`);
  }
  return r.document;
}

export async function cmdValidate(io: CliIO, args: { file: string; json: boolean }): Promise<number> {
  const file = resolve(io.cwd, args.file);
  const raw = await readJson(file);
  const r = parsePco(raw);
  if (args.json) {
    io.stdout(JSON.stringify({ ok: r.ok, declaredVersion: r.declaredVersion, supportedVersion: r.supportedVersion, errors: r.errors, warnings: r.warnings }, null, 2) + '\n');
    return r.ok ? 0 : 1;
  }
  for (const w of r.warnings) io.stdout(`${formatIssue(w)}\n`);
  if (!r.ok || !r.document) {
    for (const e of r.errors) io.stdout(`${formatIssue(e)}\n`);
    io.stdout(`INVALID: ${args.file} (${r.errors.length} error${r.errors.length === 1 ? '' : 's'})\n`);
    if (isLegacyConversation(raw)) io.stdout(`Hint: this is a legacy CIRA conversation. Convert it with: cira migrate ${args.file}\n`);
    return 1;
  }
  const d = r.document;
  io.stdout(
    `VALID: ${args.file}\n  PCO v${d.pco_version} · id ${d.id}\n  ${d.conversations.length} conversation(s), ${d.conversations.reduce((n, c) => n + c.turns.length, 0)} turn(s), ${d.items.length} context item(s)\n`,
  );
  // Semantic metadata is an extension: problems there are warnings, never PCO errors.
  const ext = getSemanticExtension(d);
  const semanticIssues = validateSemanticExtension(d);
  if (ext) io.stdout(`  semantic extension: mode ${ext.mode}, ${ext.extractors.map((e) => `${e.id}@${e.version}`).join(' + ')}\n`);
  for (const i of semanticIssues) io.stdout(`WARNING semantic_${i.code}: ${i.message}\n`);
  return 0;
}

function defaultMigrateOutput(inputFile: string): string {
  const base = basename(inputFile).replace(/\.json$/i, '');
  return join(dirname(inputFile), `${base}.pco.json`);
}

export async function cmdMigrate(
  io: CliIO,
  args: { file: string; output?: string; stdout: boolean; save: boolean; dir?: string },
): Promise<number> {
  const file = resolve(io.cwd, args.file);
  const raw = await readJson(file);
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) throw new CliError(`${args.file} contains no conversations`);

  const inputs: ConversationInput[] = [];
  const warnings: string[] = [];
  for (const [i, item] of list.entries()) {
    try {
      const r = fromLegacyConversation(item, { kind: 'browser' });
      inputs.push(r.input);
      warnings.push(...r.warnings);
    } catch (err) {
      throw new CliError(`${args.file}${Array.isArray(raw) ? `[${i}]` : ''}: ${(err as Error).message}`);
    }
  }
  const doc = encode(inputs, { createdBy: CLI_AGENT });
  const check = parsePco(doc);
  if (!check.ok) throw new CliError(`internal error: migrated document failed validation:\n${check.errors.map(formatIssue).join('\n')}`);

  for (const w of warnings) io.stderr(`warning: ${w}\n`);
  reportSafety(io, doc);

  if (args.stdout) {
    io.stdout(JSON.stringify(doc, null, 2) + '\n');
  } else {
    const out = args.output ? resolve(io.cwd, args.output) : defaultMigrateOutput(file);
    await writeFile(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    io.stdout(`Migrated ${list.length} legacy conversation(s) → ${out}\n  ${doc.items.length} context item(s), id ${doc.id}\n`);
  }
  if (args.save) {
    const store = openStore(io, args.dir);
    await store.put(doc);
    io.stderr(`Saved to ${store.pathFor(doc.id)}\n`);
  }
  return 0;
}

export function parseTypes(value: string | undefined): ContextItemType[] | undefined {
  if (!value) return undefined;
  const types = value.split(',').map((t) => t.trim()).filter(Boolean);
  const bad = types.filter((t) => !isContextItemType(t));
  if (bad.length) throw new UsageError(`unknown context type(s): ${bad.join(', ')}. Valid: ${CONTEXT_ITEM_TYPES.join(', ')}`);
  return types as ContextItemType[];
}

export async function resolveDocument(io: CliIO, ref: string, dir?: string): Promise<PCODocument> {
  const asFile = resolve(io.cwd, ref);
  if (existsSync(asFile)) return loadPco(asFile, io);
  const store = openStore(io, dir);
  const doc = await store.get(ref);
  if (!doc) throw new CliError(`no such file, and no stored context with id "${ref}" in ${store.dir}`);
  return doc;
}

export async function cmdExport(
  io: CliIO,
  args: { ref: string; format: string; types?: string; minConfidence?: string; output?: string; provenance: boolean; dir?: string },
): Promise<number> {
  if (!['md', 'markdown', 'json', 'pco'].includes(args.format)) throw new UsageError(`--format must be md, json or pco (got "${args.format}")`);
  const types = parseTypes(args.types);
  const minConfidence = args.minConfidence === undefined ? undefined : Number(args.minConfidence);
  if (minConfidence !== undefined && (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)) {
    throw new UsageError('--min-confidence must be a number between 0 and 1');
  }
  const doc = await resolveDocument(io, args.ref, args.dir);
  let text: string;
  if (args.format === 'pco') {
    text = JSON.stringify(doc, null, 2) + '\n';
  } else {
    const decoded = decode(doc, { types, minConfidence });
    text = args.format === 'json' ? JSON.stringify(decoded, null, 2) + '\n' : renderMarkdown(decoded, { provenance: args.provenance });
  }
  if (args.output) {
    const out = resolve(io.cwd, args.output);
    await writeFile(out, text, 'utf8');
    io.stderr(`Wrote ${out}\n`);
  } else {
    io.stdout(text);
  }
  return 0;
}

export async function cmdSave(io: CliIO, args: { file: string; dir?: string }): Promise<number> {
  const doc = await loadPco(resolve(io.cwd, args.file), io);
  reportSafety(io, doc);
  const store = openStore(io, args.dir);
  const summary = await store.put(doc);
  io.stdout(`Saved ${summary.id} → ${store.pathFor(summary.id)}\n  ${summary.item_count} context item(s) from ${summary.sources.join(', ') || 'no conversations'}\n`);
  return 0;
}

export async function cmdList(io: CliIO, args: { json: boolean; dir?: string }): Promise<number> {
  const store = openStore(io, args.dir);
  const list = await store.list();
  if (args.json) {
    io.stdout(JSON.stringify(list, null, 2) + '\n');
    return 0;
  }
  if (list.length === 0) {
    io.stdout(`No contexts in ${store.dir}\n`);
    return 0;
  }
  io.stdout(`${list.length} context(s) in ${store.dir}\n`);
  for (const s of list) {
    io.stdout(`  ${s.id}  ${s.updated_at}  ${s.item_count} items  ${s.sources.join(',')}  ${s.title ?? ''}\n`);
  }
  return 0;
}
