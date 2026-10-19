import { describe, it, expect } from "vitest"
import { PageTable, pageKey, type TileManifest } from "../index.js"

const manifest: TileManifest = { width: 1024, height: 1024, contentWidth: 1024, contentHeight: 1024, tileSize: 256, border: 4, cols: 4, rows: 4, levels: 3, format: "webp" }
const texel = (table: PageTable, level: number, x: number, y: number) => {
  const { data, width } = table.levels[level]
  const o = (y * width + x) * 4
  return [data[o], data[o + 1], data[o + 2], data[o + 3]]
}

describe("PageTable", () => {
  it("starts empty and inherits the root everywhere once it lands", () => {
    const table = new PageTable(manifest, 15)
    expect(table.update()).toBe(true)
    expect(texel(table, 0, 3, 3)).toEqual([0, 0, 0, 0])
    expect(table.coveringKey(pageKey(0, 1, 1))).toBe(-1)
    table.setResident(pageKey(2, 0, 0), 0)
    expect(table.update()).toBe(true)
    expect(table.update()).toBe(false)
    for (let level = 0; level < 3; level++) expect(texel(table, level, 0, 0)).toEqual([0, 0, 2, 255])
    expect(texel(table, 0, 3, 3)).toEqual([0, 0, 2, 255])
    expect(table.coveringKey(pageKey(0, 3, 3))).toBe(pageKey(2, 0, 0))
  })
  it("points a finer resident page at its own slot and its children at it, leaving cousins on the ancestor", () => {
    const table = new PageTable(manifest, 15)
    table.setResident(pageKey(2, 0, 0), 0)
    table.setResident(pageKey(1, 1, 0), 17)
    table.update()
    expect(texel(table, 1, 1, 0)).toEqual([2, 1, 1, 255])
    expect(texel(table, 0, 2, 1)).toEqual([2, 1, 1, 255])
    expect(texel(table, 0, 0, 0)).toEqual([0, 0, 2, 255])
    expect(table.coveringKey(pageKey(0, 3, 0))).toBe(pageKey(1, 1, 0))
    expect(table.coveringKey(pageKey(0, 0, 3))).toBe(pageKey(2, 0, 0))
    expect(table.residentCount).toBe(2)
    table.setEvicted(pageKey(1, 1, 0))
    table.update()
    expect(texel(table, 0, 2, 1)).toEqual([0, 0, 2, 255])
    expect(table.memoryBytes).toBe((16 + 4 + 1) * 4)
  })
  it("carries a landing page's fade in alpha and keeps updating until it is whole", () => {
    const table = new PageTable(manifest, 15)
    table.setResident(pageKey(2, 0, 0), 0, 0)
    table.setResident(pageKey(1, 1, 0), 17, 1000)
    expect(table.update(1050, 200)).toBe(true)
    expect(texel(table, 1, 1, 0)).toEqual([2, 1, 1, 64])
    expect(texel(table, 0, 2, 1)).toEqual([2, 1, 1, 64])
    expect(texel(table, 2, 0, 0)).toEqual([0, 0, 2, 255])
    expect(table.update(1100, 200)).toBe(true)
    expect(texel(table, 1, 1, 0)[3]).toBe(128)
    expect(table.update(1300, 200)).toBe(true)
    expect(texel(table, 1, 1, 0)[3]).toBe(255)
    expect(table.update(1400, 200)).toBe(false)
    const atOnce = new PageTable(manifest, 15)
    atOnce.setResident(pageKey(2, 0, 0), 0)
    atOnce.update(5, 200)
    expect(texel(atOnce, 0, 0, 0)[3]).toBe(255)
  })
})
