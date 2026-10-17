#!/usr/bin/env node
/**
 * split-character.mjs — Split a 2x2 character sprite sheet into 4 directional images.
 *
 * Usage:
 *     node scripts/split-character.mjs <input-image> <character-name> [--output-dir <dir>]
 *
 * Example:
 *     node scripts/split-character.mjs my-character.png "Antony"
 *     node scripts/split-character.mjs my-character.png "Antony" --output-dir ./public/sprites/characters
 *
 * The input image should be a 2x2 grid:
 *     ┌──────────┬──────────┐
 *     │front-left│front-right│
 *     ├──────────┼──────────┤
 *     │rear-left │rear-right │
 *     └──────────┴──────────┘
 *
 * Outputs 4 files:
 *     {name}-1-front-left.png
 *     {name}-1-front-right.png
 *     {name}-1-rear-left.png
 *     {name}-1-rear-right.png
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { crop, decodePng, encodePng, trim } from './png.mjs'

const USAGE = 'usage: split-character.mjs [-h] [--output-dir OUTPUT_DIR] input name'

let args
try {
  args = parseArgs({
    allowPositionals: true,
    options: { 'output-dir': { type: 'string', short: 'o' }, help: { type: 'boolean', short: 'h' } },
  })
  if (!args.values.help && args.positionals.length !== 2) throw new Error('expected <input> and <name>')
} catch (e) {
  console.error(`${USAGE}\nsplit-character.mjs: error: ${e.message}`)
  process.exit(2)
}
if (args.values.help) {
  console.log(`${USAGE}\n\nSplit a 2x2 character sprite sheet into 4 directional images.`)
  process.exit(0)
}

const [input, name] = args.positionals
const outputDir = args.values['output-dir'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sprites', 'characters')

if (!existsSync(input)) {
  console.log(`Error: Input file not found: ${input}`)
  process.exit(1)
}

mkdirSync(outputDir, { recursive: true })

console.log(`\nSplitting ${input} into 4 directions for '${name}':`)
console.log(`Output: ${outputDir}\n`)

let img
try {
  img = decodePng(readFileSync(input))
} catch (e) {
  console.error(`Error: ${input}: ${e.message}`)
  process.exit(1)
}
const { width: w, height: h } = img
const halfW = w >> 1
const halfH = h >> 1

const quadrants = {
  'front-left': crop(img, 0, 0, halfW, halfH),
  'front-right': crop(img, halfW, 0, w, halfH),
  'rear-left': crop(img, 0, halfH, halfW, h),
  'rear-right': crop(img, halfW, halfH, w, h),
}

for (const [direction, quadrant] of Object.entries(quadrants)) {
  // Auto-trim transparent edges
  const out = trim(quadrant)
  // Joined as Python's os.path.join does, so the printed path is the same.
  const filepath = `${outputDir}${/[\/]$/.test(outputDir) ? '' : sep}${name}-1-${direction}.png`
  writeFileSync(filepath, encodePng(out))
  console.log(`  ✓ ${filepath} (${out.width}x${out.height})`)
}

console.log(`\nDone! Now update src/config.ts:`)
console.log(`  export const BOSS_CHAR = '${name}-1'`)
console.log(`\nAnd update src/types.ts:`)
console.log(`  'boss': { color: '#ff4444', emoji: '👑', title: '${name}' },`)
console.log()
