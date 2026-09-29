// End-to-end smoke test on BUILT artifacts, in a temporary CIRA_HOME:
//   legacy capture → PCO (Core, same call the extension makes) → native host via the
//   generated launcher (as the browser would start it) → ~/.cira/contexts → cira validate/export → MCP.
//
//   pnpm build && node scripts/smoke-e2e.mjs
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'cli/dist/cira.js');
const home = mkdtempSync(join(tmpdir(), 'cira-e2e-'));
const env = { ...process.env, CIRA_HOME: home };
const step = (s) => console.log(`\n=== ${s} ===`);
const cira = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });

try {
  step('1. browser capture (legacy Conversation) → PCO');
  const pco = cira('migrate', join(root, 'packages/core/tests/fixtures/legacy/chatgpt-popup-export.json'), '--stdout');
  console.log(`encoded ${JSON.parse(pco).items.length} items`);

  step('2. native host via launcher (as Chrome starts it)');
  const win = process.platform === 'win32';
  const launcher = join(home, win ? 'host.cmd' : 'host.sh');
  writeFileSync(
    launcher,
    win ? `@echo off\r\n"${process.execPath}" "${cli}" native-host %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${cli}" native-host "$@"\n`,
  );
  if (!win) chmodSync(launcher, 0o755);
  const reply = await new Promise((res, rej) => {
    const child = win
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${launcher}" chrome-extension://abcdefghijklmnopabcdefghijklmnop/ --parent-window=0`], { env, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'ignore'] })
      : spawn(launcher, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const body = Buffer.from(JSON.stringify({ type: 'save', document: JSON.parse(pco) }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    child.stdin.end(Buffer.concat([header, body]));
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', rej);
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      res(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString('utf8')));
    });
  });
  console.log(reply);
  if (!reply.ok) throw new Error('native host failed');

  step('3. file in $CIRA_HOME/contexts');
  const files = readdirSync(join(home, 'contexts'));
  console.log(files);

  step('4. cira validate');
  console.log(cira('validate', reply.path));

  step('5. cira export --format md');
  const md = cira('export', reply.path, '--format', 'md');
  console.log(md);

  step('6. MCP list_contexts / get_context over stdio');
  const mcp = execFileSync(process.execPath, [join(root, 'packages/mcp/scripts/smoke-stdio.mjs')], { env, encoding: 'utf8' });
  console.log(mcp);
  const mcpFull = execFileSync(process.execPath, ['-e', `
    import('${pathToUrl(join(root, 'packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'))}').then(async ({ Client }) => {
      const { StdioClientTransport } = await import('${pathToUrl(join(root, 'packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'))}');
      const c = new Client({ name: 'e2e', version: '0' });
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [${JSON.stringify(join(root, 'packages/mcp/dist/server.js'))}], env: process.env, stderr: 'ignore' }));
      const r = await c.callTool({ name: 'get_context', arguments: { id: ${JSON.stringify(reply.id)} } });
      process.stdout.write(r.content[0].text);
      await c.close();
    });`], { env, encoding: 'utf8' });
  if (mcpFull !== md) throw new Error('MCP get_context differs from `cira export --format md`');
  console.log('MCP get_context output is identical to `cira export --format md`.');
  console.log('\nE2E OK');
} finally {
  rmSync(home, { recursive: true, force: true });
}

function pathToUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, '/').replace(/^\//, '')}`).href;
}
