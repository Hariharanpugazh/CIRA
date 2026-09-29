/**
 * Safety scan for PCO documents: runs the regex/entropy secret detector over
 * every turn and item before a connector saves or shares context.
 *
 * This is a best-effort warning system, not a guarantee. It will miss secrets
 * that don't match known patterns and flags some harmless strings.
 * Findings never include the raw secret value, only a redacted preview.
 */
import type { PCODocument } from '../types';
import { generateWarnings, scanForSecrets, type DetectedSecret } from './secret-detector';

export type SafetyLocation =
  | { kind: 'turn'; conversation_id: string; turn_id: string; turn_index: number }
  | { kind: 'item'; item_id: string };

export interface SafetyFinding {
  type: string;
  confidence: DetectedSecret['confidence'];
  /** Redacted preview (never the raw value). */
  preview: string;
  location: SafetyLocation;
}

export interface SafetyReport {
  hasFindings: boolean;
  findings: SafetyFinding[];
  /** Human-readable warnings for UI/CLI output. */
  warnings: string[];
}

function toFindings(text: string, location: SafetyLocation): { findings: SafetyFinding[]; raw: DetectedSecret[] } {
  const raw = scanForSecrets(text);
  return {
    raw,
    findings: raw.map((s) => ({ type: s.type, confidence: s.confidence, preview: s.redactedPreview, location })),
  };
}

export function scanDocument(doc: PCODocument): SafetyReport {
  const findings: SafetyFinding[] = [];
  const all: DetectedSecret[] = [];
  for (const conv of doc.conversations) {
    for (const turn of conv.turns) {
      const r = toFindings(turn.content, { kind: 'turn', conversation_id: conv.id, turn_id: turn.id, turn_index: turn.index });
      findings.push(...r.findings);
      all.push(...r.raw);
    }
  }
  // Items are usually excerpts of turns; only scan items without a turn so
  // the same secret is not reported twice.
  for (const item of doc.items) {
    if (item.provenance.turn_id) continue;
    const r = toFindings(item.content, { kind: 'item', item_id: item.id });
    findings.push(...r.findings);
    all.push(...r.raw);
  }
  return { hasFindings: findings.length > 0, findings, warnings: generateWarnings(all) };
}
