/**
 * Generates the extension's toolbar PNG icons from the official logo
 * (`src/assets/logo.svg`) so there's a single source of truth for the brand.
 *
 * Run: `npm run icons` (or `node scripts/make-icons.mjs`)
 *
 * `sharp` is an optional dependency: if it didn't install (e.g. on a Node
 * version without prebuilt binaries), this script prints a clear hint
 * instead of crashing. The committed PNGs in `src/assets/` are the source
 * of truth at build time, so the extension still builds without sharp.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let sharp;
try {
  ({ default: sharp } = await import('sharp'));
} catch (err) {
  console.error('sharp is not installed. Install it on demand with:');
  console.error('  npm install --no-save sharp');
  console.error('Then rerun: npm run icons');
  process.exit(1);
}

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
