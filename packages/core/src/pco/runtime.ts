import { z } from 'zod';

/**
 * Disable Zod's `new Function` fast path. Call once at start-up in
 * environments with a strict Content Security Policy (browser extensions,
 * some mobile webviews); otherwise Zod's eval probe is reported as a CSP
 * violation even though it falls back safely.
 */
export function useStrictCspRuntime(): void {
  z.config({ jitless: true });
}
