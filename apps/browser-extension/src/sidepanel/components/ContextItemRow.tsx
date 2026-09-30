import { memo } from 'react';
import type { ContextItem } from '@cira/core';

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

export interface ContextItemRowProps {
  item: ContextItem;
  messageNumber?: number;
  selected: boolean;
  onToggle: (id: string) => void;
}

export const ContextItemRow = memo(function ContextItemRow({ item, messageNumber, selected, onToggle }: ContextItemRowProps) {
  const id = `cp-item-${item.id}`;
  const extra = item.type === 'constraint' ? item.strength.replace('_', ' ') : item.type === 'decision' && item.status ? item.status : undefined;
  return (
    <li className={`cp-row cp-row--item${selected ? ' cp-row--selected' : ''}`}>
      <input id={id} type="checkbox" className="cp-check" checked={selected} onChange={() => onToggle(item.id)} />
      <label htmlFor={id} className="cp-row-body">
        <span className="cp-row-head">
          <span className={`cp-type cp-type--${item.type}`}>{TYPE_LABEL[item.type]}</span>
          {extra && <span className="cp-type-extra">{extra}</span>}
          <span className="cp-row-num">{messageNumber ? `Message ${messageNumber}` : ''}</span>
        </span>
        <span className={item.type === 'code_artifact' ? 'cp-row-preview cp-mono' : 'cp-row-preview'}>{summaryOf(item)}</span>
      </label>
    </li>
  );
});
