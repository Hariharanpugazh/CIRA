import { useState } from 'react';
import { describeSync } from '@/shared/context-client';
import { itemMessageNumber } from '@/shared/context-selection';
import { brandFor } from '../brands';
import type { ActiveContext } from '../state/workspace';
import { TYPE_LABEL } from './ContextItemRow';

export interface ActiveContextCardProps {
  active: ActiveContext;
  onEdit: () => void;
  onReplace: () => void;
  onClear: () => void;
  busy: boolean;
}

/** Compact card for the context currently carried forward. */
export function ActiveContextCard({ active, onEdit, onReplace, onClear, busy }: ActiveContextCardProps) {
  const [open, setOpen] = useState(false);
  const where = active.saved ? (active.sync ? describeSync(active.sync).label : 'Saved in browser') : 'Not saved';
  return (
    <section className="cp-active" aria-label="Active context">
      <div className="cp-active-row">
        <div className="cp-active-main">
          <div className="cp-eyebrow">Active context</div>
          <div className="cp-active-title" title={active.title}>{active.title}</div>
          <div className="cp-active-meta">
            {brandFor(active.source).name} · {active.messageCount} message{active.messageCount === 1 ? '' : 's'} · {active.itemCount} item{active.itemCount === 1 ? '' : 's'} · {where}
          </div>
        </div>
      </div>
      <div className="cp-active-actions">
        <button type="button" className="cp-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'View'}</button>
        <button type="button" className="cp-link" onClick={onEdit} disabled={busy}>Edit</button>
        <button type="button" className="cp-link" onClick={onReplace} disabled={busy}>Replace</button>
        <button type="button" className="cp-link cp-link--danger" onClick={onClear} disabled={busy}>Clear</button>
      </div>
      {open && (
        <ul className="cp-active-items">
          {active.document.items.map((item) => (
            <li key={item.id}>
              <span className={`cp-type cp-type--${item.type}`}>{TYPE_LABEL[item.type]}</span>
              <span className="cp-active-item-text">{item.type === 'code_artifact' ? `${item.language} · ${item.content.split('\n').length} lines` : item.content}</span>
              <span className="cp-row-num">#{itemMessageNumber(active.document, item) ?? '–'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
