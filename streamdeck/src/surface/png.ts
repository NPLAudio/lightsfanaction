import { deflateSync } from 'node:zlib'

const TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  out.set(data, 8)
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Encodes `rgb` (3 bytes a pixel, row-major) as a PNG. Compression is kept light: this runs for every key, every frame. */
export function png(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    // filter 1 (Sub): each byte minus the one a pixel to its left, which turns smooth gradients into runs of tiny values
    const o = y * (stride + 1)
    raw[o] = 1
    const row = y * stride
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (rgb[row + i] - (i >= 3 ? rgb[row + i - 3] : 0)) & 255
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', new Uint8Array(0)),
  ])
}

/** A PNG as a data URI, which is what Stream Deck accepts for a key image. */
export function pngUri(width: number, height: number, rgb: Uint8Array): string {
  return `data:image/png;base64,${png(width, height, rgb).toString('base64')}`
}
