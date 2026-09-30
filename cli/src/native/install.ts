/**
 * `cira native-host install|uninstall|status`: registers the local host with
 * Chromium-based browsers for ONE extension ID.
 *
 * Writes (under $CIRA_HOME/native-host):
 *   com.cira.context_host.json   host manifest (allowed_origins = your extension only)
 *   cira-native-host.cmd | .sh   launcher that runs `node <cira.js> native-host`
 * and registers the manifest:
 *   Windows: HKCU\Software\<browser>\NativeMessagingHosts\com.cira.context_host (per-user, no admin)
 *   macOS/Linux: copies the manifest into the browser's per-user NativeMessagingHosts dir
 *
 * Windows launch path: Chromium starts every native host, `.cmd` or `.exe`, as
 *   %ComSpec% /d /s /c ""<manifest path>" chrome-extension://<id>/ --parent-window=<n>"
 * with stdin/stdout connected to pipes. It reads ComSpec from its own environment
 * and refuses to launch anything when the variable is missing ("COMSPEC is not
 * set" in Chrome's log, "Failed to start native messaging host." in the
 * extension). Launching .exe hosts directly is only behind the non-default
 * LaunchWindowsNativeHostsDirectly feature / NativeHostsExecutablesLaunchDirectly
 * policy, so an .exe wrapper does not remove that dependency. `install`
 * therefore checks the persistent ComSpec and, when it is missing or broken,
 * sets the per-user value to the standard `%SystemRoot%\System32\cmd.exe`.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { LOCAL_HOST_NAME } from '@cira/core';
import { defaultCiraHome } from '@cira/core/node';
import { CliError, UsageError } from '../io';

const run = promisify(execFile);

/** Runs a program with an argument array (never through a shell). Injectable for tests. */
export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;
const defaultExec: Exec = async (file, args) => {
  const { stdout } = await run(file, args, { windowsHide: true });
  return { stdout: String(stdout) };
};

export const BROWSERS = ['chrome', 'edge', 'chromium', 'brave'] as const;
export type Browser = (typeof BROWSERS)[number];

const EXTENSION_ID = /^[a-p]{32}$/;

const WINDOWS_KEYS: Record<Browser, string> = {
  chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  brave: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
};

function unixManifestDir(browser: Browser, platform: NodeJS.Platform, home: string): string {
  if (platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support');
    return {
      chrome: join(base, 'Google', 'Chrome', 'NativeMessagingHosts'),
      edge: join(base, 'Microsoft Edge', 'NativeMessagingHosts'),
      chromium: join(base, 'Chromium', 'NativeMessagingHosts'),
      brave: join(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    }[browser];
  }
  const base = join(home, '.config');
  return {
    chrome: join(base, 'google-chrome', 'NativeMessagingHosts'),
    edge: join(base, 'microsoft-edge', 'NativeMessagingHosts'),
    chromium: join(base, 'chromium', 'NativeMessagingHosts'),
    brave: join(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
  }[browser];
}

export interface InstallInput {
  extensionIds: string[];
  browser: Browser;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  /** Absolute path to the bundled cli/dist/cira.js. */
  scriptPath: string;
  home?: string;
  /** Windows only: persistent ComSpec values (see readComSpecState). */
  comspec?: ComSpecState;
}

export interface InstallPlan {
  hostDir: string;
  manifestPath: string;
  launcherPath: string;
  files: Array<{ path: string; content: string; mode?: number }>;
  registry?: { key: string; value: string };
  /** Windows only: result of the ComSpec check. */
  comspec?: ComSpecCheck;
}

// ---------------------------------------------------------------------------
// Windows: ComSpec, which Chromium needs to start any native host
// ---------------------------------------------------------------------------

const USER_ENV_KEY = 'HKCU\\Environment';
const MACHINE_ENV_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

/** Persistent (registry) ComSpec values. New processes, Chrome included, get user ?? machine. */
export interface ComSpecState {
  user?: string;
  machine?: string;
}

export interface ComSpecCheck {
  /** Chrome started from a fresh login/Explorer will have a usable ComSpec. */
  ok: boolean;
  /** Effective persistent value, expanded. */
  value?: string;
  /** What `install` sets when it is missing or broken (per-user, no admin). */
  fix?: { name: 'ComSpec'; value: string; reason: string };
  /** Present and usable but not cmd.exe: left alone, reported. */
  warning?: string;
}

/** Expand %VAR% references the way Windows does for REG_EXPAND_SZ (case-insensitive names). */
export function expandWindowsEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key !== undefined && env[key] !== undefined ? String(env[key]) : whole;
  });
}

export function standardComSpec(env: NodeJS.ProcessEnv): string {
  const root = expandWindowsEnv('%SystemRoot%', env);
  const base = root.startsWith('%') ? expandWindowsEnv('%windir%', env) : root;
  return win32.join(base.startsWith('%') ? 'C:\\Windows' : base, 'System32', 'cmd.exe');
}

export function checkComSpec(state: ComSpecState, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = existsSync): ComSpecCheck {
  const expected = standardComSpec(env);
  const raw = state.user ?? state.machine;
  if (!raw) {
    return {
      ok: false,
      fix: { name: 'ComSpec', value: expected, reason: 'ComSpec is not set, so Chrome cannot start native messaging hosts ("COMSPEC is not set")' },
    };
  }
  const value = expandWindowsEnv(raw, env);
  if (!exists(value)) {
    return { ok: false, value, fix: { name: 'ComSpec', value: expected, reason: `ComSpec points at ${value}, which does not exist` } };
  }
  if (basename(value.replace(/\\/g, '/')).toLowerCase() !== 'cmd.exe') {
    return { ok: true, value, warning: `ComSpec is ${value}, not cmd.exe; Chrome launches native hosts through it and may fail` };
  }
  return { ok: true, value };
}

