import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "playwright"
import { openPreview, smokeCli } from "./browser.js"

const cli = smokeCli(import.meta.dirname)
let dir: string
let page: Page
let errors: string[]
let close: () => Promise<void>

declare global {
  interface Window {
    atlas: import("../../index.js").VirtualTexture
    atlasPreview: { renderer: import("three").WebGLRenderer; scene: import("three").Scene; camera: import("three").PerspectiveCamera; THREE: typeof import("three") }
  }
}

// Lets the page's own loop run a few frames so a moved camera has been through a feedback pass
const frames = (n: number) => page.evaluate((count) => new Promise<void>((done) => {
  let seen = 0
  const tick = () => (++seen >= count ? done() : requestAnimationFrame(tick))
  requestAnimationFrame(tick)
}), n)
// Network drained and every downloaded tile either uploaded or dropped for want of a slot
const idle = async () => {
  await frames(6)
  await page.waitForFunction(() => {
    const s = window.atlas.stats
    const dropped = s.channels.reduce((n, c) => n + c.dropped, 0)
    return s.network.queued === 0 && s.network.inFlight === 0 && s.pending === 0 && s.uploads + dropped >= s.network.completed
  }, undefined, { timeout: 60_000 })
  await frames(2)
}

// Renders once more and samples the viewport: how many pixels are background magenta, and
// how varied the rest are (a resident texture is colourful, the fallback is flat grey)
const sample = () => page.evaluate(() => {
  const { renderer, scene, camera } = window.atlasPreview
  renderer.render(scene, camera)
  const canvas = document.createElement("canvas")
  const { width, height } = renderer.domElement
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")!
  ctx.drawImage(renderer.domElement, 0, 0)
  const { data } = ctx.getImageData(0, 0, width, height)
  let magenta = 0
  const hues = new Set<number>()
  for (let i = 0; i < data.length; i += 4 * 97) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (r > 200 && g < 60 && b > 200) { magenta++; continue }
    hues.add(((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5))
  }
  return { magenta, distinctColours: hues.size }
})

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "atlas-smoke-"))
  const drawn = spawnSync("node", [cli, "test-texture", join(dir, "t.png"), "--size", "1024", "--cell", "128"], { encoding: "utf8" })
  if (drawn.status !== 0) throw new Error(drawn.stderr)
  const tiled = spawnSync("node", [cli, "tiles", join(dir, "t.png"), join(dir, "tiles"), "--tile", "128", "--border", "4"], { encoding: "utf8" })
  if (tiled.status !== 0) throw new Error(tiled.stderr)
  ;({ page, errors, close } = await openPreview(cli, [join(dir, "tiles")], "?atlasSize=1024"))
  await page.waitForFunction(() => window.atlas && window.atlas.stats.resident > 0, undefined, { timeout: 60_000 })
})
afterAll(async () => {
  await close?.()
  rmSync(dir, { recursive: true, force: true })
})

describe("atlas in a browser", () => {
  it("streams tiles into the atlas with no failures", async () => {
    await idle()
    const stats = await page.evaluate(() => window.atlas.stats)
    expect(stats.resident).toBeGreaterThan(0)
    expect(stats.uploads).toBeGreaterThan(0)
    expect(stats.network.failures).toBe(0)
    expect(errors).toEqual([])
  })

  it("pulls level-0 tiles for a close view and shows the texture rather than the fallback", async () => {
    await page.evaluate(() => {
      const { scene, camera, THREE } = window.atlasPreview
      scene.background = new THREE.Color(1, 0, 1)
      camera.position.set(0, 0, 0.6)
      camera.lookAt(0, 0, 0)
    })
    await idle()
    const finest = await page.evaluate(() => {
      const channel = window.atlas.channels.get("map")!
      return Math.min(...[...channel.pageTable.residentKeys()].map((key) => key >>> 24))
    })
    expect(finest).toBe(0)
    const { magenta, distinctColours } = await sample()
    expect(magenta).toBe(0)
    expect(distinctColours).toBeGreaterThan(8)
  })

  it("holds levels back under a detail cap and releases them again", async () => {
    await page.evaluate(() => { window.atlas.detailCap = 2 })
    await idle()
    const capped = await page.evaluate(() => ({ cap: window.atlas.stats.detailCap, minLevel: window.atlas.stats.channels[0].minLevel }))
    expect(capped).toEqual({ cap: 2, minLevel: 2 })
    await page.evaluate(() => { window.atlas.detailCap = 0 })
    await idle()
    expect(await page.evaluate(() => window.atlas.stats.channels[0].minLevel)).toBe(0)
    expect(errors).toEqual([])
  })
})
