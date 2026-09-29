/**
 * @cira/core — environment-neutral CIRA Core.
 *
 * No browser, Node or platform-specific (ChatGPT, VS Code, …) knowledge
 * lives here. Connectors adapt their environment to these types.
 */
export * from './types';
export * from './pco/schema';
export * from './pco/version';
export { useStrictCspRuntime } from './pco/runtime';
export * from './validation';
export * from './provenance';

export * from './encoder/types';
export {
  encode,
  buildConversation,
  extractItems,
  deriveConversationId,
  DEFAULT_EXTRACTORS,
  ENCODER_ID,
  type EncodeOptions,
} from './encoder/encode';
export { codeBlockExtractor, referenceExtractor } from './encoder/extractors/deterministic';
export { heuristicStatementExtractor, RULE_CONFIDENCE } from './encoder/extractors/heuristic';

export * from './decoder/decode';
export * from './decoder/render-markdown';

export * from './migration/legacy-v0';

export type { Compressor } from './selection/compressor';
export {
  compress as compressLegacy,
  legacyRuleCompressor,
  formatContextTag,
  type CompressOptions,
} from './selection/legacy-rule-compressor';

export {
  scanForSecrets,
  redactSecrets,
  generateWarnings,
  getScanSummary,
  type DetectedSecret,
} from './safety/secret-detector';
export * from './safety/scan';

export * from './protocol/local-host';

export * from './storage/context-store';
export * from './storage/in-memory';
export * from './storage/key-value';

export { stableHash, makeId } from './util/hash';
