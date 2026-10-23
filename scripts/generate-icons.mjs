#!/usr/bin/env node
/**
 * Generate Veilpay extension icons.
 *
 * Resizes the official logo (src/ui/assets/icons/logo.png) into the three
 * extension icon sizes (16, 48, 128). Uses Sharp for efficient rendering.
 */

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '..', 'public', 'icons');

// Define sizes for extension icons
const sizes = [16, 48, 128];
const sourceLogo = join(__dirname, '..', 'src', 'ui', 'assets', 'icons', 'logo.png');

async function main() {
  try {
    await mkdir(iconsDir, { recursive: true });
    console.log(`Icons directory: ${iconsDir}`);

    for (const size of sizes) {
      const path = join(iconsDir, `icon-${size}.png`);
      const info = await sharp(sourceLogo)
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(path);
      console.log(`✓ Generated icon-${size}.png (${info.size} bytes)`);
    }

    console.log('\n✓ All icons generated successfully from official logo.png.');
  } catch (error) {
    console.error('Failed to generate icons:', error.message);
    process.exit(1);
  }
}

await main();
