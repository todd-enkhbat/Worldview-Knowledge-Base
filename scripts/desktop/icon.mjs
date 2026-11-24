import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
// Preserve the supplied NASA Earth photograph. The globe fits inside the central
// 80% safe area for maskable web icons; native icons add only a rounded outer mask.
const directory = resolve('data/desktop/Worldview.iconset'); await mkdir(directory, { recursive: true })
async function square(size, rounded = false) {
  const inner = Math.round(size * .9), image = await sharp('public/brand/earth.jpg').extract({ left: 225, top: 0, width: 574, height: 574 }).resize(inner, inner).png().toBuffer()
  let canvas = sharp({ create: { width: size, height: size, channels: 4, background: '#000000' } }).composite([{ input: image, gravity: 'centre' }])
  if (rounded) { const composed = await canvas.png().toBuffer(); canvas = sharp(composed).composite([{ input: Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${Math.round(size * .22)}" fill="white"/></svg>`), blend: 'dest-in' }]) }
  return canvas.png().toBuffer()
}
for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) await sharp(await square(size * scale, true)).png().toFile(join(directory, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`))
for (const size of [192, 512]) await sharp(await square(size)).png().toFile(`public/brand/worldview-${size}.png`)
const result = spawnSync('/usr/bin/iconutil', ['--convert', 'icns', '--output', resolve('data/desktop/Worldview.icns'), directory], { stdio: 'inherit' })
if (result.status !== 0) throw new Error('The native Worldview icon could not be built.')
