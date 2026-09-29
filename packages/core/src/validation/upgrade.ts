/**
 * Version upgrade chain.
 *
 * Each `Upgrader` transforms a raw document from exactly one `from` version
 * to one `to` version. `upgrade()` walks the chain until the document is at
 * the current version. Upgraders operate on raw JSON so they can handle
 * shapes the current schema no longer accepts.
 *
 * v0.1 is the first published version, so the built-in chain is empty; the
 * mechanism exists so that future versions never break old PCO files.
 */
import { compareToCurrent, parseVersion, PCO_VERSION } from '../pco/version';

export interface Upgrader {
  from: string;
  to: string;
  upgrade(document: Record<string, unknown>): Record<string, unknown>;
}

/** Built-in upgraders, in no particular order. Empty for v0.1. */
export const BUILTIN_UPGRADERS: readonly Upgrader[] = [];

export interface UpgradeResult {
  document: unknown;
  from: string | undefined;
  to: string | undefined;
  /** Versions stepped through, e.g. ["0.0→0.1"]. Empty when nothing changed. */
  applied: string[];
}

export class PcoUpgradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PcoUpgradeError';
  }
}

export interface UpgradeOptions {
  /** Replaces the built-in chain (mainly for tests and experiments). */
  upgraders?: readonly Upgrader[];
}

/**
 * Bring a raw document up to the current PCO version.
 *
 * Documents that are already current, or a newer minor of the same major,
 * are returned unchanged (validation reports newer-minor as a warning).
 * Non-objects and missing/invalid versions are returned unchanged so that
 * `validate()` can report them precisely.
 *
 * Throws `PcoUpgradeError` for a different major version or when no upgrade
 * path exists.
 */
export function upgrade(input: unknown, options: UpgradeOptions = {}): UpgradeResult {
  const chain = options.upgraders ?? BUILTIN_UPGRADERS;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { document: input, from: undefined, to: undefined, applied: [] };
  }
  let doc = input as Record<string, unknown>;
  const from = typeof doc.pco_version === 'string' ? doc.pco_version : undefined;
  const parsed = parseVersion(doc.pco_version);
  if (!parsed) return { document: input, from, to: from, applied: [] };

  const compat = compareToCurrent(parsed);
  if (compat === 'current' || compat === 'newer_minor') {
    return { document: input, from, to: from, applied: [] };
  }

  const applied: string[] = [];
  const visited = new Set<string>();
  let version = from!;
  while (version !== PCO_VERSION) {
    const v = parseVersion(version);
    if (!v) throw new PcoUpgradeError(`upgrader produced invalid pco_version ${JSON.stringify(version)}`);
    const c = compareToCurrent(v);
    if (c === 'current' || c === 'newer_minor') break;
    if (visited.has(version)) throw new PcoUpgradeError(`upgrade cycle detected at ${version}`);
    visited.add(version);
    const step = chain.find((u) => u.from === version);
    if (!step) {
      throw new PcoUpgradeError(
        c === 'unsupported_major'
          ? `cannot upgrade pco_version ${version}: major version is not supported (current ${PCO_VERSION})`
          : `no upgrade path from pco_version ${version} to ${PCO_VERSION}`,
      );
    }
    doc = { ...step.upgrade(doc), pco_version: step.to };
    applied.push(`${step.from}→${step.to}`);
    version = step.to;
  }
  return { document: doc, from, to: version, applied };
}
