/**
 * `cira extract` and `cira eval`: run the Phase 02 extraction pipeline from
 * the command line, independently of the browser. Thin wrappers over
 * `@cira/core` (`extractContext`, `runFixture`).
 */
import { readdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  aggregateReports,
  createScriptedProvider,
  createSemanticExtractor,
  EXTRACTION_MODES,
  ExtractionError,
  extractContext,
  fromLegacyConversation,
  getSemanticExtension,
  isLegacyConversation,
  parseEvalFixture,
  parsePco,
  runFixture,
  scanForSecrets,
  selectTurns,
  TurnSelectionError,
  type ContextExtractor,
  type ConversationInput,
  type EvalFixture,
  type EvaluationReport,
  type ExtractionMode,
  type HttpTransport,
  type PCODocument,
} from '@cira/core';
import { CliError, openStore, readJson, UsageError, type CliIO } from '../io';
import { createCliSemanticExtractor, parseMessageSelection, type SemanticFlags } from '../semantic-config';
import { CLI_AGENT, reportSafety } from './documents';

export function parseMode(value: string | undefined): ExtractionMode {
  const mode = (value ?? 'deterministic') as ExtractionMode;
  if (!(EXTRACTION_MODES as readonly string[]).includes(mode)) throw new UsageError(`--mode must be one of ${EXTRACTION_MODES.join(', ')}`);
  return mode;
}

/** Legacy conversation(s) or a PCO document → encoder inputs. */
async function readConversations(file: string): Promise<{ inputs: ConversationInput[]; fromPco: boolean }> {
  const raw = await readJson(file);
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > 0 && list.every(isLegacyConversation)) {
    return { inputs: list.map((c) => fromLegacyConversation(c, { kind: 'browser' }).input), fromPco: false };
  }
  const r = parsePco(raw);
  if (r.ok && r.document) {
    const inputs = r.document.conversations.map((c): ConversationInput => ({
      id: c.id,
      source: c.source,
      captured_at: c.captured_at,
      ...(c.title ? { title: c.title } : {}),
      ...(c.url ? { url: c.url } : {}),
      turns: c.turns.map((t) => ({ role: t.role, content: t.content, index: t.index, ...(t.timestamp ? { timestamp: t.timestamp } : {}) })),
    }));
    return { inputs, fromPco: true };
  }
  throw new CliError(`${file} is neither a legacy CIRA conversation nor a valid PCO document`);
}

function defaultOutput(file: string, mode: ExtractionMode, fromPco: boolean): string {
  const base = basename(file).replace(/(\.pco)?\.json$/i, '');
  return join(dirname(file), fromPco ? `${base}.${mode}.pco.json` : `${base}.pco.json`);
}

function summarize(io: CliIO, doc: PCODocument): void {
  const byType: Record<string, number> = {};
  for (const i of doc.items) byType[i.type] = (byType[i.type] ?? 0) + 1;
  const ext = getSemanticExtension(doc);
  const byOrigin: Record<string, number> = {};
  if (ext) for (const a of Object.values(ext.items)) byOrigin[a.origin] = (byOrigin[a.origin] ?? 0) + 1;
  const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
  io.stderr(`  items: ${fmt(byType)}\n`);
  if (ext) io.stderr(`  origin: ${fmt(byOrigin)}${ext.relations.length ? ` · ${ext.relations.length} relation(s)` : ''}\n`);
}

export interface ExtractArgs extends SemanticFlags {
  file: string;
  mode?: string;
  messages?: string;
  output?: string;
  stdout: boolean;
  save: boolean;
  dir?: string;
  allowSecrets?: boolean;
}

