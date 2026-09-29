/**
 * Selection / compression interface.
 *
 *   Context → Representation (PCO) → optional Selection / Compression → Target context
 *
 * A compressor is an optimisation that turns some input (a legacy
 * conversation today, a PCO or DecodedContext in future phases) into a
 * shorter text for a target. It never changes the stored representation.
 */
import type { ExtractionMethod } from '../types';

export interface Compressor<TInput, TOptions = Record<string, never>> {
  /** Stable identity, e.g. "cira.legacy-rule-compressor@0.1.0". */
  readonly id: string;
  /** How the output is produced; must be honest (no "model" without a model). */
  readonly method: ExtractionMethod;
  compress(input: TInput, options?: TOptions): string;
}
