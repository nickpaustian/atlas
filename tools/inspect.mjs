#!/usr/bin/env node
// Checks a built Atlas tile pyramid: the manifest's geometry, that every tile of every level
// is present with the slot size the manifest promises, and the bytes per level.
//
//   atlas inspect <dir>

import { readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"

const [dir] = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const fail = (message) => {
  console.error(`inspect: ${message}`)
  process.exit(1)
}
if (!dir) fail("usage: atlas inspect <dir>")
if (!existsSync(join(dir, "manifest.json"))) fail(`${dir} has no manifest.json`)

const issues = []
const issue = (message) => {
  if (issues.length < 50) issues.push(message)
  else if (issues.length === 50) issues.push("... further issues not listed")
}
const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
for (const field of ["width", "height", "contentWidth", "contentHeight", "tileSize", "border", "cols", "rows", "levels", "format"]) {
  if (m[field] === undefined) fail(`manifest has no ${field}`)
}
if ((m.version ?? 1) !== 1) fail(`tile format ${m.version}; this tool reads format 1`)
const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0
if (!isPow2(m.cols) || !isPow2(m.rows)) issue(`page grid ${m.cols}x${m.rows} is not a power of two`)
if (m.width !== m.cols * m.tileSize || m.height !== m.rows * m.tileSize) issue(`size ${m.width}x${m.height} is not ${m.cols}x${m.rows} pages of ${m.tileSize}`)
if (m.contentWidth > m.width || m.contentHeight > m.height) issue(`content ${m.contentWidth}x${m.contentHeight} exceeds the padded size`)
if (m.levels !== Math.log2(Math.max(m.cols, m.rows)) + 1) issue(`${m.levels} levels, expected ${Math.log2(Math.max(m.cols, m.rows)) + 1} for a ${m.cols}x${m.rows} grid`)
if (m.cols > 256 || m.rows > 256) issue(`${m.cols}x${m.rows} pages exceeds the 256 a side the feedback pass can address`)
const slot = m.tileSize + m.border * 2

const rows = []
let totalTiles = 0, totalBytes = 0, channels = new Set(), alpha = false
for (let level = 0; level < m.levels; level++) {
  const cols = Math.max(1, m.cols >> level)
  const rowCount = Math.max(1, m.rows >> level)
  let present = 0, bytes = 0, wrongSize = 0
  const missing = []
  const checks = []
  for (let y = 0; y < rowCount; y++) {
    for (let x = 0; x < cols; x++) {
      const path = join(dir, String(level), `${x}_${y}.${m.format}`)
      if (!existsSync(path)) { missing.push(`${x}_${y}`); continue }
      present++
      bytes += statSync(path).size
      checks.push(sharp(path).metadata().then((meta) => {
        channels.add(meta.channels)
        if (meta.hasAlpha) alpha = true
        if (meta.width !== slot || meta.height !== slot) { wrongSize++; if (wrongSize <= 3) issue(`level ${level} tile ${x}_${y} is ${meta.width}x${meta.height}, expected ${slot}x${slot}`) }
      }, (error) => { wrongSize++; issue(`level ${level} tile ${x}_${y} does not decode: ${error.message}`) }))
    }
  }
  await Promise.all(checks)
  if (missing.length > 0) issue(`level ${level} is missing ${missing.length} of ${cols * rowCount} tiles (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""})`)
  totalTiles += present
  totalBytes += bytes
  rows.push({ level, texels: `${Math.max(1, m.width >> level)}x${Math.max(1, m.height >> level)}`, tiles: `${present}/${cols * rowCount}`, MB: +(bytes / 1048576).toFixed(2), "avg KB": present ? +(bytes / present / 1024).toFixed(1) : 0, "bad size": wrongSize })
}

console.log(`${dir}: ${m.width}x${m.height} (content ${m.contentWidth}x${m.contentHeight}), ${m.cols}x${m.rows} pages of ${m.tileSize} + ${m.border} border (${slot} px slots), ${m.levels} levels, ${m.format}, format ${m.version ?? "1 (unversioned)"}, build ${m.build ?? "(none)"}`)
console.log(`${totalTiles} tiles, ${(totalBytes / 1048576).toFixed(1)} MB; ${[...channels].join("/")} channels${alpha ? " with alpha" : ""}`)
console.table(rows)
if (issues.length > 0) {
  console.error(`\n${issues.length} issue${issues.length === 1 ? "" : "s"}:`)
  for (const message of issues) console.error(`  ${message}`)
  process.exit(1)
}
console.log("\nok")
