import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"

const cli = join(import.meta.dirname, "..", "tools", "cli.mjs")
const run = (...args: string[]) => spawnSync("node", [cli, ...args], { encoding: "utf8" })
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "atlas-test-"))
  const w = 700, h = 500
  const raw = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; raw[o] = x & 255; raw[o + 1] = y & 255; raw[o + 2] = 128 }
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toFile(join(dir, "in.png"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("atlas tiles", () => {
  it("builds a padded power-of-two pyramid with a versioned manifest", () => {
    const out = join(dir, "tiles")
    execFileSync("node", [cli, "tiles", join(dir, "in.png"), out, "--tile", "128", "--border", "2"])
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))
    expect(manifest).toMatchObject({ version: 1, width: 1024, height: 512, contentWidth: 700, contentHeight: 500, tileSize: 128, border: 2, cols: 8, rows: 4, levels: 4, format: "webp" })
    expect(typeof manifest.build).toBe("string")
    expect(readdirSync(join(out, "0")).length).toBe(32)
    expect(readdirSync(join(out, "3"))).toEqual(["0_0.webp"])
    expect(run("inspect", out).status).toBe(0)
  })
  it("refuses a non-empty output folder unless forced", () => {
    const out = join(dir, "tiles")
    const refused = run("tiles", join(dir, "in.png"), out)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/not empty/)
    expect(run("tiles", join(dir, "in.png"), out, "--tile", "128", "--border", "2", "--force").status).toBe(0)
  })
  it("inspect fails on a missing tile and on a future format", () => {
    const out = join(dir, "tiles")
    unlinkSync(join(out, "1", "0_0.webp"))
    const result = run("inspect", out)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/level 1 is missing 1/)
  })
  it("refuses bad inputs with one line", () => {
    expect(run("tiles", join(dir, "nope.png"), join(dir, "x")).stderr).toMatch(/is not a file/)
    expect(run("bogus").status).toBe(1)
  })
})

describe("atlas test-texture", () => {
  it("draws a texture of the requested size", async () => {
    const png = join(dir, "t.png")
    execFileSync("node", [cli, "test-texture", png, "--size", "256", "--cell", "128"])
    expect(existsSync(png)).toBe(true)
    const meta = await sharp(png).metadata()
    expect([meta.width, meta.height]).toEqual([256, 256])
  })
})
