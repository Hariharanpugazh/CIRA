/**
 * Chrome native messaging framing: each message is a 32-bit length
 * (native byte order; little-endian on all supported platforms) followed by
 * UTF-8 JSON.
 */

/** Chrome's limit for messages sent to a host. */
export const MAX_INBOUND_BYTES = 64 * 1024 * 1024;
/** Chrome's limit for messages sent from a host. */
export const MAX_OUTBOUND_BYTES = 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_OUTBOUND_BYTES) throw new Error(`native message too large (${body.length} bytes)`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder: push chunks, get complete messages. */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: unknown[] = [];
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32LE(0);
      if (len > MAX_INBOUND_BYTES) throw new Error(`native message too large (${len} bytes)`);
      if (this.buffer.length < 4 + len) break;
      const body = this.buffer.subarray(4, 4 + len).toString('utf8');
      this.buffer = this.buffer.subarray(4 + len);
      out.push(JSON.parse(body));
    }
    return out;
  }

  get pending(): number {
    return this.buffer.length;
  }
}
