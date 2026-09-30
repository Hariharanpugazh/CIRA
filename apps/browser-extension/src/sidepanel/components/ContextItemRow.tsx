import { memo } from 'react';
import type { ContextItem, SemanticAnnotation } from '@cira/core';

export const TYPE_LABEL: Record<ContextItem['type'], string> = {
  fact: 'Fact',
  decision: 'Decision',
  constraint: 'Constraint',
  preference: 'Preference',
  task: 'Task',
  question: 'Question',
  code_artifact: 'Code',
  reference: 'Reference',
};

function summaryOf(item: ContextItem): string {
  if (item.type === 'code_artifact') {
    const first = item.content.split('\n').find((l) => l.trim()) ?? '';
    const lines = item.content.split('\n').length;
    return `${item.filename ?? item.language} · ${lines} line${lines === 1 ? '' : 's'} · ${first.trim()}`;
  }
  if (item.type === 'reference') return item.title ? `${item.title} — ${item.uri}` : item.uri;
  return item.content.replace(/\s+/g, ' ').trim();
}

/**
 * Who introduced an item (semantic / hybrid drafts only). Assistant ideas get
 * their own wording and colour so they never read like user requirements.
 */
export function originBadge(annotation: SemanticAnnotation): { label: string; tone: string; title: string } {
  switch (annotation.origin) {
    case 'user':
      return { label: 'User', tone: 'user', title: 'Stated by the user' };
    case 'assistant':
      return annotation.assertion === 'suggested'
        ? { label: 'Assistant suggestion', tone: 'suggestion', title: 'Proposed by the assistant; the user did not confirm it' }
        : { label: 'Assistant', tone: 'assistant', title: 'Stated by the assistant, not by the user' };
    case 'system':
      return { label: 'System', tone: 'system', title: 'From a system message' };
    case 'tool':
      return { label: 'Tool', tone: 'system', title: 'From a tool result' };
    default:
      return { label: 'Unknown source', tone: 'system', title: 'The source of this item is unclear' };
  }
}

export interface ContextItemRowProps {
  item: ContextItem;
  messageNumber?: number;
  selected: boolean;
  onToggle: (id: string) => void;
  /** Present for semantic / hybrid drafts. */
  annotation?: SemanticAnnotation;
}

export const ContextItemRow = memo(function ContextItemRow({ item, messageNumber, selected, onToggle, annotation }: ContextItemRowProps) {
  const id = `cp-item-${item.id}`;
  const extra = item.type === 'constraint' ? item.strength.replace('_', ' ') : item.type === 'decision' && item.status ? item.status : undefined;
  const badge = annotation ? originBadge(annotation) : null;
  const byModel = annotation?.extractors.some((e) => e.startsWith('cira.semantic@')) ?? false;
  return (
    <li className={`cp-row cp-row--item${selected ? ' cp-row--selected' : ''}`}>
      <input id={id} type="checkbox" className="cp-check" checked={selected} onChange={() => onToggle(item.id)} />
      <label htmlFor={id} className="cp-row-body">
        <span className="cp-row-head">
          <span className={`cp-type cp-type--${item.type}`}>{TYPE_LABEL[item.type]}</span>
          {extra && <span className="cp-type-extra">{extra}</span>}
          {badge && <span className={`cp-origin cp-origin--${badge.tone}`} title={badge.title}>{badge.label}</span>}
          {byModel && <span className="cp-type-extra cp-model-mark" title="Found by the semantic model; check it against the source message">model</span>}
          <span className="cp-row-num">{messageNumber ? `Message ${messageNumber}` : ''}</span>
        </span>
        <span className={item.type === 'code_artifact' ? 'cp-row-preview cp-mono' : 'cp-row-preview'}>{summaryOf(item)}</span>
      </label>
    </li>
  );
});
