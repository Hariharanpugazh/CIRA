/**
 * PCO versioning.
 *
 * `pco_version` is "MAJOR.MINOR".
 *  - Same major, same minor  → fully supported.
 *  - Same major, newer minor → readable; unknown fields are preserved and
 *    unknown item types are dropped with a warning (forward compatible).
 *  - Same major, older minor → must go through `upgrade()` first.
 *  - Different major         → not readable by this implementation.
 */
export const PCO_VERSION = '0.1' as const;
export type PcoVersionString = `${number}.${number}`;

export interface ParsedVersion {
  major: number;
  minor: number;
}

const VERSION_RE = /^(\d{1,4})\.(\d{1,4})$/;

export function parseVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== 'string') return null;
  const m = VERSION_RE.exec(value);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export const CURRENT_VERSION: ParsedVersion = parseVersion(PCO_VERSION)!;

export type VersionCompatibility =
  | 'current'
  | 'newer_minor'
  | 'older_minor'
  | 'unsupported_major';

export function compareToCurrent(v: ParsedVersion): VersionCompatibility {
  if (v.major !== CURRENT_VERSION.major) return 'unsupported_major';
  if (v.minor === CURRENT_VERSION.minor) return 'current';
  return v.minor > CURRENT_VERSION.minor ? 'newer_minor' : 'older_minor';
}

export function formatVersion(v: ParsedVersion): string {
  return `${v.major}.${v.minor}`;
}
