/**
 * png.mjs — the PNG reading the sprite tools need, with no dependencies.
 * Writing is generate-icons.mjs's encodePng (RGBA8, filter 0).
 *
 * decodePng() mirrors Pillow's `convert('RGBA')`: 8-bit grey / RGB / palette
 * (1-8 bit) / grey+alpha / RGBA, with tRNS honoured for grey, RGB and palette.
 * It refuses what the sprite tools never meet — 16-bit, interlaced and
 * sub-byte greyscale — instead of guessing.
 */

import { inflateSync } from 'node:zlib'

export { encodePng } from './generate-icons.mjs'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decode a PNG file to { width, height, rgba } (rgba is a Buffer, 4 bytes per pixel). */
export function decodePng(file) {
  if (file.length < 8 || !file.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file')
  let ihdr = null
  let plte = null
  let trns = null
  const idat = []
  for (let pos = 8; pos + 8 <= file.length; ) {
    const len = file.readUInt32BE(pos)
    const type = file.toString('ascii', pos + 4, pos + 8)
    const data = file.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') ihdr = data
    else if (type === 'PLTE') plte = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (!ihdr) throw new Error('PNG has no IHDR chunk')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const depth = ihdr[8]
  const colorType = ihdr[9]
  const channels = CHANNELS[colorType]
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`)
  if (ihdr[12] === 1) throw new Error('interlaced PNGs are not supported')
  if (depth === 16) throw new Error('16-bit PNGs are not supported')
  if (depth < 8 && colorType !== 3) throw new Error(`${depth}-bit greyscale PNGs are not supported`)
  if (colorType === 3 && !plte) throw new Error('palette PNG has no PLTE chunk')

  const bpp = Math.max(1, (channels * depth) >> 3) // filter distance in bytes
  const stride = Math.ceil((width * channels * depth) / 8)
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length < (stride + 1) * height) throw new Error('PNG pixel data is truncated')
  const px = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0
      const b = y > 0 ? px[dst - stride + x] : 0
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0
      let v = raw[src + x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) v += paeth(a, b, c)
      else if (filter !== 0) throw new Error(`bad PNG filter type ${filter}`)
      px[dst + x] = v & 0xff
    }
  }

  // tRNS: grey / RGB hold a colour key (16-bit values), palette holds per-entry alpha.
  const key = trns && colorType === 0 ? [trns.readUInt16BE(0)] : trns && colorType === 2 ? [0, 2, 4].map((o) => trns.readUInt16BE(o)) : null
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const p = y * stride
      let r, g, b, a = 255
      if (colorType === 3) {
        const bit = x * depth
        const i = (px[p + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
        if (i * 3 + 2 >= plte.length) throw new Error('palette index out of range')
        r = plte[i * 3]; g = plte[i * 3 + 1]; b = plte[i * 3 + 2]
        if (trns && i < trns.length) a = trns[i]
      } else {
        const q = p + x * channels
        r = px[q]
        if (colorType === 0 || colorType === 4) { g = r; b = r } else { g = px[q + 1]; b = px[q + 2] }
        if (colorType === 4) a = px[q + 1]
        else if (colorType === 6) a = px[q + 3]
        else if (key && r === key[0] && g === (key[1] ?? r) && b === (key[2] ?? r)) a = 0
      }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a
    }
  }
  return { width, height, rgba }
}

/** Crop to [x0, y0, x1, y1) (like Pillow's Image.crop). */
export function crop({ width, rgba }, x0, y0, x1, y1) {
  const w = x1 - x0
  const h = y1 - y0
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) rgba.copy(out, y * w * 4, ((y0 + y) * width + x0) * 4, ((y0 + y) * width + x1) * 4)
  return { width: w, height: h, rgba: out }
}

/** Bounding box of the pixels with alpha != 0, or null when there are none (like Pillow's getbbox on RGBA). */
export function getBbox({ width, height, rgba }) {
  let x0 = width, y0 = height, x1 = 0, y1 = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue
      if (x < x0) x0 = x
      if (x + 1 > x1) x1 = x + 1
      if (y < y0) y0 = y
      y1 = y + 1
    }
  }
  return x1 === 0 ? null : [x0, y0, x1, y1]
}

/** Crop away fully transparent edges; an all-transparent image is returned unchanged. */
export function trim(img) {
  const box = getBbox(img)
  return box ? crop(img, ...box) : img
}
