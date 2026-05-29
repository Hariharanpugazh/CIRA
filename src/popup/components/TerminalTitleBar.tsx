import type { Source } from '@/core/schema';

interface Props {
  source: Source;
  isConnected: boolean;
  onSettings: () => void;
  onClose: () => void;
}

export function TerminalTitleBar({ source, isConnected, onSettings, onClose }: Props) {
  return (
    <div className="terminal-titlebar">
      <div className="terminal-dots">
        <span className="terminal-dot dot-red" />
        <span className="terminal-dot dot-amber" />
        <span className="terminal-dot dot-green" />
      </div>
      <div className="terminal-title-text">
        <span className="terminal-title-brand">CIRA</span>
        {source !== 'unknown' && (
          <span className="terminal-title-source"> — {source.toUpperCase()}</span>
        )}
      </div>
      <div className="terminal-title-actions">
        <span className={`connection-indicator ${isConnected ? 'connected' : 'disconnected'}`} />
        <button className="terminal-icon-btn" onClick={onSettings} aria-label="Settings">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
        </button>
        <button className="terminal-icon-btn" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
