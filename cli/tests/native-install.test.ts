/**
 * `cira native-host install|status` on Windows, and the launcher Chrome starts.
 *
 * Background (Phase 01, real Chrome 153 on Windows): the extension reported
 * "Failed to start native messaging host." while the launcher ran fine by hand.
 * Chrome's log showed `launch_context_win.cc: COMSPEC is not set`: Chromium
 * starts every native host (.cmd or .exe) through %ComSpec% and gives up when
 * the variable is missing. `install` now checks ComSpec and sets the standard
 * per-user value when it is missing or broken.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/main';
import { checkComSpec, expandWindowsEnv, planInstall, readComSpecState, standardComSpec, windowsLauncher, type Exec } from '../src/native/install';

const ID = 'jepfbopabphdngbliphfmedfnhchpeoh';
const ID2 = 'abcdefghijklmnopabcdefghijklmnop';
const WIN_ENV = { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows' } as NodeJS.ProcessEnv;

let dir = '';
let out = '';
let err = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cira-install-'));
  out = '';
  err = '';
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Records every external command; answers `reg query … /v ComSpec` from `comspec`. */
function fakeExec(comspec: { user?: string; machine?: string } = {}) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    if (file === 'reg' && args[0] === 'query' && args.includes('ComSpec')) {
      const value = args[1] === 'HKCU\\Environment' ? comspec.user : comspec.machine;
      if (!value) throw new Error('ERROR: The system was unable to find the specified registry key or value.');
      return { stdout: `\r\n${args[1]}\r\n    ComSpec    REG_EXPAND_SZ    ${value}\r\n\r\n` };
    }
    if (file === 'reg' && args[0] === 'query') return { stdout: `\r\n${args[1]}\r\n    (Default)    REG_SZ    C:\\x\\m.json\r\n` };
    return { stdout: '' };
  };
  return { exec, calls };
}

const run = (argv: string[], exec: Exec, extra: { scriptPath?: string; nodePath?: string } = {}) =>
  main(
    argv,
    {
      stdout: (t) => void (out += t),
      stderr: (t) => void (err += t),
      env: { ...WIN_ENV, CIRA_HOME: join(dir, 'cira home') },
      cwd: dir,
    },
    {
      platform: 'win32',
      exec,
      nodePath: extra.nodePath ?? 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: extra.scriptPath ?? 'D:\\Some Dir\\CIRA\\cli\\dist\\cira.js',
    },
  );

describe('Windows manifest and launcher generation', () => {
  const plan = (ids = [ID]) =>
    planInstall({
      extensionIds: ids,
      browser: 'chrome',
      platform: 'win32',
      env: { ...WIN_ENV, CIRA_HOME: 'C:\\Users\\someone\\.cira' },
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'E:\\work\\my repo\\cli\\dist\\cira.js',
    });

  it('writes a stdio manifest whose path is the absolute launcher', () => {
    const p = plan();
    const manifest = JSON.parse(p.files.find((f) => f.path === p.manifestPath)!.content);
    expect(manifest).toEqual({
      name: 'com.cira.context_host',
      description: expect.any(String),
      path: p.launcherPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${ID}/`],
    });
    expect(p.launcherPath).toBe(join(p.hostDir, 'cira-native-host.cmd'));
    expect(p.hostDir).toMatch(/someone[\\/]\.cira[\\/]native-host$/); // from CIRA_HOME, not hard-coded
    expect(p.registry).toEqual({ key: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.cira.context_host', value: p.manifestPath });
  });

  it('allows exactly the given extension IDs', () => {
    const manifest = JSON.parse(plan([ID, ID2]).files[1].content);
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${ID}/`, `chrome-extension://${ID2}/`]);
    expect(() => plan(['chrome-extension://x/'])).toThrow(/not a Chrome extension ID/);
  });

  it('generates a launcher that only runs node with absolute, quoted paths from the install', () => {
    const launcher = plan().files[0].content;
    expect(launcher).toBe('@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "E:\\work\\my repo\\cli\\dist\\cira.js" native-host %*\r\n');
    // No shell features: no other interpreter, no pipes/redirection/chaining, no cd, no PATH lookups.
    expect(launcher).not.toMatch(/powershell|pwsh|cmd(\.exe)?\s|\bstart\b|\bcd\b|[|<>]|&&/i);
  });

  it('escapes % (expanded by cmd even inside quotes) and rejects double quotes', () => {
    expect(windowsLauncher('C:\\n\\node.exe', 'D:\\100% done\\cira.js')).toContain('"D:\\100%% done\\cira.js"');
    expect(() => windowsLauncher('C:\\n\\node.exe', 'D:\\bad"quote\\cira.js')).toThrow(/double quote/);
  });

  it('never points the manifest at a shell', () => {
    const p = plan();
    const manifest = JSON.parse(p.files[1].content);
    expect(manifest.path).not.toMatch(/(cmd|powershell|pwsh)\.exe$/i);
    expect(isAbsolute(manifest.path) || /^[A-Za-z]:\\/.test(manifest.path)).toBe(true);
  });
});

