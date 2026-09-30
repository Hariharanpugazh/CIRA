import { brandFor } from '../brands';
import type { Step } from '../state/workspace';

const STATUS: Record<Step, string> = {
  idle: 'Not captured',
  select: 'Selecting messages',
  review: 'Reviewing context',
  send: 'Ready to send',
  success: 'Context ready',
};

export function ConversationHeader({ title, source, messageCount, step }: { title: string; source: string; messageCount: number; step: Step }) {
  return (
    <section className="cp-conv" aria-label="Current conversation">
      <div className="cp-conv-title" title={title}>{title}</div>
      <div className="cp-conv-meta">
        <span>{brandFor(source).name}</span>
        <span aria-hidden="true">·</span>
        <span>{messageCount} message{messageCount === 1 ? '' : 's'}</span>
        <span className={`cp-pill${step === 'success' ? ' cp-pill--ok' : ''}`}>{STATUS[step]}</span>
      </div>
    </section>
  );
}
