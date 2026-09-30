import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { existsSync } from 'node:fs';
import { PCO_VERSION } from '@cira/core';
import { defaultContextDir, FileContextStore } from '@cira/core/node';
import { cmdExport, cmdList, cmdMigrate, cmdSave, cmdValidate } from './commands/documents';
import { CliError, UsageError, type CliIO } from './io';
import { runHost } from './native/host';
import { applyInstall, applyUninstall, parseBrowser, planInstall, registryValue } from './native/install';

export const VERSION = '0.1.0';

export const HELP = `cira ${VERSION} — CIRA context layer CLI (PCO v${PCO_VERSION})

Usage:
  cira validate <file.pco.json> [--json]
  cira migrate  <legacy.json> [-o <out.pco.json>] [--stdout] [--save]
  cira export   <file.pco.json | id> [--format md|json|pco] [--types t1,t2] [--min-confidence 0..1] [--no-provenance] [-o <file>]
  cira save     <file.pco.json>
  cira list     [--json]
  cira native-host install --extension-id <id> [--extension-id <id2>] [--browser chrome|edge|chromium|brave] [--dry-run]
  cira native-host uninstall [--browser ...]
  cira native-host status [--browser ...]

Options:
  --dir <path>   Context store directory (default: $CIRA_HOME/contexts or ~/.cira/contexts)
  -h, --help     Show help
  -v, --version  Show version

Context types: fact, decision, constraint, preference, task, question, code_artifact, reference
Extraction is deterministic (code, links) + heuristic (keyword rules); see docs/pco/specification.md.
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  output: { type: 'string', short: 'o' },
  stdout: { type: 'boolean' },
  save: { type: 'boolean' },
  format: { type: 'string' },
  types: { type: 'string' },
  'min-confidence': { type: 'string' },
  'no-provenance': { type: 'boolean' },
  dir: { type: 'string' },
  'extension-id': { type: 'string', multiple: true },
  browser: { type: 'string' },
  'dry-run': { type: 'boolean' },
} satisfies ParseArgsConfig['options'];

function need(positionals: string[], index: number, what: string): string {
  const v = positionals[index];
  if (!v) throw new UsageError(`missing ${what}`);
  return v;
}

export interface RunOptions {
  /** Path of the running bundle, used by `native-host install`. */
  scriptPath?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  stdin?: NodeJS.ReadableStream;
  rawStdout?: NodeJS.WritableStream;
}

export async function run(argv: string[], io: CliIO, options: RunOptions = {}): Promise<number> {
  // Chrome launches the host as `<launcher> chrome-extension://<id>/ [--parent-window=N]`.
  if (argv[0] === 'native-host' && (argv.length === 1 || argv[1].startsWith('chrome-extension://') || argv[1].startsWith('--parent-window'))) {
    const store = new FileContextStore(defaultContextDir(io.env));
    io.stderr(`[cira native-host] started for ${argv[1] ?? 'unknown origin'}; store ${store.dir}\n`);
    await runHost(store, {
      input: options.stdin ?? process.stdin,
      output: options.rawStdout ?? process.stdout,
      log: (l) => io.stderr(`${l}\n`),
    });
    return 0;
  }

  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values: v, positionals: p } = parsed;

  if (v.version) {
    io.stdout(`cira ${VERSION} (PCO v${PCO_VERSION})\n`);
    return 0;
  }
  const command = p[0];
  if (v.help || !command || command === 'help') {
    io.stdout(HELP);
    return command || v.help ? 0 : 2;
  }

  switch (command) {
    case 'validate':
      return cmdValidate(io, { file: need(p, 1, '<file>'), json: !!v.json });
    case 'migrate':
      return cmdMigrate(io, { file: need(p, 1, '<legacy.json>'), output: v.output, stdout: !!v.stdout, save: !!v.save, dir: v.dir });
    case 'export':
      return cmdExport(io, {
        ref: need(p, 1, '<file or id>'),
        format: v.format ?? 'md',
        types: v.types,
        minConfidence: v['min-confidence'],
        output: v.output,
        provenance: !v['no-provenance'],
        dir: v.dir,
      });
    case 'save':
      return cmdSave(io, { file: need(p, 1, '<file>'), dir: v.dir });
    case 'list':
      return cmdList(io, { json: !!v.json, dir: v.dir });
    case 'native-host':
      return nativeHostCommand(p[1], v, io, options);
    default:
      throw new UsageError(`unknown command "${command}". Run \`cira --help\`.`);
  }
}

async function nativeHostCommand(
  sub: string | undefined,
  v: { 'extension-id'?: string[]; browser?: string; 'dry-run'?: boolean },
  io: CliIO,
  options: RunOptions,
): Promise<number> {
  const browser = parseBrowser(v.browser);
  const platform = options.platform ?? process.platform;
  const base = {
    browser,
    platform,
    env: io.env,
    nodePath: options.nodePath ?? process.execPath,
    scriptPath: options.scriptPath ?? fileURLToPath(import.meta.url),
  };

  if (sub === 'install') {
    const plan = planInstall({ ...base, extensionIds: v['extension-id'] ?? [] });
    for (const f of plan.files) io.stdout(`${v['dry-run'] ? 'would write' : 'write'} ${f.path}\n`);
    if (plan.registry) io.stdout(`${v['dry-run'] ? 'would set' : 'set'} ${plan.registry.key} = ${plan.registry.value}\n`);
    if (!v['dry-run']) {
      await applyInstall(plan);
      io.stdout(`\nInstalled the CIRA native host for ${browser}. Reload the extension, then capture a conversation.\nPCOs will be written to ${defaultContextDir(io.env)}\n`);
    }
    return 0;
  }

  // Paths do not depend on the extension ID; use a placeholder for planning.
  const plan = planInstall({ ...base, extensionIds: ['a'.repeat(32)] });
  if (sub === 'uninstall') {
    const removed = await applyUninstall(plan);
    io.stdout(removed.length ? removed.map((r) => `removed ${r}`).join('\n') + '\n' : 'Nothing to remove.\n');
    return 0;
  }
  if (sub === 'status') {
    const manifestOk = existsSync(plan.manifestPath);
    const launcherOk = existsSync(plan.launcherPath);
    const reg = plan.registry ? await registryValue(plan.registry.key) : undefined;
    io.stdout(
      [
        `browser:   ${browser}`,
        `manifest:  ${plan.manifestPath} ${manifestOk ? '(present)' : '(missing)'}`,
        `launcher:  ${plan.launcherPath} ${launcherOk ? '(present)' : '(missing)'}`,
        ...(plan.registry ? [`registry:  ${plan.registry.key} ${reg ? `→ ${reg}` : '(not set)'}`] : []),
        `store:     ${defaultContextDir(io.env)}`,
      ].join('\n') + '\n',
    );
    return manifestOk && launcherOk && (plan.registry ? !!reg : true) ? 0 : 1;
  }
  throw new UsageError('usage: cira native-host install|uninstall|status');
}

export async function main(argv: string[], io: CliIO, options?: RunOptions): Promise<number> {
  try {
    return await run(argv, io, options);
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(`error: ${err.message}\n`);
      if (err instanceof UsageError) io.stderr('Run `cira --help` for usage.\n');
      return err.exitCode;
    }
    io.stderr(`unexpected error: ${(err as Error).stack ?? String(err)}\n`);
    return 1;
  }
}
