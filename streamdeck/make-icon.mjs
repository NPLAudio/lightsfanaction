// Draws the plugin icon (a 4-blade fan on a rounded purple square) as a PNG, with no dependencies.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const N = 256
const px = Buffer.alloc(N * N * 4)
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

function inRounded(x, y, r) {
  const dx = Math.max(r - x, 0, x - (N - 1 - r)), dy = Math.max(r - y, 0, y - (N - 1 - r))
  return dx * dx + dy * dy <= r * r
}
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const o = (y * N + x) * 4
  if (!inRounded(x, y, 48)) continue
  // purple gradient
  const t = (x + y) / (2 * N)
  let c = [Math.round(124 - 40 * t), Math.round(92 - 40 * t), Math.round(255 - 40 * t)]
  const cx = x - N / 2, cy = y - N / 2, d = Math.hypot(cx, cy), a = Math.atan2(cy, cx)
  const sector = ((a * 2 / Math.PI) % 1 + 1) % 1 // four blades, each a quarter turn wide
  const blade = d > 22 && d < 92 && sector > 0.08 && sector < 0.62 && d < 92 - 30 * Math.abs(sector - 0.3) * 2
  if (blade || d < 16) c = [250, 250, 250]
  px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255
}
const raw = Buffer.alloc((N * 4 + 1) * N)
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4) }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6
writeFileSync('com.nplaudio.lightsfanaction.sdPlugin/imgs/plugin/icon.png', Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]))
