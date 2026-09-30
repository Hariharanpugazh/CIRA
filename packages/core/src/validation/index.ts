import { upgrade, PcoUpgradeError, type UpgradeOptions } from './upgrade';
import { validate, type ValidationResult } from './validate';

export * from './issues';
export * from './upgrade';
export * from './validate';

export interface ParseResult extends ValidationResult {
  /** Upgrade steps applied before validation. */
  upgradedFrom?: string;
  applied: string[];
}

/**
 * The standard read path for untrusted PCO JSON: `upgrade()` then
 * `validate()`. Upgrade failures are reported as validation errors.
 */
export function parsePco(input: unknown, options: UpgradeOptions = {}): ParseResult {
  try {
    const up = upgrade(input, options);
    const result = validate(up.document);
    return { ...result, applied: up.applied, upgradedFrom: up.applied.length ? up.from : undefined };
  } catch (err) {
    if (!(err instanceof PcoUpgradeError)) throw err;
    const base = validate(input);
    // If validate() already explains the version problem, keep its errors.
    if (!base.ok) return { ...base, applied: [] };
    return {
      ...base,
      ok: false,
      document: undefined,
      errors: [{ code: 'unsupported_major_version', severity: 'error', message: err.message, path: ['pco_version'] }],
      applied: [],
    };
  }
}
