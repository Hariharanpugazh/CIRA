import { useCallback, useMemo, type ReactNode } from 'react';
import { getSemanticExtension, type PCODocument } from '@cira/core';
import { itemMessageNumber } from '@/shared/context-selection';
import type { WorkspaceAction } from '../state/workspace';
import { ContextItemRow } from './ContextItemRow';
import { EmptyState } from './EmptyState';
import { LayersIcon } from './icons';
import { SelectionToolbar } from './SelectionToolbar';

export interface ContextReviewProps {
  draft: PCODocument;
  removed: ReadonlySet<string>;
  dispatch: (a: WorkspaceAction) => void;
  children?: ReactNode;
}

export function ContextReview({ draft, removed, dispatch, children }: ContextReviewProps) {
  const rows = useMemo(() => {
    const annotations = getSemanticExtension(draft)?.items;
    return draft.items.map((item) => ({ item, messageNumber: itemMessageNumber(draft, item), annotation: annotations?.[item.id] }));
  }, [draft]);
  const onToggle = useCallback((id: string) => dispatch({ type: 'item/toggle', id }), [dispatch]);
  const selected = rows.filter((r) => !removed.has(r.item.id)).length;

  if (rows.length === 0) {
    return (
      <div className="cp-panel">
        <EmptyState icon={<LayersIcon size={20} />} title="No context items" body="No transferable context was found in the selected messages. Go back and select different messages." />
        {children}
      </div>
    );
  }

  return (
    <div className="cp-panel">
      <div className="cp-panel-top">
        <div className="cp-section-title">Context to transfer</div>
        <SelectionToolbar
          selected={selected}
          total={rows.length}
          noun="context items"
          onAll={() => dispatch({ type: 'items/all' })}
          onNone={() => dispatch({ type: 'items/none' })}
        />
      </div>
      <ul className="cp-list" aria-label="Extracted context items">
        {rows.map(({ item, messageNumber, annotation }) => (
          <ContextItemRow key={item.id} item={item} messageNumber={messageNumber} selected={!removed.has(item.id)} onToggle={onToggle} annotation={annotation} />
        ))}
      </ul>
      {children}
    </div>
  );
}
