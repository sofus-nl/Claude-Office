/**
 * scripts/split-character.mjs and scripts/extract-boss-sprite.mjs — the Node
 * ports of the Pillow scripts. tests/fixtures/sprites/expected/ holds what the
 * original .py scripts wrote for each input (see generate.py there); every
 * output must decode to the same RGBA pixels. Both sides are RGBA8 files, so
 * comparing decoded pixels is exact.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodePng } from '../scripts/png.mjs'

const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/sprites', import.meta.url))
const DIRECTIONS = ['front-left', 'front-right', 'rear-left', 'rear-right']

// fixture -> [bit depth, colour type] of the input file.
const INPUTS: Record<string, [number, number]> = {
  'gray8-trns': [8, 0],
  'rgb8': [8, 2],
  'rgb8-trns': [8, 2],
  'pal8-trns': [8, 3],
  'pal4-trns': [4, 3],
  'pal2-trns': [2, 3],
  'la8': [8, 4],
  'rgba8': [8, 6],
  'filters-all': [8, 6],
}

const read = (...p: string[]) => readFileSync(join(...p))
const run = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

let tmp: string
let repo: string // a copy of the scripts the extract tool writes public/ next to

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sprite-tools-'))
  repo = join(tmp, 'repo')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  for (const f of ['extract-boss-sprite.mjs', 'png.mjs', 'generate-icons.mjs']) copyFileSync(join(SCRIPTS, f), join(repo, 'scripts', f))
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function expectSamePixels(actualFile: string, expectedFile: string) {
  const expected = read(expectedFile)
  expect([expected[24], expected[25]], `${expectedFile} should be RGBA8`).toEqual([8, 6])
  const a = decodePng(read(actualFile))
  const e = decodePng(expected)
  expect([a.width, a.height]).toEqual([e.width, e.height])
  expect(a.rgba.equals(e.rgba)).toBe(true)
}

describe('fixtures', () => {
  it.each(Object.entries(INPUTS))('%s is the expected PNG flavour', (name, [depth, type]) => {
    const f = read(FIXTURES, `${name}.png`)
    expect([f[24], f[25], f[28]]).toEqual([depth, type, 0])
  })
})

describe('split-character.mjs', () => {
  it.each(Object.keys(INPUTS))('%s splits like Pillow', (name) => {
    const out = join(tmp, 'split', name)
    const r = run(join(SCRIPTS, 'split-character.mjs'), join(FIXTURES, `${name}.png`), name, '--output-dir', out)
    expect(r.status).toBe(0)
    expect(readdirSync(out).sort()).toEqual(DIRECTIONS.map((d) => `${name}-1-${d}.png`))
    for (const d of DIRECTIONS) expectSamePixels(join(out, `${name}-1-${d}.png`), join(FIXTURES, 'expected', 'split', `${name}-1-${d}.png`))
    expect(r.stdout).toContain(`export const BOSS_CHAR = '${name}-1'`)
  })

  it('keeps an all-transparent quadrant untrimmed, like Pillow', () => {
    const out = join(tmp, 'split', 'rgba8')
    expect(decodePng(read(out, 'rgba8-1-rear-right.png'))).toMatchObject({ width: 8, height: 6 })
  })

  it('fails on a missing input', () => {
    const r = run(join(SCRIPTS, 'split-character.mjs'), join(tmp, 'nope.png'), 'x', '-o', join(tmp, 'o'))
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('Error: Input file not found')
  })

  it('needs both positionals', () => {
    expect(run(join(SCRIPTS, 'split-character.mjs'), 'only-one').status).toBe(2)
  })

  it.each(['gray16-reject', 'gray4-reject', 'interlaced-reject'])('rejects %s, naming the input', (name) => {
    const input = join(FIXTURES, `${name}.png`)
    const r = run(join(SCRIPTS, 'split-character.mjs'), input, 'x', '-o', join(tmp, 'rej'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(input)
  })
})

describe('extract-boss-sprite.mjs', () => {
  it.each(Object.keys(INPUTS))('%s extracts like Pillow', (name) => {
    const r = run(join(repo, 'scripts', 'extract-boss-sprite.mjs'), join(FIXTURES, `${name}.png`), name)
    expect(r.status).toBe(0)
    const out = join(repo, 'public', 'sprites', 'characters')
    for (const d of DIRECTIONS) {
      expectSamePixels(join(out, `${name}-${d}.png`), join(FIXTURES, 'expected', 'extract', `${name}-${d}.png`))
      expect(r.stdout).toContain(`  Saved: ${name}-${d}.png (`)
    }
    expect(r.stdout).toContain(`boss.sprite to "${name}"`)
  })

  it('prints usage and exits 1 without arguments', () => {
    const r = run(join(repo, 'scripts', 'extract-boss-sprite.mjs'), 'only-one')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('Usage:')
  })

  it.each(['gray16-reject', 'gray4-reject', 'interlaced-reject'])('rejects %s, naming the input', (name) => {
    const input = join(FIXTURES, `${name}.png`)
    const r = run(join(repo, 'scripts', 'extract-boss-sprite.mjs'), input, 'x')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(input)
  })
})
