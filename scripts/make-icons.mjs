/**
 * Generates the extension's toolbar PNG icons from the official logo
 * (`src/assets/logo.svg`) so there's a single source of truth for the brand.
 *
 * Run: `node scripts/make-icons.mjs`
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = resolve(__dirname, '..', 'src', 'assets');
mkdirSync(assetsDir, { recursive: true });

const logoPath = resolve(assetsDir, 'logo.svg');
const svg = readFileSync(logoPath);

const SIZES = [16, 32, 48, 128];

for (const size of SIZES) {
  const out = resolve(assetsDir, `icon-${size}.png`);
  // Render the SVG at the target size on a transparent background. The logo's
  // viewBox handles scaling; sharp's `density` keeps small sizes crisp.
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out);
  console.log('wrote', out);
}
