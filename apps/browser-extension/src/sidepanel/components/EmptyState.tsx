import type { ReactNode } from 'react';
import { ChatIcon } from './icons';

export function EmptyState({ title, body, icon, children }: { title: string; body?: string; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="cp-empty" role="status">
      <div className="cp-empty-icon">{icon ?? <ChatIcon size={20} />}</div>
      <div className="cp-empty-title">{title}</div>
      {body && <p className="cp-empty-body">{body}</p>}
      {children}
    </div>
  );
}
