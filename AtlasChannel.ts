import * as THREE from "three"
import PageCache from "./PageCache.js"
import PageTable from "./PageTable.js"
import type TileScheduler from "./TileScheduler.js"
import type { LoadedPage } from "./TileScheduler.js"
import {
  pageKey,
  pageLevel,
  pageX,
  pageY,
  rootKey,
  type PageKey,
  type TileManifest,
  type TileSource,
} from "./TileSource.js"

// Material slots a channel can feed; the name doubles as the material property
export type ChannelName =
  | "map"
  | "normalMap"
  | "roughnessMap"
  | "metalnessMap"
  | "aoMap"
  | "emissiveMap"
  | "specularMap"

export interface ChannelOptions {
  source: TileSource
  // Cap on the finest texels this channel will ever stream (e.g. 1024 keeps a 4k map at 1k)
  maxSize?: number
  // This channel's atlas, overriding the virtual texture's atlasSize
  atlasSize?: number
  colorSpace?: THREE.ColorSpace
}

export interface ChannelStats {
  name: ChannelName
  resident: number
  capacity: number
  uploads: number
  dropped: number
  minLevel: number
  offset: number
  atlasSize: number
  memoryBytes: number
}

const srgbChannels: ChannelName[] = ["map", "emissiveMap"]

const fallbacks: Record<ChannelName, THREE.Vector4> = {
  map: new THREE.Vector4(0.5, 0.5, 0.5, 1),
  emissiveMap: new THREE.Vector4(0, 0, 0, 1),
  normalMap: new THREE.Vector4(0.5, 0.5, 1, 1),
  roughnessMap: new THREE.Vector4(1, 1, 1, 1),
  metalnessMap: new THREE.Vector4(1, 1, 1, 1),
  aoMap: new THREE.Vector4(1, 1, 1, 1),
  specularMap: new THREE.Vector4(1, 1, 1, 1),
}

// One streamed map. All channels share the reference channel's UV space and feedback; this
// one may be smaller (offset levels coarser) and may be capped (minLevel) on top of that.
export default class AtlasChannel {
  public readonly name: ChannelName
  public readonly source: TileSource
  public readonly manifest: TileManifest
  public readonly cache: PageCache
  public readonly pageTable: PageTable
  // Downloaded tiles waiting for a slot, filled by the scheduler
  public readonly loaded: LoadedPage[] = []
  public readonly uniforms: Record<string, THREE.IUniform>
  // How many levels coarser than the reference this channel's level 0 is
  public readonly offset: number
  // Cap from maxSize: the finest level this channel ever streams
  private readonly capLevel: number
  private detailCapLevels: number = 0
  public readonly maxLevel: number
  public readonly root: PageKey

  private totalUploads: number = 0
  private totalDropped: number = 0

  constructor(
    name: ChannelName,
    { source, maxSize, colorSpace, atlasSize }: ChannelOptions,
    reference: TileManifest,
    defaultAtlasSize: number
  ) {
    this.name = name
    this.source = source
    this.manifest = source.manifest
    const m = this.manifest

    if (m.tileSize !== reference.tileSize || m.border !== reference.border) {
      throw new Error(`Atlas: channel ${name} must use the reference tile size and border`)
    }
    const ratio = reference.cols / m.cols
    this.offset = Math.log2(ratio)
    if (!Number.isInteger(this.offset) || this.offset < 0 || reference.rows / m.rows !== ratio) {
      throw new Error(
        `Atlas: channel ${name} page grid (${m.cols}x${m.rows}) must be the reference grid (${reference.cols}x${reference.rows}) halved a whole number of times`
      )
    }

    this.maxLevel = m.levels - 1
    const cap = maxSize ? Math.ceil(Math.log2(Math.max(1, m.width / maxSize))) : 0
    this.capLevel = THREE.MathUtils.clamp(cap, 0, this.maxLevel)
    this.root = rootKey(m)

    this.cache = new PageCache({
      tileSize: m.tileSize,
      border: m.border,
      atlasSize: atlasSize ?? defaultAtlasSize,
      colorSpace: colorSpace ?? (srgbChannels.includes(name) ? THREE.SRGBColorSpace : THREE.NoColorSpace),
    })
    this.pageTable = new PageTable(m, this.cache.slotsPerRow)

    this.uniforms = {
      [`atlas_${name}_cache`]: { value: this.cache.texture },
      [`atlas_${name}_pageTable`]: { value: this.pageTable.texture },
      [`atlas_${name}_grid`]: { value: new THREE.Vector2(m.cols, m.rows) },
      [`atlas_${name}_params`]: {
        value: new THREE.Vector4(this.maxLevel, this.minLevel, this.offset, 0),
      },
      [`atlas_${name}_cacheParams`]: {
        value: new THREE.Vector4(this.cache.slotSize, m.border, m.tileSize, this.cache.size),
      },
      [`atlas_${name}_fallback`]: { value: fallbacks[name].clone() },
    }
  }

