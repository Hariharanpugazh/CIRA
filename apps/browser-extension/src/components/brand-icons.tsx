/**
 * React wrappers around the shared official-brand-icon data
 * (`@/shared/brand-icons-data`). Used by both the side panel and the popup so
 * every surface renders identical, correctly-tinted logos.
 */
import { getBrandIcon, hasBrandIcon } from '@/shared/brand-icons-data';

export { hasBrandIcon };

export function BrandIcon({ source, size = 16 }: { source: string; size?: number }) {
  const def = getBrandIcon(source);
  if (!def) return null;
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        width: size,
        height: size,
        fontSize: size,
        lineHeight: 0,
        color: def.fg,
      }}
      dangerouslySetInnerHTML={{ __html: def.svg }}
    />
  );
}

/**
 * Platform avatar tile. Official marks sit on their per-brand chip so both
 * color and monochrome logos stay legible; otherwise a brand-colored lettered
 * tile is used as fallback.
 */
export function PlatformAvatar({
  source,
  initial,
  color,
  size = 24,
  radius = 7,
}: {
  source: string;
  initial: string;
  color: string;
  size?: number;
  radius?: number;
}) {
  const def = getBrandIcon(source);
  if (def) {
    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: def.chipBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxSizing: 'border-box',
          padding: Math.round(size * 0.18),
        }}
      >
        <BrandIcon source={source} size={Math.round(size * 0.64)} />
      </span>
    );
  }
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: color,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.46),
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initial}
    </span>
  );
}
