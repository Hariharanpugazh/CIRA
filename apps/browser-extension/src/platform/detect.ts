import type { Source } from '@/shared/schema';
import { RELAY_TARGETS, SITE_PATTERNS } from './urls';

/** Map a tab URL to the CIRA platform id used by the popup and side panel. */
export function detectSource(url: string | undefined): Source {
  if (!url) return 'unknown';
  for (const [source, pattern] of Object.entries(SITE_PATTERNS)) {
    if (pattern.test(url)) return source as Source;
  }
  return 'unknown';
}

/** Platforms the user can relay to from `current`. */
export function getAvailableTargets(current: Source): Source[] {
  return RELAY_TARGETS.filter((s) => s !== current);
}
