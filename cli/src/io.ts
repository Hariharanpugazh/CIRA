import { readFile } from 'node:fs/promises';
import { defaultContextDir, FileContextStore } from '@cira/core/node';

/** Everything a command touches in its environment; injectable for tests. */
export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = 'CliError';
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

export async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new CliError(code === 'ENOENT' ? `file not found: ${file}` : `cannot read ${file}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new CliError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

export function openStore(io: CliIO, dir?: string): FileContextStore {
  return new FileContextStore(dir ?? defaultContextDir(io.env), {
    onInvalidFile: ({ file, reason }) => io.stderr(`warning: skipping invalid context file ${file}: ${reason}\n`),
  });
}
