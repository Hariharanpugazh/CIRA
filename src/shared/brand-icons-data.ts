/**
 * Framework-agnostic official AI/LLM brand marks, sourced from
 * `@lobehub/icons-static-svg` (dependency-free static SVGs, official colors).
 *
 * This module holds the raw SVG markup plus per-brand "chip" styling so every
 * surface (React side panel/popup and the plain-DOM relay pill content script)
 * renders identical, correctly-tinted logos. It intentionally avoids React so
 * the content-script bundle stays lean.
 *
 * Why per-brand chip styling instead of a single white tile:
 *  - Color marks (Claude, Gemini, …) carry their own fills and sit on white.
 *  - Kimi's color glyph is white, so it needs a dark chip to be visible.
 *  - Monochrome marks (OpenAI, Grok, Z.ai, NotebookLM) inherit `currentColor`,
 *    so we set a sensible foreground per brand.
 *  - Poe outlines its body with `currentColor`; without a foreground it would
 *    disappear on white.
 *
 * Platforms not in the icon set (You.com, Character.AI, Pi) are absent — callers
 * fall back to a lettered tile via `hasBrandIcon`.
 */
import openai from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import claude from '@lobehub/icons-static-svg/icons/claude-color.svg?raw';
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg?raw';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw';
import perplexity from '@lobehub/icons-static-svg/icons/perplexity-color.svg?raw';
import copilot from '@lobehub/icons-static-svg/icons/copilot-color.svg?raw';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?raw';
import kimi from '@lobehub/icons-static-svg/icons/kimi-color.svg?raw';
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg?raw';
import poe from '@lobehub/icons-static-svg/icons/poe-color.svg?raw';
import huggingface from '@lobehub/icons-static-svg/icons/huggingface-color.svg?raw';
import notebooklm from '@lobehub/icons-static-svg/icons/notebooklm.svg?raw';
import zai from '@lobehub/icons-static-svg/icons/zai.svg?raw';
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg?raw';

export interface BrandIcon {
  /** Raw inline SVG markup (width/height are `1em`, so font-size scales it). */
  svg: string;
  /** Chip background behind the mark. Defaults to white for color logos. */
  chipBg: string;
  /** `currentColor` applied to the mark (only affects monochrome marks). */
  fg: string;
}

const WHITE = '#ffffff';
const INK = '#0d0d0d';

export const BRAND_ICONS: Record<string, BrandIcon> = {
  chatgpt: { svg: openai, chipBg: WHITE, fg: INK },
  claude: { svg: claude, chipBg: WHITE, fg: INK },
  gemini: { svg: gemini, chipBg: WHITE, fg: INK },
  deepseek: { svg: deepseek, chipBg: WHITE, fg: INK },
  perplexity: { svg: perplexity, chipBg: WHITE, fg: INK },
  copilot: { svg: copilot, chipBg: WHITE, fg: INK },
  grok: { svg: grok, chipBg: WHITE, fg: INK },
  kimi: { svg: kimi, chipBg: '#16161a', fg: WHITE },
  qwen: { svg: qwen, chipBg: WHITE, fg: INK },
  poe: { svg: poe, chipBg: WHITE, fg: '#5d5cde' },
  huggingchat: { svg: huggingface, chipBg: WHITE, fg: INK },
  notebooklm: { svg: notebooklm, chipBg: WHITE, fg: '#1a73e8' },
  zai: { svg: zai, chipBg: WHITE, fg: INK },
  mistral: { svg: mistral, chipBg: WHITE, fg: INK },
};

export function hasBrandIcon(source: string): boolean {
  return source in BRAND_ICONS;
}

export function getBrandIcon(source: string): BrandIcon | undefined {
  return BRAND_ICONS[source];
}
