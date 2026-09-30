import { useCallback, useDeferredValue, useMemo } from 'react';
import { visibleMessages, type CapturedMessage, type WorkspaceAction } from '../state/workspace';
import { EmptyState } from './EmptyState';
import { MessageRow } from './MessageRow';
import { MessageSearch } from './MessageSearch';
import { SelectionToolbar } from './SelectionToolbar';

export interface MessageSelectorProps {
  messages: CapturedMessage[];
  selected: ReadonlySet<number>;
  query: string;
  dispatch: (a: WorkspaceAction) => void;
}

export function MessageSelector({ messages, selected, query, dispatch }: MessageSelectorProps) {
  const deferredQuery = useDeferredValue(query);
  const visible = useMemo(() => visibleMessages({ messages, query: deferredQuery }), [messages, deferredQuery]);
  const onToggle = useCallback((index: number, range: boolean) => dispatch({ type: 'message/toggle', index, range }), [dispatch]);
  const filtered = query.trim().length > 0;

  return (
    <div className="cp-panel">
      <div className="cp-panel-top">
        <MessageSearch value={query} onChange={(q) => dispatch({ type: 'query', query: q })} matches={visible.length} total={messages.length} />
        <SelectionToolbar
          selected={selected.size}
          total={messages.length}
          noun="messages"
          filtered={filtered}
          onAll={() => dispatch({ type: 'messages/all' })}
          onNone={() => dispatch({ type: 'messages/none' })}
          onInvert={() => dispatch({ type: 'messages/invert' })}
        />
      </div>
      {visible.length === 0 ? (
        <EmptyState title="No matching messages" body={`Nothing in this conversation matches "${query}". Your selection is unchanged.`} />
      ) : (
        <ul className="cp-list" aria-label="Conversation messages">
          {visible.map((m) => (
            <MessageRow key={m.index} message={m} selected={selected.has(m.index)} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </div>
  );
}
