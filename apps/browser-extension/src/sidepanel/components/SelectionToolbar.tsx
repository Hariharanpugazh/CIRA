export interface SelectionToolbarProps {
  selected: number;
  total: number;
  noun: string;
  /** Bulk actions apply to the visible (filtered) rows. */
  filtered?: boolean;
  onAll: () => void;
  onNone: () => void;
  onInvert?: () => void;
}

export function SelectionToolbar({ selected, total, noun, filtered, onAll, onNone, onInvert }: SelectionToolbarProps) {
  return (
    <div className="cp-toolbar">
      <span className="cp-toolbar-count" aria-live="polite">
        Selected <strong>{selected}</strong> / {total} {noun}
      </span>
      <span className="cp-toolbar-actions">
        <button type="button" className="cp-link" onClick={onAll}>{filtered ? 'Select matches' : 'Select all'}</button>
        <button type="button" className="cp-link" onClick={onNone}>{filtered ? 'Clear matches' : 'Clear all'}</button>
        {onInvert && <button type="button" className="cp-link" onClick={onInvert}>Invert</button>}
      </span>
    </div>
  );
}
