import { useEffect, useRef, useState } from 'react';
import { PlatformAvatar } from '@/components/brand-icons';
import { Logo } from '@/components/Logo';
import { brandFor } from '../brands';
import { MoreIcon } from './icons';

export interface MenuAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export function Header({ source, actions }: { source: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const brand = brandFor(source);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <header className="cp-header">
      <span className="cp-logo"><Logo size={18} /></span>
      <span className="cp-brand">CIRA</span>
      {source !== 'unknown' && (
        <span className="cp-chip" title={`Current tab: ${brand.name}`}>
          <PlatformAvatar source={source} initial={brand.initial} color={brand.color} size={14} radius={4} />
          {brand.name}
        </span>
      )}
      <div className="cp-menu" ref={ref}>
        <button type="button" className="cp-icon-btn" aria-label="Menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <MoreIcon />
        </button>
        {open && (
          <div className="cp-menu-list" role="menu">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                disabled={a.disabled}
                onClick={() => {
                  setOpen(false);
                  a.onSelect();
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
