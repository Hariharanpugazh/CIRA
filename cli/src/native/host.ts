/**
 * `cira native-host`: the local CIRA host the browser extension talks to via
 * native messaging. It validates every document with @cira/core and writes
 * it to the FileContextStore (~/.cira/contexts). stdout is the protocol
 * channel, so all diagnostics go to stderr.
 */
import {
  formatIssue,
  HostRequestSchema,
  LOCAL_HOST_PROTOCOL_VERSION,
  parsePco,
  scanDocument,
  type HostResponse,
} from '@cira/core';
import type { FileContextStore } from '@cira/core/node';
import { encodeFrame, FrameDecoder } from './framing';

export const HOST_VERSION = '0.1.0';

export async function handleHostMessage(message: unknown, store: FileContextStore): Promise<HostResponse> {
  const req = HostRequestSchema.safeParse(message);
  if (!req.success) return { ok: false, type: 'error', error: 'invalid request', issues: req.error.issues.map((i) => i.message) };

  if (req.data.type === 'ping') {
    return { ok: true, type: 'pong', protocol: LOCAL_HOST_PROTOCOL_VERSION, version: HOST_VERSION, dir: store.dir };
  }

  const parsed = parsePco(req.data.document);
  if (!parsed.ok || !parsed.document) {
    return { ok: false, type: 'error', error: 'document is not a valid PCO', issues: parsed.errors.map(formatIssue) };
  }
  try {
    const summary = await store.put(parsed.document);
    const safety = scanDocument(parsed.document);
    return {
      ok: true,
      type: 'saved',
      id: summary.id,
      path: store.pathFor(summary.id),
      item_count: summary.item_count,
      warnings: [...parsed.warnings.map(formatIssue), ...safety.warnings],
    };
  } catch (err) {
    return { ok: false, type: 'error', error: `failed to save: ${(err as Error).message}` };
  }
}

export interface HostStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log: (line: string) => void;
}

/** Serve framed requests until the browser closes stdin. */
export function runHost(store: FileContextStore, streams: HostStreams): Promise<void> {
  const decoder = new FrameDecoder();
  let chain = Promise.resolve();
  return new Promise((resolveDone) => {
    streams.input.on('data', (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        streams.log(`[cira native-host] ${(err as Error).message}`);
        streams.output.write(encodeFrame({ ok: false, type: 'error', error: (err as Error).message } satisfies HostResponse));
        return;
      }
      for (const m of messages) {
        chain = chain.then(async () => {
          const res = await handleHostMessage(m, store);
          streams.log(`[cira native-host] ${res.ok ? res.type : `error: ${res.error}`}`);
          streams.output.write(encodeFrame(res));
        });
      }
    });
    streams.input.on('end', () => void chain.then(() => resolveDone()));
  });
}