function parseRegValue(stdout: string, name: string): string | undefined {
  const m = new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\s*$`, 'im').exec(stdout);
  return m?.[1] || undefined;
}

/** Read ComSpec from the user and machine environment in the registry. */
export async function readComSpecState(exec: Exec = defaultExec): Promise<ComSpecState> {
  const read = async (key: string) => {
    try {
      return parseRegValue((await exec('reg', ['query', key, '/v', 'ComSpec'])).stdout, 'ComSpec');
    } catch {
      return undefined; // value (or key) does not exist
    }
  };
  const [user, machine] = await Promise.all([read(USER_ENV_KEY), read(MACHINE_ENV_KEY)]);
  return { ...(user ? { user } : {}), ...(machine ? { machine } : {}) };
}

/**
 * Batch-file line for one argument. Paths are quoted (spaces, `&`, `(`); `%`
 * is doubled because cmd expands it even inside quotes in a .cmd file.
 */
function batchQuote(value: string): string {
  if (value.includes('"')) throw new CliError(`path contains a double quote: ${value}`);
  return `"${value.replace(/%/g, '%%')}"`;
}

/** Windows launcher: no shell features beyond running one program with absolute paths. */
export function windowsLauncher(nodePath: string, scriptPath: string): string {
  return `@echo off\r\n${batchQuote(nodePath)} ${batchQuote(scriptPath)} native-host %*\r\n`;
}

export function parseBrowser(value: string | undefined): Browser {
  const b = (value ?? 'chrome').toLowerCase();
  if (!(BROWSERS as readonly string[]).includes(b)) throw new UsageError(`--browser must be one of ${BROWSERS.join(', ')}`);
  return b as Browser;
}

export function planInstall(input: InstallInput): InstallPlan {
  if (input.extensionIds.length === 0) throw new UsageError('--extension-id is required (find it on chrome://extensions with Developer mode on)');
  for (const id of input.extensionIds) {
    if (!EXTENSION_ID.test(id)) throw new UsageError(`"${id}" is not a Chrome extension ID (32 letters a-p)`);
  }
  if (!/\.m?js$/.test(input.scriptPath)) {
    throw new CliError(`native host must run the built CLI (cli/dist/cira.js), not ${input.scriptPath}. Run \`pnpm --filter @cira/cli build\` first.`);
  }
  const home = input.home ?? homedir();
  const hostDir = join(defaultCiraHome(input.env), 'native-host');
  const windows = input.platform === 'win32';
  const launcherPath = join(hostDir, windows ? 'cira-native-host.cmd' : 'cira-native-host.sh');
  const launcher = windows
    ? windowsLauncher(input.nodePath, input.scriptPath)
    : `#!/bin/sh\nexec "${input.nodePath}" "${input.scriptPath}" native-host "$@"\n`;

  const manifest = {
    name: LOCAL_HOST_NAME,
    description: 'CIRA local context host: saves Portable Context Objects to ~/.cira/contexts',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: input.extensionIds.map((id) => `chrome-extension://${id}/`),
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  const localManifest = join(hostDir, `${LOCAL_HOST_NAME}.json`);

  const files: InstallPlan['files'] = [
    { path: launcherPath, content: launcher, mode: windows ? undefined : 0o755 },
    { path: localManifest, content: manifestJson },
  ];
  if (windows) {
    return {
      hostDir,
      manifestPath: localManifest,
      launcherPath,
      files,
      registry: { key: `${WINDOWS_KEYS[input.browser]}\\${LOCAL_HOST_NAME}`, value: localManifest },
      ...(input.comspec ? { comspec: checkComSpec(input.comspec, input.env) } : {}),
    };
  }
  const browserManifest = join(unixManifestDir(input.browser, input.platform, home), `${LOCAL_HOST_NAME}.json`);
  files.push({ path: browserManifest, content: manifestJson });
  return { hostDir, manifestPath: browserManifest, launcherPath, files };
}

export async function applyInstall(plan: InstallPlan, exec: Exec = defaultExec): Promise<void> {
  for (const f of plan.files) {
    await mkdir(dirname(f.path), { recursive: true });
    await writeFile(f.path, f.content, 'utf8');
    if (f.mode !== undefined) await chmod(f.path, f.mode);
  }
  if (plan.registry) {
    // Argument array (no shell): values cannot inject commands.
    await exec('reg', ['add', plan.registry.key, '/ve', '/t', 'REG_SZ', '/d', plan.registry.value, '/f']);
  }
  if (plan.comspec?.fix) {
    // setx writes HKCU\Environment and broadcasts WM_SETTINGCHANGE, so Explorer (and a
    // Chrome started from it afterwards) picks the value up without a new login.
    await exec('setx', [plan.comspec.fix.name, plan.comspec.fix.value]);
  }
}

export async function applyUninstall(plan: InstallPlan, exec: Exec = defaultExec): Promise<string[]> {
  const removed: string[] = [];
  for (const f of plan.files) {
    if (existsSync(f.path)) {
      await rm(f.path);
      removed.push(f.path);
    }
  }
  if (plan.registry) {
    try {
      await exec('reg', ['delete', plan.registry.key, '/f']);
      removed.push(plan.registry.key);
    } catch {
      // Key did not exist.
    }
  }
  return removed;
}

export async function registryValue(key: string, exec: Exec = defaultExec): Promise<string | null> {
  try {
    const { stdout } = await exec('reg', ['query', key, '/ve']);
    const m = /REG_SZ\s+(.+)\s*$/m.exec(stdout);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}
