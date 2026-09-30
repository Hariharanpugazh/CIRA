import { brandFor } from '../brands';

export interface ContextSummaryProps {
  messages: number;
  totalMessages: number;
  items: number;
  tokens: number;
  source: string;
  warnings?: string[];
}

export function ContextSummary({ messages, totalMessages, items, tokens, source, warnings = [] }: ContextSummaryProps) {
  return (
    <div className="cp-summary">
      <dl>
        <div><dt>Messages selected</dt><dd>{messages} / {totalMessages}</dd></div>
        <div><dt>Context items</dt><dd>{items}</dd></div>
        <div><dt>Estimated tokens</dt><dd>~{tokens.toLocaleString()}</dd></div>
        <div><dt>Source</dt><dd>{brandFor(source).name}</dd></div>
      </dl>
      {warnings.length > 0 && (
        <p className="cp-summary-warn" role="alert">
          Potential secret{warnings.length === 1 ? '' : 's'} in the selected context. Review before sharing: {warnings.join(' ')}
        </p>
      )}
    </div>
  );
}
