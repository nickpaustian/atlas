import * as THREE from "three"
import type { PageKey } from "./TileSource.js"

export interface PageCacheOptions {
  tileSize: number
  border: number
  // Largest the square atlas may be, in texels; as many whole slots as fit are used
  atlasSize?: number
  colorSpace?: THREE.ColorSpace
}

// The physical texture: a square atlas of equal slots, each holding one bordered tile.
// Slots are handed out free-first, then least recently used.
export default class PageCache {
  public readonly texture: THREE.DataTexture
  public readonly slotSize: number
  public readonly slotsPerRow: number
  public readonly capacity: number
  public readonly size: number

  private keys: Int32Array
  private lastUsed: Uint32Array
  private index: Map<PageKey, number> = new Map()
  private initialised: boolean = false

  constructor({ tileSize, border, atlasSize = 4096, colorSpace = THREE.SRGBColorSpace }: PageCacheOptions) {
    this.slotSize = tileSize + border * 2
    // One slot is the floor: the channel then only ever shows its root page
    const slotsPerRow = Math.max(1, Math.floor(atlasSize / this.slotSize))
    if (atlasSize < this.slotSize) {
      console.warn(`[atlas] atlasSize ${atlasSize} is below one slot of ${this.slotSize} texels; using one slot`)
    }
    this.slotsPerRow = slotsPerRow
    this.capacity = slotsPerRow * slotsPerRow
    this.size = this.slotSize * slotsPerRow

    this.keys = new Int32Array(this.capacity).fill(-1)
    this.lastUsed = new Uint32Array(this.capacity)

    this.texture = new THREE.DataTexture(
      new Uint8Array(this.size * this.size * 4),
      this.size,
      this.size,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    )
    this.texture.colorSpace = colorSpace
    this.texture.magFilter = THREE.LinearFilter
    this.texture.minFilter = THREE.LinearFilter
    this.texture.generateMipmaps = false
    this.texture.flipY = false
    this.texture.needsUpdate = true
  }

  // Allocates the GPU storage once so sub-region uploads have somewhere to land
  public initialise(renderer: THREE.WebGLRenderer): void {
    if (this.initialised) return
    const max = renderer.capabilities.maxTextureSize
    if (this.size > max) {
      throw new Error(`Atlas: atlas of ${this.size} texels exceeds this GPU's maximum texture size ${max}`)
    }
    renderer.initTexture(this.texture)
    this.initialised = true
  }

  public get memoryBytes(): number {
    return this.size * this.size * 4
  }

  public get(key: PageKey): number {
    return this.index.get(key) ?? -1
  }

  public has(key: PageKey): boolean {
    return this.index.has(key)
  }

  public get residentCount(): number {
    return this.index.size
  }

  // Page held by a slot, or -1 when free
  public slotKey(slot: number): PageKey | -1 {
    return this.keys[slot]
  }

  // Slots a new tile could take right now: free ones plus evictable ones
  public availableSlots(minIdleFrame: number, isProtected: (key: PageKey) => boolean): number {
    let count = 0
    for (let i = 0; i < this.capacity; i++) {
      const resident = this.keys[i]
      if (resident === -1) count++
      else if (this.lastUsed[i] < minIdleFrame && !isProtected(resident)) count++
    }
    return count
  }

  public touch(key: PageKey, frame: number): void {
    const slot = this.index.get(key)
    if (slot !== undefined) this.lastUsed[slot] = frame
  }

  // Returns the slot now holding `key` and the key it displaced, or null when every slot
  // is protected (used since `minIdleFrame`) and nothing can be evicted.
  public allocate(
    key: PageKey,
    frame: number,
    minIdleFrame: number,
    isProtected: (key: PageKey) => boolean
  ): { slot: number; evicted: PageKey | -1 } | null {
    const existing = this.index.get(key)
    if (existing !== undefined) {
      this.lastUsed[existing] = frame
      return { slot: existing, evicted: -1 }
    }

    let slot = -1
    let evicted: PageKey | -1 = -1
    let oldest = Infinity

    for (let i = 0; i < this.capacity; i++) {
      const resident = this.keys[i]
      if (resident === -1) {
        slot = i
        evicted = -1
        break
      }
      const used = this.lastUsed[i]
      if (used >= minIdleFrame || isProtected(resident)) continue
      if (used < oldest) {
        oldest = used
        slot = i
        evicted = resident
      }
    }

    if (slot === -1) return null
    if (evicted !== -1) this.index.delete(evicted)

    this.keys[slot] = key
    this.lastUsed[slot] = frame
    this.index.set(key, slot)
    return { slot, evicted }
  }

  public release(key: PageKey): void {
    const slot = this.index.get(key)
    if (slot === undefined) return
    this.index.delete(key)
    this.keys[slot] = -1
  }

  public slotPosition(slot: number): { x: number; y: number } {
    return {
      x: (slot % this.slotsPerRow) * this.slotSize,
      y: Math.floor(slot / this.slotsPerRow) * this.slotSize,
    }
  }

  // Copies one bordered tile into its slot without touching the rest of the atlas.
  // Done on the raw context with an explicit texture unit: three's copyTextureToTexture
  // trusts its binding cache and can write to whichever texture the active unit holds.
  public upload(renderer: THREE.WebGLRenderer, slot: number, image: ImageBitmap): void {
    this.initialise(renderer)
    const { x, y } = this.slotPosition(slot)

    const gl = renderer.getContext() as WebGL2RenderingContext
    const handle = (renderer.properties.get(this.texture) as { __webglTexture?: WebGLTexture }).__webglTexture!
    const unit = gl.TEXTURE0 + renderer.capabilities.maxTextures - 1
    renderer.state.activeTexture(unit)
    const bindTexture = renderer.state.bindTexture as (
      type: number,
      texture: WebGLTexture | null,
      slot?: number
    ) => void
    bindTexture(gl.TEXTURE_2D, handle, unit)

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, image)
  }

  public dispose(): void {
    this.texture.dispose()
    this.index.clear()
    this.keys.fill(-1)
  }
}
