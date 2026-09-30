/**
 * Official CIRA logo, sourced from `src/assets/logo.svg` so there's a single
 * source of truth. The raw SVG ships at 54x54; we rewrite the width/height to
 * the requested size and let the viewBox handle scaling.
 */
import logoRaw from '@/assets/logo.svg?raw';

export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  const svg = logoRaw.replace(/width="\d+(?:\.\d+)?" height="\d+(?:\.\d+)?"/, `width="${size}" height="${size}"`);
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{ display: 'inline-flex', width: size, height: size, lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
