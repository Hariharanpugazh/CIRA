import { CloseIcon, SearchIcon } from './icons';

export function MessageSearch({ value, onChange, matches, total }: { value: string; onChange: (v: string) => void; matches: number; total: number }) {
  return (
    <div className="cp-search">
      <SearchIcon size={14} className="cp-search-icon" />
      <input
        type="search"
        value={value}
        placeholder="Search conversation"
        aria-label="Search conversation"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('');
        }}
      />
      {value && (
        <>
          <span className="cp-search-count" aria-live="polite">{matches}/{total}</span>
          <button type="button" className="cp-icon-btn cp-icon-btn--sm" aria-label="Clear search" onClick={() => onChange('')}>
            <CloseIcon size={13} />
          </button>
        </>
      )}
    </div>
  );
}
