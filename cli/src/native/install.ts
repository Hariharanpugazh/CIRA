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
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { LOCAL_HOST_NAME } from '@cira/core';
import { defaultCiraHome } from '@cira/core/node';
import { CliError, UsageError } from '../io';

const run = promisify(execFile);

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
}

export interface InstallPlan {
  hostDir: string;
  manifestPath: string;
  launcherPath: string;
  files: Array<{ path: string; content: string; mode?: number }>;
  registry?: { key: string; value: string };
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
    ? `@echo off\r\n"${input.nodePath}" "${input.scriptPath}" native-host %*\r\n`
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
    };
  }
  const browserManifest = join(unixManifestDir(input.browser, input.platform, home), `${LOCAL_HOST_NAME}.json`);
  files.push({ path: browserManifest, content: manifestJson });
  return { hostDir, manifestPath: browserManifest, launcherPath, files };
}

export async function applyInstall(plan: InstallPlan): Promise<void> {
  for (const f of plan.files) {
    await mkdir(dirname(f.path), { recursive: true });
    await writeFile(f.path, f.content, 'utf8');
    if (f.mode !== undefined) await chmod(f.path, f.mode);
  }
  if (plan.registry) {
    // Argument array (no shell): values cannot inject commands.
    await run('reg', ['add', plan.registry.key, '/ve', '/t', 'REG_SZ', '/d', plan.registry.value, '/f']);
  }
}

export async function applyUninstall(plan: InstallPlan): Promise<string[]> {
  const removed: string[] = [];
  for (const f of plan.files) {
    if (existsSync(f.path)) {
      await rm(f.path);
      removed.push(f.path);
    }
  }
  if (plan.registry) {
    try {
      await run('reg', ['delete', plan.registry.key, '/f']);
      removed.push(plan.registry.key);
    } catch {
      // Key did not exist.
    }
  }
  return removed;
}

export async function registryValue(key: string): Promise<string | null> {
  try {
    const { stdout } = await run('reg', ['query', key, '/ve']);
    const m = /REG_SZ\s+(.+)\s*$/m.exec(stdout);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}
