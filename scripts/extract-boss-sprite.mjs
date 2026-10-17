#!/usr/bin/env node
/**
 * Extract 4 directional sprites from a ChatGPT-generated sprite sheet.
 *
 * Usage:
 *   1. Use ChatGPT (with DALL-E) to generate a character sprite sheet
 *      based on the Helper.png template in public/sprites/characters/
 *   2. Save the output as a single PNG
 *   3. Run: node scripts/extract-boss-sprite.mjs <input.png> <sprite-name>
 *
 * This will create 4 files in public/sprites/characters/:
 *   <sprite-name>-front-left.png
 *   <sprite-name>-front-right.png  (used as rear-left in Helper layout)
 *   <sprite-name>-rear-left.png
 *   <sprite-name>-rear-right.png
 *
 * The layout expected matches Helper.png:
 *   [Front-Left] [Rear-Right] [Front-Right] [Rear-Left]
 *   (4 poses in a single row)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crop, decodePng, encodePng, trim } from './png.mjs'

const [input, spriteName] = process.argv.slice(2)
if (!input || !spriteName) {
  console.log('Usage: node extract-boss-sprite.mjs <input.png> <sprite-name>')
  console.log('Example: node extract-boss-sprite.mjs my-character.png MyChar-1')
  process.exit(1)
}

let img
try {
  img = decodePng(readFileSync(input))
} catch (e) {
  console.error(`Error: ${input}: ${e.message}`)
  process.exit(1)
}

// Detect the sprite region (exclude labels at bottom)
// Crop to top ~80% to remove text labels
const cropH = Math.floor(img.height * 0.82)
img = crop(img, 0, 0, img.width, cropH)
const { width: w, height: h } = img

// Split into 4 equal columns
const colW = w >> 2
const positions = {
  'front-left': [0, 0, colW, h],
  'rear-right': [colW, 0, colW * 2, h], // Helper layout
  'front-right': [colW * 2, 0, colW * 3, h],
  'rear-left': [colW * 3, 0, w, h],
}

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sprites', 'characters')
mkdirSync(outDir, { recursive: true })

for (const [direction, box] of Object.entries(positions)) {
  // Auto-trim transparent edges
  const sprite = trim(crop(img, ...box))
  const outName = `${spriteName}-${direction}.png`
  writeFileSync(join(outDir, outName), encodePng(sprite))
  console.log(`  Saved: ${outName} (${sprite.width}x${sprite.height})`)
}

console.log(`\nDone! Update office.config.json to set boss.sprite to "${spriteName}"`)
