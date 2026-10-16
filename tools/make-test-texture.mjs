#!/usr/bin/env node
// Draws a diagnostic texture for Atlas with sharp: one cell per level-0 page, hue across and
// lightness down, the cell's page coordinates in large text, and detail that only resolves at
// level 0 (small text and 1 px pinstripes) so the resident level is obvious.
//
//   atlas test-texture <out.png> [--size 8192] [--cell 256] [--font "Arial"]

import sharp from "sharp"

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith("--"))
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const [out] = positional
if (!out) {
  console.error("usage: atlas test-texture <out.png> [--size 8192] [--cell 256] [--font family]")
  process.exit(1)
}

const size = Number(option("size", 8192))
const cell = Number(option("cell", 256))
const font = option("font", "Arial, Helvetica, DejaVu Sans, sans-serif")
const cells = Math.floor(size / cell)

const hsl = (h, s, l) => `hsl(${h.toFixed(1)},${s}%,${l}%)`
const svg = []
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" font-family="${font}" font-weight="bold" shape-rendering="crispEdges">`)
svg.push(`<rect width="${size}" height="${size}" fill="white"/>`)

// Cell fills: hue by column, lightness by row, with a checker nudge so neighbours differ
for (let y = 0; y < cells; y++) {
  for (let x = 0; x < cells; x++) {
    const hue = (x / cells) * 360
    const light = 35 + (y / cells) * 40 + ((x + y) % 2) * 6
    svg.push(`<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${hsl(hue, 70, light)}"/>`)
  }
}

// Grid lines: 4 px dark at every cell, 12 px white every 4 cells (one level-2 page)
const lines = (step, stroke, strokeWidth) => {
  const d = []
  for (let i = 0; i <= cells; i += step) d.push(`M${i * cell} 0V${size}M0 ${i * cell}H${size}`)
  svg.push(`<path d="${d.join("")}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="none"/>`)
}
lines(1, "rgba(0,0,0,0.6)", 4)
lines(4, "rgba(255,255,255,0.9)", 12)

// Per cell: big coordinates, a small caption, and pinstripes in the bottom-right corner
const big = Math.round(cell * 0.28)
const small = Math.max(8, Math.round(cell * 0.045))
for (let y = 0; y < cells; y++) {
  for (let x = 0; x < cells; x++) {
    const ox = x * cell
    const oy = y * cell
    svg.push(`<text x="${ox + cell * 0.1}" y="${oy + cell * 0.42}" font-size="${big}" fill="black">${x},${y}</text>`)
    svg.push(`<text x="${ox + cell * 0.1}" y="${oy + cell * 0.58}" font-size="${small}" fill="white">level 0 only: page ${x},${y}</text>`)
    svg.push(`<text x="${ox + cell * 0.1}" y="${oy + cell * 0.58 + small * 1.3}" font-size="${small}" fill="black">${size}px ${cell}px cells</text>`)
    const px = ox + cell * 0.62
    const py = oy + cell * 0.66
    const w = cell * 0.28
    for (let i = 0; i < 12; i += 2) {
      svg.push(`<rect x="${px}" y="${py + i}" width="${w}" height="1" fill="black"/><rect x="${px}" y="${py + i + 1}" width="${w}" height="1" fill="white"/>`)
    }
    for (let i = 0; i < 12; i += 2) {
      svg.push(`<rect x="${px + i}" y="${py + 16}" width="1" height="${w * 0.5}" fill="black"/><rect x="${px + i + 1}" y="${py + 16}" width="1" height="${w * 0.5}" fill="white"/>`)
    }
  }
}

// A thin diagonal across the whole texture to show UV continuity and orientation
svg.push(`<line x1="0" y1="0" x2="${size}" y2="${size}" stroke="rgba(255,0,0,0.8)" stroke-width="6" shape-rendering="auto"/>`)
svg.push("</svg>")

console.log(`${size}x${size}, ${cells}x${cells} cells of ${cell}px`)
await sharp(Buffer.from(svg.join("\n")), { limitInputPixels: false }).png().toFile(out)
console.log(`wrote ${out}`)
