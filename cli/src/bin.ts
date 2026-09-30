import { main } from './main';

const code = await main(process.argv.slice(2), {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  env: process.env,
  cwd: process.cwd(),
});
process.exitCode = code;
