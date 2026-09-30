import type { ReactNode } from 'react';
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from './icons';

export type StatusLevel = 'info' | 'success' | 'warn' | 'error';

export function StatusBanner({ level, title, children, onDismiss, action }: { level: StatusLevel; title: string; children?: ReactNode; onDismiss?: () => void; action?: ReactNode }) {
  const Icon = level === 'success' ? CheckIcon : level === 'info' ? InfoIcon : AlertIcon;
  return (
    <div className={`cp-banner cp-banner--${level}`} role={level === 'error' ? 'alert' : 'status'}>
      <Icon size={15} className="cp-banner-icon" />
      <div className="cp-banner-body">
        <div className="cp-banner-title">{title}</div>
        {children && <div className="cp-banner-text">{children}</div>}
        {action && <div className="cp-banner-action">{action}</div>}
      </div>
      {onDismiss && (
        <button type="button" className="cp-icon-btn cp-icon-btn--sm" aria-label="Dismiss" onClick={onDismiss}>
          <CloseIcon size={13} />
        </button>
      )}
    </div>
  );
}
