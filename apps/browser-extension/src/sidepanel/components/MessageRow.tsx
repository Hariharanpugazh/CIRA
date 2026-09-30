import { memo, useState } from 'react';
import type { CapturedMessage } from '../state/workspace';

export interface MessageRowProps {
  message: CapturedMessage;
  selected: boolean;
  onToggle: (index: number, range: boolean) => void;
}

/** One selectable message. Memoized: only rows whose selection changed re-render. */
export const MessageRow = memo(function MessageRow({ message, selected, onToggle }: MessageRowProps) {
  const [expanded, setExpanded] = useState(false);
  const id = `cp-msg-${message.index}`;
  return (
    <li className={`cp-row${selected ? ' cp-row--selected' : ''}`}>
      <input
        id={id}
        type="checkbox"
        className="cp-check"
        checked={selected}
        // React fires onChange from the click event, so Shift is readable here:
        // Shift+click selects the range from the previous click.
        onChange={(e) => onToggle(message.index, (e.nativeEvent as MouseEvent).shiftKey === true)}
        aria-describedby={`${id}-text`}
      />
      <div className="cp-row-body">
        <label htmlFor={id} className="cp-row-head">
          <span className={`cp-role cp-role--${message.role}`}>{message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'System'}</span>
          <span className="cp-row-num">#{message.index + 1}</span>
        </label>
        <div id={`${id}-text`} className={expanded ? 'cp-row-full' : 'cp-row-preview'}>
          {expanded ? message.content : message.preview}
        </div>
        {message.long && (
          <button type="button" className="cp-link cp-link--sm" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </li>
  );
});
