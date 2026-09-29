/**
 * The text injected into the target platform on relay.
 *
 * Phase 01 deliberately keeps the legacy rule-based compressor (now in
 * @cira/core) so relay behaviour is unchanged; a PCO-based relay is a
 * Phase 02 change once the two can be compared. Locked by
 * tests/legacy-relay.regression.test.ts.
 */
import { compressLegacy, type CompressOptions } from '@cira/core';
import type { Conversation } from './schema';

export function buildRelaySummary(conversation: Conversation, options?: CompressOptions): string {
  return compressLegacy(conversation, options);
}
