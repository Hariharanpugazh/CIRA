// Smoke test: drive the BUILT native host (cli/dist/cira.js) exactly like
// Chrome does — spawn it with the extension origin argument, write one
// length-prefixed JSON message to stdin, read one framed reply from stdout.
//
//   node scripts/smoke-native-host.mjs [path/to/doc.pco.json]
//
// Uses a temporary CIRA_HOME unless CIRA_HOME is already set.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = process.argv[2] ?? join(root, 'packages/pco/examples/technical-project.pco.json');
const ciraHome = process.env.CIRA_HOME ?? mkdtempSync(join(tmpdir(), 'cira-smoke-'));

const child = spawn(process.execPath, [join(root, 'cli/dist/cira.js'), 'native-host', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'], {
  env: { ...process.env, CIRA_HOME: ciraHome },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const body = Buffer.from(JSON.stringify({ type: 'save', document: JSON.parse(readFileSync(docPath, 'utf8')) }));
const header = Buffer.alloc(4);
header.writeUInt32LE(body.length);
child.stdin.end(Buffer.concat([header, body]));

const chunks = [];
child.stdout.on('data', (c) => chunks.push(c));
child.on('close', (code) => {
  const buf = Buffer.concat(chunks);
  const len = buf.readUInt32LE(0);
  const reply = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
  console.log(JSON.stringify({ exitCode: code, ciraHome, reply }, null, 2));
  process.exitCode = reply.ok && code === 0 ? 0 : 1;
});