  // Finest level requested or sampled: the maxSize cap plus the runtime detail cap
  public get minLevel(): number {
    return THREE.MathUtils.clamp(this.capLevel + this.detailCapLevels, 0, this.maxLevel)
  }

  // Levels held back from the finest at runtime, on top of maxSize. Finer pages already
  // resident stay resident and show again the moment the cap lifts.
  public set detailCap(levels: number) {
    this.detailCapLevels = Math.max(0, Math.floor(levels))
    ;(this.uniforms[`atlas_${this.name}_params`].value as THREE.Vector4).y = this.minLevel
  }

  public get detailCap(): number {
    return this.detailCapLevels
  }

  // The page of this channel that covers a page requested in reference terms
  public keyFor(referenceKey: PageKey): PageKey {
    const wanted = pageLevel(referenceKey) - this.offset
    const level = THREE.MathUtils.clamp(wanted, this.minLevel, this.maxLevel)
    const shift = level - wanted
    return pageKey(level, pageX(referenceKey) >> shift, pageY(referenceKey) >> shift)
  }

  // Level this page currently draws from (finest resident ancestor), or one past the
  // coarsest when nothing covers it yet
  public shownLevel(key: PageKey): number {
    const covering = this.pageTable.coveringKey(key)
    return covering === -1 ? this.maxLevel + 1 : pageLevel(covering)
  }

  public uploadLoaded(
    renderer: THREE.WebGLRenderer,
    scheduler: TileScheduler,
    frame: number,
    minIdleFrame: number,
    budget: number
  ): number {
    let uploads = 0
    while (uploads < budget) {
      const page = this.loaded.shift()
      if (!page) break
      const { key, image } = page
      scheduler.taken(this, key)
      const allocation = this.cache.allocate(key, frame, minIdleFrame, (k) => k === this.root)
      if (!allocation) {
        image.close()
        scheduler.dropped(this, key, frame)
        this.totalDropped++
        continue
      }
      if (allocation.evicted !== -1) this.pageTable.setEvicted(allocation.evicted)
      this.cache.upload(renderer, allocation.slot, image)
      this.pageTable.setResident(key, allocation.slot)
      image.close()
      uploads++
      this.totalUploads++
    }
    this.pageTable.update()
    return uploads
  }

  public get stats(): ChannelStats {
    return {
      name: this.name,
      resident: this.pageTable.residentCount,
      capacity: this.cache.capacity,
      uploads: this.totalUploads,
      dropped: this.totalDropped,
      minLevel: this.minLevel,
      offset: this.offset,
      atlasSize: this.cache.size,
      memoryBytes: this.cache.memoryBytes + this.pageTable.memoryBytes,
    }
  }

  public dispose(): void {
    this.loaded.forEach((page) => page.image.close())
    this.loaded.length = 0
    this.pageTable.dispose()
    this.cache.dispose()
  }
}
