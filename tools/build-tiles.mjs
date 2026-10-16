#!/usr/bin/env node
// Builds an Atlas tile pyramid from one image with sharp.
//
//   atlas tiles <input> <outDir> [--tile 256] [--border 4] [--format webp] [--quality 85] [--force]
//
// Output: <outDir>/manifest.json and <outDir>/<level>/<x>_<y>.<format>

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith("--"))
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const fail = (message) => {
  console.error(`build-tiles: ${message}`)
  process.exit(1)
}
const [input, outDir] = positional
if (!input || !outDir) {
  fail("usage: atlas tiles <input> <outDir> [--tile 256] [--border 4] [--format webp] [--quality 85] [--force]")
}
if (!existsSync(input) || !statSync(input).isFile()) fail(`${input} is not a file`)
if (existsSync(outDir) && readdirSync(outDir).length > 0) {
  if (!args.includes("--force")) fail(`${outDir} is not empty; pass --force to replace its contents`)
  rmSync(outDir, { recursive: true, force: true })
}

const tileSize = Number(option("tile", 256))
const border = Number(option("border", 4))
const format = option("format", "webp")
const quality = Number(option("quality", 85))
const encode = format === "png" ? {} : { quality }

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(1, n)))
const unlimited = { limitInputPixels: false }

const metadata = await sharp(input, unlimited).metadata().catch((error) => fail(`cannot read ${input}: ${error.message}`))
const contentWidth = metadata.width
const contentHeight = metadata.height

const cols = nextPow2(Math.ceil(contentWidth / tileSize))
const rows = nextPow2(Math.ceil(contentHeight / tileSize))
const width = cols * tileSize
const height = rows * tileSize
const levels = Math.log2(Math.max(cols, rows)) + 1
const slot = tileSize + border * 2

console.log(`${contentWidth}x${contentHeight} -> ${width}x${height}, ${cols}x${rows} pages, ${levels} levels`)
mkdirSync(outDir, { recursive: true })

// Pad once at full size by replicating the edge pixels, so downscaled levels get no dark
// fringe where the content ends; every level is an exact power-of-two downscale of this
const padded = await sharp(input, unlimited)
  .extend({ right: width - contentWidth, bottom: height - contentHeight, extendWith: "copy" })
  .raw()
  .toBuffer({ resolveWithObject: true })
const channels = padded.info.channels
const fromRaw = (buffer, w, h) => sharp(buffer, { ...unlimited, raw: { width: w, height: h, channels } })

// Writes tiles a few at a time so the encoder pool is busy without every tile buffered at once
const inBatches = async (jobs, batch = 32) => {
  for (let i = 0; i < jobs.length; i += batch) await Promise.all(jobs.slice(i, i + batch).map((job) => job()))
}

let total = 0
for (let level = 0; level < levels; level++) {
  const levelCols = Math.max(1, cols >> level)
  const levelRows = Math.max(1, rows >> level)
  const levelWidth = levelCols * tileSize
  const levelHeight = levelRows * tileSize
  const levelDir = join(outDir, String(level))
  mkdirSync(levelDir, { recursive: true })

  // Downscale, then grow the canvas by the border on every side with edge replication
  const bordered = await fromRaw(padded.data, width, height)
    .resize(levelWidth, levelHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .extend({ top: border, bottom: border, left: border, right: border, extendWith: "copy" })
    .raw()
    .toBuffer()

  const jobs = []
  for (let y = 0; y < levelRows; y++) {
    for (let x = 0; x < levelCols; x++) {
      jobs.push(() =>
        fromRaw(bordered, levelWidth + border * 2, levelHeight + border * 2)
          .extract({ left: x * tileSize, top: y * tileSize, width: slot, height: slot })
          .toFormat(format, encode)
          .toFile(join(levelDir, `${x}_${y}.${format}`))
      )
    }
  }
  await inBatches(jobs)

  total += levelCols * levelRows
  console.log(`level ${level}: ${levelCols}x${levelRows} tiles`)
}

const manifest = {
  version: 1,
  // Cache-buster appended to tile URLs by the runtime, so a rebuilt pyramid never serves stale tiles
  build: Date.now().toString(36),
  width,
  height,
  contentWidth,
  contentHeight,
  tileSize,
  border,
  cols,
  rows,
  levels,
  format,
}
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2))
console.log(`${total} tiles written to ${outDir}`)