export async function cmdExtract(io: CliIO, args: ExtractArgs, transport?: HttpTransport): Promise<number> {
  const mode = parseMode(args.mode);
  const file = resolve(io.cwd, args.file);
  const { inputs, fromPco } = await readConversations(file);
  if (args.messages && inputs.length !== 1) throw new UsageError('--messages needs an input with exactly one conversation');

  let selected: ConversationInput[];
  try {
    selected = args.messages ? [selectTurns(inputs[0], parseMessageSelection(args.messages))] : inputs;
  } catch (err) {
    if (err instanceof TurnSelectionError) throw new UsageError(err.message);
    throw err;
  }
  const selectedCount = selected.reduce((n, c) => n + c.turns.length, 0);

  let semantic: ContextExtractor | undefined;
  if (mode !== 'deterministic') {
    const setup = createCliSemanticExtractor(io, args, selectedCount, transport);
    // Secrets in the selection must not silently leave the machine.
    const secrets = selected.flatMap((c) => c.turns.flatMap((t) => scanForSecrets(t.content)));
    if (secrets.length && setup.provider.locality === 'remote' && !args.allowSecrets) {
      throw new CliError(`the selected messages contain ${secrets.length} potential secret(s); refusing to send them to ${setup.provider.endpointHost}. Remove them, deselect those messages, or pass --allow-secrets.`);
    }
    semantic = setup.extractor;
  }

  let result;
  try {
    result = await extractContext(selected, { mode, ...(semantic ? { semantic } : {}), createdBy: CLI_AGENT });
  } catch (err) {
    if (err instanceof ExtractionError) throw new CliError(`${mode} extraction failed: ${err.message}`);
    throw err;
  }
  const doc = result.document;

  for (const d of result.diagnostics) {
    if (d.level !== 'info' || d.code === 'summary') io.stderr(`${d.level}: ${d.code}: ${d.message}\n`);
  }
  if (result.fallback) io.stderr('warning: semantic extraction failed; the output contains deterministic items only\n');
  reportSafety(io, doc);

  if (args.stdout) {
    io.stdout(JSON.stringify(doc, null, 2) + '\n');
  } else {
    const out = args.output ? resolve(io.cwd, args.output) : defaultOutput(file, mode, fromPco);
    await writeFile(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    io.stdout(`Extracted (${mode}) ${result.selectedMessages} message(s) → ${out}\n  ${doc.items.length} context item(s), id ${doc.id}\n`);
  }
  summarize(io, doc);
  if (args.save) {
    const store = openStore(io, args.dir);
    await store.put(doc);
    io.stderr(`Saved to ${store.pathFor(doc.id)}\n`);
  }
  return 0;
}

// ── eval ──────────────────────────────────────────────────────────────────

export interface EvalArgs extends SemanticFlags {
  paths: string[];
  mode?: string;
  /** Directory of recorded model outputs named `<fixture-id>.json` (scripted replay). */
  replay?: string;
  json: boolean;
}

function collectFixtureFiles(io: CliIO, paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    const abs = resolve(io.cwd, p);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new CliError(`not found: ${p}`);
    }
    if (st.isDirectory()) {
      files.push(...readdirSync(abs).filter((f) => f.endsWith('.eval.json')).sort().map((f) => join(abs, f)));
    } else {
      files.push(abs);
    }
  }
  if (files.length === 0) throw new CliError('no *.eval.json fixtures found');
  return files;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`.padStart(7);

export async function cmdEval(io: CliIO, args: EvalArgs, transport?: HttpTransport): Promise<number> {
  const mode = parseMode(args.mode);
  const fixtures: EvalFixture[] = [];
  for (const f of collectFixtureFiles(io, args.paths)) {
    try {
      fixtures.push(parseEvalFixture(await readJson(f)));
    } catch (err) {
      throw new CliError(`${f}: invalid evaluation fixture (${(err as Error).message.split('\n')[0]})`);
    }
  }

  let shared: ContextExtractor | undefined;
  if (mode !== 'deterministic' && !args.replay) {
    shared = createCliSemanticExtractor(io, args, fixtures.reduce((n, f) => n + (f.selection?.length ?? 0), 0) || fixtures.length, transport).extractor;
  }

  const reports: EvaluationReport[] = [];
  let failed = 0;
  for (const f of fixtures) {
    let semantic = shared;
    if (mode !== 'deterministic' && args.replay) {
      const recorded = await readFile(join(resolve(io.cwd, args.replay), `${f.id}.json`), 'utf8').catch(() => {
        throw new CliError(`no recorded output for fixture ${f.id} in ${args.replay}`);
      });
      semantic = createSemanticExtractor({ provider: createScriptedProvider(recorded, { model: 'replay' }) });
    }
    try {
      reports.push((await runFixture(f, { mode, ...(semantic ? { semantic } : {}) })).report);
    } catch (err) {
      failed++;
      io.stderr(`error: ${f.id}: ${(err as Error).message}\n`);
    }
  }
  const total = aggregateReports(reports);

  if (args.json) {
    io.stdout(JSON.stringify({ mode, fixtures: reports, failed, total: reports.length ? total : null }, null, 2) + '\n');
  } else {
    io.stdout(`mode: ${mode}${args.replay ? ' (replay)' : ''}\n`);
    io.stdout(`${'fixture'.padEnd(24)}${'prec'.padStart(7)}${'recall'.padStart(7)}${'F1'.padStart(7)}${'attrib'.padStart(7)}${'prov'.padStart(7)}  unsup  forbid\n`);
    const row = (name: string, r: { metrics: EvaluationReport['metrics']; counts: EvaluationReport['counts'] }) =>
      `${name.padEnd(24)}${pct(r.metrics.precision)}${pct(r.metrics.recall)}${pct(r.metrics.f1)}${pct(r.metrics.attribution_accuracy)}${pct(r.metrics.provenance_accuracy)}  ${String(r.counts.unsupported).padStart(5)}  ${String(r.counts.forbidden).padStart(6)}\n`;
    for (const r of reports) io.stdout(row(r.fixture, r));
    if (reports.length) io.stdout(row('TOTAL (micro)', total));
    else io.stdout(`${'TOTAL (micro)'.padEnd(24)}n/a (no fixture completed)\n`);
    if (failed) io.stdout(`${failed} of ${fixtures.length} fixture(s) failed and are not included in the totals.\n`);
    for (const r of reports) for (const x of r.forbidden) io.stdout(`  forbidden in ${r.fixture}: ${x.reason}\n`);
  }
  return failed ? 1 : 0;
}
