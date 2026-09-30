/**
 * Small, dependency-free, deterministic string hash (cyrb53 variant, 64 bits
 * rendered as 16 hex chars). Used to derive stable IDs so that re-encoding
 * the same conversation yields the same PCO/item IDs.
 *
 * NOT cryptographic. Never use for integrity or security decisions.
 */
export function stableHash(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Build a prefixed, schema-valid ID from arbitrary parts. */
export function makeId(prefix: string, ...parts: Array<string | number | undefined>): string {
  return `${prefix}_${stableHash(parts.map((p) => (p === undefined ? '' : String(p))).join('\u241f'))}`;
}
