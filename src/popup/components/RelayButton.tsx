import { useState, useCallback } from 'react';

interface Props {
  target: string;
  label: string;
  accentColor: string;
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}

export function RelayButton({ label, accentColor, disabled, loading, onClick }: Props) {
  const [transform, setTransform] = useState('');

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (disabled || loading) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      setTransform(`translate(${x * 0.08}px, ${y * 0.08}px)`);
    },
    [disabled, loading],
  );

  const handleMouseLeave = useCallback(() => {
    setTransform('');
  }, []);

  return (
    <button
      className={`relay-button ${loading ? 'relay-button--loading' : ''}`}
      style={{
        '--accent': accentColor,
        transform: transform || undefined,
      } as React.CSSProperties}
      disabled={disabled}
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <span className="relay-button-icon">⚡</span>
      <span className="relay-button-label">{label}</span>
      {loading && <span className="relay-button-cursor">▊</span>}
    </button>
  );
}