describe('ComSpec check (Chrome starts every Windows native host through %ComSpec%)', () => {
  it('plans the standard per-user value when ComSpec is missing', () => {
    expect(checkComSpec({}, WIN_ENV)).toEqual({
      ok: false,
      fix: { name: 'ComSpec', value: 'C:\\Windows\\System32\\cmd.exe', reason: expect.stringContaining('COMSPEC is not set') },
    });
  });

  it('accepts the usual REG_EXPAND_SZ value, user over machine', () => {
    const exists = (p: string) => p.toLowerCase() === 'c:\\windows\\system32\\cmd.exe';
    expect(checkComSpec({ machine: '%SystemRoot%\\system32\\cmd.exe' }, WIN_ENV, exists)).toEqual({ ok: true, value: 'C:\\Windows\\system32\\cmd.exe' });
    expect(checkComSpec({ user: 'C:\\missing\\cmd.exe', machine: '%SystemRoot%\\system32\\cmd.exe' }, WIN_ENV, exists)).toMatchObject({ ok: false, fix: { value: 'C:\\Windows\\System32\\cmd.exe' } });
  });

  it('reports but keeps a deliberate non-cmd ComSpec', () => {
    const r = checkComSpec({ user: 'C:\\tools\\tcc.exe' }, WIN_ENV, () => true);
    expect(r.ok).toBe(true);
    expect(r.fix).toBeUndefined();
    expect(r.warning).toMatch(/not cmd\.exe/);
  });

  it('expands %VAR% case-insensitively and derives cmd.exe from SystemRoot', () => {
    expect(expandWindowsEnv('%SYSTEMROOT%\\x;%nope%', { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\x;%nope%');
    expect(standardComSpec({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\cmd.exe');
  });

  it('reads user and machine ComSpec from the registry with argument arrays', async () => {
    const { exec, calls } = fakeExec({ machine: '%SystemRoot%\\system32\\cmd.exe' });
    expect(await readComSpecState(exec)).toEqual({ machine: '%SystemRoot%\\system32\\cmd.exe' });
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([
      ['reg', 'query', 'HKCU\\Environment', '/v', 'ComSpec'],
      ['reg', 'query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'ComSpec'],
    ]);
  });
});

describe('cira native-host install / status (Windows)', () => {
  it('writes the launcher and manifest, registers them, and sets ComSpec when it is missing', async () => {
    const { exec, calls } = fakeExec({});
    expect(await run(['native-host', 'install', '--extension-id', ID], exec)).toBe(0);

    const hostDir = join(dir, 'cira home', 'native-host');
    const launcher = join(hostDir, 'cira-native-host.cmd');
    const manifestPath = join(hostDir, 'com.cira.context_host.json');
    expect(existsSync(launcher)).toBe(true);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.path).toBe(launcher);
    expect(existsSync(manifest.path)).toBe(true);
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${ID}/`]);
    expect(await readFile(launcher, 'utf8')).toBe('@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "D:\\Some Dir\\CIRA\\cli\\dist\\cira.js" native-host %*\r\n');

    const writes = calls.filter((c) => !(c.file === 'reg' && c.args[0] === 'query'));
    expect(writes).toEqual([
      { file: 'reg', args: ['add', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.cira.context_host', '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'] },
      { file: 'setx', args: ['ComSpec', 'C:\\Windows\\System32\\cmd.exe'] },
    ]);
    // Only reg/setx, always as argument arrays: no shell, no PowerShell.
    expect(calls.every((c) => ['reg', 'setx'].includes(c.file) && Array.isArray(c.args))).toBe(true);
    expect(out).toContain('set user environment ComSpec = C:\\Windows\\System32\\cmd.exe');
    expect(out).toMatch(/Quit chrome completely/);
  });

  it('leaves a working ComSpec alone', async () => {
    const cmd = join(dir, 'cmd.exe'); // an existing cmd.exe on any platform
    await writeFile(cmd, '');
    const { exec, calls } = fakeExec({ machine: cmd });
    expect(await run(['native-host', 'install', '--extension-id', ID], exec)).toBe(0);
    expect(calls.filter((c) => c.file === 'setx')).toEqual([]);
    expect(out).not.toContain('ComSpec');
    out = '';
    expect(await run(['native-host', 'status'], exec)).toBe(0);
    expect(out).toContain(`comspec:   ${cmd}`);
  });

  it('--dry-run reports the ComSpec fix without writing anything', async () => {
    const { exec, calls } = fakeExec({});
    expect(await run(['native-host', 'install', '--extension-id', ID, '--dry-run'], exec)).toBe(0);
    expect(out).toContain('would set user environment ComSpec');
    expect(calls.filter((c) => c.file === 'setx' || c.args[0] === 'add')).toEqual([]);
    expect(existsSync(join(dir, 'cira home', 'native-host'))).toBe(false);
  });

  it('status fails and says why when ComSpec is missing', async () => {
    const { exec } = fakeExec({});
    await run(['native-host', 'install', '--extension-id', ID], exec);
    out = '';
    expect(await run(['native-host', 'status'], exec)).toBe(1);
    expect(out).toMatch(/comspec:\s+ComSpec is not set/);
    expect(out).toMatch(/launcher:.*\(present\)/);
  });
});

/** Chrome's Windows launch: `%ComSpec% /d /s /c ""<host>" chrome-extension://<id>/ --parent-window=<n>"`. */
function launchLikeChrome(host: string, cwd: string) {
  return spawn(process.env.ComSpec ?? standardComSpec(process.env), ['/d', '/s', '/c', `""${host}" chrome-extension://${ID}/ --parent-window=0"`], {
    cwd,
    windowsVerbatimArguments: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe.runIf(process.platform === 'win32')('generated launcher, started the way Chrome starts it', () => {
  it('passes stdio bytes through untouched, keeps logs on stderr, forwards the exit code, works from any cwd and odd paths', async () => {
    // Directory with spaces, &, parentheses and % (all legal in Windows paths).
    const odd = join(dir, 'CIRA & co (test) 100% dir');
    await mkdir(odd, { recursive: true });
    const script = join(odd, 'fake-host.mjs');
    await writeFile(
      script,
      [
        "const chunks = [];",
        "process.stdin.on('data', (c) => chunks.push(c));",
        "process.stdin.on('end', () => {",
        "  const buf = Buffer.concat(chunks);",
        "  const body = buf.subarray(4, 4 + buf.readUInt32LE(0));",
        "  const reply = Buffer.from(JSON.stringify({ echo: JSON.parse(body.toString('utf8')), args: process.argv.slice(2) }), 'utf8');",
        "  const header = Buffer.alloc(4); header.writeUInt32LE(reply.length, 0);",
        "  process.stderr.write('[fake host] diagnostics go to stderr\\n');",
        "  process.stdout.write(Buffer.concat([header, reply]), () => process.exit(3));",
        "});",
      ].join('\n'),
    );
    const launcher = join(odd, 'cira-native-host.cmd');
    await writeFile(launcher, windowsLauncher(process.execPath, script));

    const elsewhere = await mkdtemp(join(tmpdir(), 'cira-cwd-'));
    const child = launchLikeChrome(launcher, elsewhere);
    const message = { type: 'save', text: '├── frontend/ → ✓ 😀' };
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    child.stdin.end(Buffer.concat([header, body]));

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    await rm(elsewhere, { recursive: true, force: true });

    const buf = Buffer.concat(stdout);
    expect(buf.readUInt32LE(0)).toBe(buf.length - 4); // exactly one frame, nothing else on stdout
    expect(JSON.parse(buf.subarray(4).toString('utf8'))).toEqual({ echo: message, args: ['native-host', `chrome-extension://${ID}/`, '--parent-window=0'] });
    expect(Buffer.concat(stderr).toString('utf8')).toContain('[fake host] diagnostics go to stderr');
    expect(code).toBe(3);
  });
});
