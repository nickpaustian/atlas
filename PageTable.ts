import * as THREE from "three"
import {
  pageKey,
  pageLevel,
  pageX,
  pageY,
  pagesAtLevel,
  type PageKey,
  type TileManifest,
} from "./TileSource.js"

// Typed through the constructor so the array is ArrayBuffer-backed under every TypeScript lib
const makeLevel = (cols: number, rows: number) => ({ data: new Uint8Array(cols * rows * 4), width: cols, height: rows })
type MipLevel = ReturnType<typeof makeLevel>
// The indirection texture. One mip level per page level; each texel is the atlas slot of
// the finest resident page covering that virtual page, at that level or coarser:
// r = slot x, g = slot y, b = level the slot holds, a = how far the page has faded in
// (1..255; 0 where nothing covers it). While a page fades, the entry one level above it still
// names the page it replaced, so the shader can blend the two.
export default class PageTable {
  public readonly texture: THREE.DataTexture
  public readonly levels: MipLevel[] = []

  private manifest: TileManifest
  private slotsPerRow: number
  private resident: Map<PageKey, { slot: number; arrivedAt: number }> = new Map()
  private dirty: boolean = true
  // Pages whose fade was still running at the last update, so the next one re-uploads
  private fading: number = 0

  constructor(manifest: TileManifest, slotsPerRow: number) {
    this.manifest = manifest
    this.slotsPerRow = slotsPerRow

    for (let level = 0; level < manifest.levels; level++) {
      const { cols, rows } = pagesAtLevel(manifest, level)
      this.levels.push(makeLevel(cols, rows))
    }

    const base = this.levels[0]
    this.texture = new THREE.DataTexture(
      base.data,
      base.width,
      base.height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    )
    this.texture.mipmaps = this.levels
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestMipmapNearestFilter
    this.texture.generateMipmaps = false
    this.texture.flipY = false
    this.texture.unpackAlignment = 1
    this.texture.needsUpdate = true
  }

  public isResident(key: PageKey): boolean {
    return this.resident.has(key)
  }

  public get residentCount(): number {
    return this.resident.size
  }

  public residentKeys(): IterableIterator<PageKey> {
    return this.resident.keys()
  }

  public get memoryBytes(): number {
    return this.levels.reduce((n, level) => n + level.data.byteLength, 0)
  }

  // `now` starts the page's fade; left out, the page is shown at once
  public setResident(key: PageKey, slot: number, now: number = -Infinity): void {
    this.resident.set(key, { slot, arrivedAt: now })
    this.dirty = true
  }

  public setEvicted(key: PageKey): void {
    if (this.resident.delete(key)) this.dirty = true
  }

  // Finest resident ancestor of a page, itself included
  public coveringKey(key: PageKey): PageKey | -1 {
    let level = pageLevel(key)
    let x = pageX(key)
    let y = pageY(key)
    while (level < this.manifest.levels) {
      const candidate = pageKey(level, x, y)
      if (this.resident.has(candidate)) return candidate
      level++
      x >>= 1
      y >>= 1
    }
    return -1
  }

  // Fills every level from the coarsest down, so a page with no tile of its own inherits
  // its parent's entry. A page younger than `fadeMs` carries its progress in alpha and keeps
  // the table updating until it is whole. Returns true when the texture was re-uploaded.
  public update(now: number = Infinity, fadeMs: number = 0): boolean {
    if (!this.dirty && this.fading === 0) return false
    this.dirty = false
    this.fading = 0

    for (let level = this.manifest.levels - 1; level >= 0; level--) {
      const { data, width, height } = this.levels[level]
      const parent = this.levels[level + 1]

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4
          const page = this.resident.get(pageKey(level, x, y))

          if (page !== undefined) {
            const age = now - page.arrivedAt
            const progress = fadeMs > 0 && age < fadeMs ? age / fadeMs : 1
            if (progress < 1) this.fading++
            data[offset] = page.slot % this.slotsPerRow
            data[offset + 1] = Math.floor(page.slot / this.slotsPerRow)
            data[offset + 2] = level
            data[offset + 3] = Math.max(1, Math.round(progress * 255))
          } else if (parent) {
            const parentOffset = ((y >> 1) * parent.width + (x >> 1)) * 4
            data[offset] = parent.data[parentOffset]
            data[offset + 1] = parent.data[parentOffset + 1]
            data[offset + 2] = parent.data[parentOffset + 2]
            data[offset + 3] = parent.data[parentOffset + 3]
          } else {
            data[offset] = data[offset + 1] = data[offset + 2] = data[offset + 3] = 0
          }
        }
      }
    }

    this.texture.needsUpdate = true
    return true
  }

  public dispose(): void {
    this.texture.dispose()
    this.resident.clear()
  }
}
