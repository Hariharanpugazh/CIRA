/**
 * Heuristic statement extractor.
 *
 * Classifies sentence-like segments of a turn with keyword/phrase rules. This
 * is NOT semantic understanding: it will miss paraphrases and produce false
 * positives. Every item it emits is marked `extracted_by.method: "heuristic"`
 * and carries a fixed, rule-based confidence (see RULE_CONFIDENCE). Those
 * numbers are hand-set estimates of rule precision, not measured values.
 *
 * Rules by role:
 *  - user / system turns: question, constraint, preference, decision, task, fact
 *  - assistant turns:     decision only (proposals, lower confidence)
 *  - tool turns:          nothing
 * Each segment yields at most one item; the first matching rule wins.
 */
import { splitSegments } from '../text';
import type { ItemDraft, ItemExtractor } from '../types';

const Q = "['’]"; // straight or curly apostrophe

const re = (source: string) => new RegExp(source, 'i');

const NEGATED_COGNITION = re(`\\b(?:don${Q}t|do not|doesn${Q}t|does not)\\s+(?:know|think|understand|see|remember|care|mind|believe)\\b`);

const CONSTRAINT_RULES: Array<{ strength: 'must' | 'must_not' | 'should' | 'should_not'; pattern: RegExp }> = [
  { strength: 'should_not', pattern: re(`\\bshould(?:\\s+not|n${Q}t)\\b`) },
  { strength: 'must_not', pattern: re(`\\b(?:do not|don${Q}t|dont|must not|mustn${Q}t|never|avoid|cannot use|can${Q}t use|no longer use|without using)\\b`) },
  { strength: 'must', pattern: re(`\\b(?:must|have to|has to|required to|is required|are required|needs? to be|only use)\\b`) },
  { strength: 'should', pattern: re(`\\bshould\\b`) },
];

const PREFERENCE = re(
  `\\b(?:I|we)\\s+(?:really\\s+)?(?:prefer|like to use|love using)\\b|\\b(?:I|we)(?:${Q}d|\\s+would)\\s+rather\\b|\\bmy preference\\b`,
);

const DECISION = re(
  [
    `\\b(?:I|we)(?:${Q}ve|\\s+have)?\\s+decided\\b`,
    `\\bdecided to\\b`,
    `\\b(?:I|we)(?:${Q}ll|\\s+will)\\s+(?:use|go with|stick with|adopt)\\b`,
    `\\bgoing with\\b`,
    `\\blet${Q}?s\\s+(?:use|go with|stick with|adopt)\\b`,
    `\\bsettled on\\b`,
    `\\b(?:I|we)\\s+(?:chose|picked|selected)\\b`,
    `\\bwe(?:${Q}re|\\s+are)\\s+using\\b`,
  ].join('|'),
);

const TASK = re(
  [
    `^(?:please\\s+)?(?:implement|build|add|create|fix|write|refactor|set up|make|update|migrate|remove|design|deploy|test)\\b`,
    `\\b(?:need|needs|want|wants|trying|plan|plans) to\\b`,
    `\\bnext step\\b`,
    `\\bto-?do\\b`,
  ].join('|'),
);

const FACT = re(
  [
    `\\b(?:I${Q}m|I am|we${Q}re|we are)\\s+(?:building|developing|working on|creating|making|planning|writing|designing)\\b`,
    `\\b(?:the|our|my|this)\\s+(?:project|app|application|stack|backend|frontend|database|api|service|codebase|repo|repository|website|site|team)\\s+(?:is|uses|runs|has|will|was|needs)\\b`,
    `\\b(?:is|are)\\s+(?:written|built|implemented)\\s+(?:in|with|on)\\b`,
  ].join('|'),
);

/** Hand-set confidences for each rule (documented in docs/pco/specification.md). */
export const RULE_CONFIDENCE = {
  question: 0.8,
  constraint_strong: 0.7,
  constraint_soft: 0.55,
  preference: 0.6,
  decision_user: 0.65,
  decision_assistant: 0.5,
  task: 0.5,
  fact: 0.5,
} as const;

const MAX_SEGMENT = 500;

export const heuristicStatementExtractor: ItemExtractor = {
  id: 'cira.heuristic-statements',
  version: '0.1.0',
  method: 'heuristic',
  extract({ turn, prose }) {
    if (turn.role === 'tool') return [];
    const drafts: ItemDraft[] = [];
    for (const seg of splitSegments(prose)) {
      if (seg.text.length > MAX_SEGMENT) continue;
      const span = { start: seg.start, end: seg.end };
      const content = seg.text;

      if (turn.role === 'assistant') {
        if (DECISION.test(content)) {
          drafts.push({ type: 'decision', status: 'proposed', content, confidence: RULE_CONFIDENCE.decision_assistant, span });
        }
        continue;
      }

      if (content.endsWith('?')) {
        drafts.push({ type: 'question', content, confidence: RULE_CONFIDENCE.question, span });
        continue;
      }

      if (!NEGATED_COGNITION.test(content)) {
        const rule = CONSTRAINT_RULES.find((r) => r.pattern.test(content));
        if (rule) {
          const strong = rule.strength === 'must' || rule.strength === 'must_not';
          drafts.push({
            type: 'constraint',
            strength: rule.strength,
            content,
            confidence: strong ? RULE_CONFIDENCE.constraint_strong : RULE_CONFIDENCE.constraint_soft,
            span,
          });
          continue;
        }
      }

      if (PREFERENCE.test(content)) {
        drafts.push({ type: 'preference', content, confidence: RULE_CONFIDENCE.preference, span });
      } else if (DECISION.test(content)) {
        drafts.push({ type: 'decision', status: 'accepted', content, confidence: RULE_CONFIDENCE.decision_user, span });
      } else if (TASK.test(content)) {
        drafts.push({ type: 'task', status: 'open', content, confidence: RULE_CONFIDENCE.task, span });
      } else if (FACT.test(content)) {
        drafts.push({ type: 'fact', content, confidence: RULE_CONFIDENCE.fact, span });
      }
    }
    return drafts;
  },
};
