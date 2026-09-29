/**
 * Local host protocol: JSON messages a connector sends to the local CIRA host
 * process (the `cira native-host` command) to persist context on disk.
 *
 * Transport is the connector's concern. The browser extension uses Chrome
 * native messaging (length-prefixed JSON over stdio, started by the browser
 * for allow-listed extension IDs only; no network port is opened).
 */
import { z } from 'zod';

/** Native messaging host name registered with the browser. */
export const LOCAL_HOST_NAME = 'com.cira.context_host';
export const LOCAL_HOST_PROTOCOL_VERSION = 1;

export const HostRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('save'), document: z.unknown() }),
]);
export type HostRequest = z.infer<typeof HostRequestSchema>;

export type HostResponse =
  | { ok: true; type: 'pong'; protocol: number; version: string; dir: string }
  | { ok: true; type: 'saved'; id: string; path: string; item_count: number; warnings: string[] }
  | { ok: false; type: 'error'; error: string; issues?: string[] };
