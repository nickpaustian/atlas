import { describe, it, expect } from "vitest"
import { pageKey, pageLevel, pageX, pageY, parentKey, pagesAtLevel, rootKey, loadTileSource, TILE_FORMAT_VERSION, type TileManifest } from "../index.js"

const manifest: TileManifest = { width: 1024, height: 512, contentWidth: 1000, contentHeight: 500, tileSize: 256, border: 4, cols: 4, rows: 2, levels: 3, format: "webp" }

describe("page keys", () => {
  it("round-trip level, x and y up to the packing limits", () => {
    for (const [level, x, y] of [[0, 0, 0], [2, 5, 7], [7, 4095, 4095], [255, 1, 4094]]) {
      const key = pageKey(level, x, y)
      expect([pageLevel(key), pageX(key), pageY(key)]).toEqual([level, x, y])
    }
  })
  it("find the parent one level up at half the coordinates", () => {
    expect(parentKey(pageKey(0, 5, 7))).toBe(pageKey(1, 2, 3))
    expect(parentKey(pageKey(3, 1, 0))).toBe(pageKey(4, 0, 0))
  })
  it("halve the grid per level down to one page and name the root", () => {
    expect(pagesAtLevel(manifest, 0)).toEqual({ cols: 4, rows: 2 })
    expect(pagesAtLevel(manifest, 1)).toEqual({ cols: 2, rows: 1 })
    expect(pagesAtLevel(manifest, 2)).toEqual({ cols: 1, rows: 1 })
    expect(rootKey(manifest)).toBe(pageKey(2, 0, 0))
  })
})

describe("loadTileSource", () => {
  const serving = (body: unknown, status = 200) => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch = async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }) }
    return { fetch, calls }
  }
  it("fetches the manifest without caching and builds tile urls with the build token", async () => {
    const { fetch, calls } = serving({ ...manifest, version: 1, build: "abc" })
    const source = await loadTileSource("/tiles/x/", { fetch })
    expect(calls[0].url).toBe("/tiles/x/manifest.json")
    expect(calls[0].init?.cache).toBe("no-cache")
    expect(source.url(1, 2, 0)).toBe("/tiles/x/1/2_0.webp?v=abc")
    expect(source.fetch).toBe(fetch)
  })
  it("reads a manifest without a version as the current one and refuses others", async () => {
    const old = await loadTileSource("/tiles/old", { fetch: serving(manifest).fetch })
    expect(old.url(0, 0, 0)).toBe("/tiles/old/0/0_0.webp")
    await expect(loadTileSource("/tiles/new", { fetch: serving({ ...manifest, version: TILE_FORMAT_VERSION + 1 }).fetch })).rejects.toThrow(/tile format 2/)
    await expect(loadTileSource("/tiles/missing", { fetch: serving("", 404).fetch })).rejects.toThrow(/manifest not found/)
  })
})
