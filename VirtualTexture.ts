import * as THREE from "three"
import AtlasChannel, { type ChannelName, type ChannelOptions, type ChannelStats } from "./AtlasChannel.js"
import FeedbackPass, { type PageCoverage } from "./FeedbackPass.js"
import type { PoolClient } from "./pool.js"
import TileScheduler, { type SchedulerOptions, type SchedulerStats } from "./TileScheduler.js"
import {
  applyVirtualTexture,
  prepareTriangleTint,
  removeVirtualTexture,
  type PatchableMaterial,
} from "./patchMaterial.js"

// 0 off, 1 per pixel, 2 per triangle (needs attach(mesh, { triangleTint: true }))
export type TintMode = 0 | 1 | 2

export interface AttachOptions {
  // Rebuild the geometry non-indexed with per-triangle centroid UVs so tint mode 2 works
  triangleTint?: boolean
}
import { pageLevel, parentKey, type PageKey, type TileManifest, type TileSource } from "./TileSource.js"

export type ChannelInput = TileSource | ChannelOptions

export interface VirtualTextureOptions {
  // Shorthand for channels: { map: source }
  source?: TileSource
  // One tile pyramid per material slot; all must share the UV space and tile size, each may be
  // smaller than the largest (the reference) by a power of two and may be capped with maxSize
  channels?: Partial<Record<ChannelName, ChannelInput>>
  // Largest each channel's square atlas may be, in texels (4096 holds 15x15 tiles of 256 + 4
  // border; 2048 holds 7x7). Lower it for low-end devices; channels can override it.
  atlasSize?: number
  // How much closeness to the screen centre counts in the slot budget. Screen coverage is the
  // main factor; position mostly breaks ties. 0 ignores position, 1 (default) makes a centre
  // page worth about 1.25 corner pages of the same size, 4 makes it worth about two
  centreBias?: number
  // Feedback renders at 1/scale of the viewport in each axis
  feedbackScale?: number
  // Run the feedback pass every n frames
  feedbackInterval?: number
  // Positive picks coarser pages
  lodBias?: number
  // Levels held back from the finest on every channel (1 halves the resolution). A runtime
  // knob for slow networks or weak devices; see the detailCap setter
  detailCap?: number
  // three textures put v = 0 at the image bottom; glTF geometry puts it at the top (false)
  flipV?: boolean
  // Tile uploads per frame per channel, to spread the cost
  uploadsPerFrame?: number
  // Milliseconds of main-thread time a frame may spend on uploads across the channels; at
  // least one tile lands a frame on each
  uploadBudgetMs?: number
  // Milliseconds a landed tile dissolves in over the page it replaced; 0 switches at once
  fadeMs?: number
  // When a channel's atlas is full and pages are still wanted, pick coarser pages (a lod bias
  // on top of `lodBias`, half a level at a time) until the cut fits, and ease back as room
  // returns; see the budgetLodBias stat
  budget?: boolean
  // Network: shared concurrency, abort grace and progress threshold, drop cooldown
  scheduler?: SchedulerOptions
  // A client of a shared fetch pool (@nickpaustian/tethys), when Atlas streams alongside other modules
  pool?: PoolClient
}

export interface VirtualTextureStats {
  frame: number
  resident: number
  capacity: number
  pending: number
  requested: number
  uploads: number
  failures: number
  channels: ChannelStats[]
  network: SchedulerStats
  memoryBytes: number
  detailCap: number
  // The budget's bias in levels, on top of the texture's own
  budgetLodBias: number
}

const isTileSource = (input: ChannelInput): input is TileSource => "manifest" in input

export default class VirtualTexture {
  public readonly channels: Map<ChannelName, AtlasChannel> = new Map()
  // The largest channel: its page grid is what feedback requests are expressed in
  public readonly reference: AtlasChannel
  public readonly manifest: TileManifest
  public readonly feedback: FeedbackPass
  public readonly scheduler: TileScheduler
  // Shared uniforms only; each channel carries its own
  public readonly uniforms: Record<string, THREE.IUniform>
  public readonly meshes: Set<THREE.Mesh> = new Set()
  private originalGeometry: WeakMap<THREE.Mesh, THREE.BufferGeometry> = new WeakMap()

  public feedbackInterval: number
  public uploadsPerFrame: number
  public uploadBudgetMs: number
  public budget: boolean

  private frame: number = 0
  private pass: number = 0
  private lastRequested: number = 0
  private detailCapLevels: number = 0
  private centreBias: number
  private ownLodBias: number
  private budgetBias: number = 0
  private lastBudget: number = 0
  private uploadsAtBudget: number = 0

  constructor({
    source,
    channels = {},
    atlasSize = 4096,
    centreBias = 1,
    feedbackScale = 8,
    feedbackInterval = 2,
    lodBias = 0,
    detailCap = 0,
    flipV = true,
    uploadsPerFrame = 8,
    uploadBudgetMs = 2,
    fadeMs = 250,
    budget = true,
    scheduler = {},
    pool,
  }: VirtualTextureOptions) {
    this.feedbackInterval = feedbackInterval
    this.uploadsPerFrame = uploadsPerFrame
    this.uploadBudgetMs = uploadBudgetMs
    this.budget = budget
    this.centreBias = centreBias
    this.ownLodBias = lodBias

    const inputs: Partial<Record<ChannelName, ChannelInput>> = { ...channels }
    if (source) inputs.map = source
    const entries = Object.entries(inputs) as [ChannelName, ChannelInput][]
    if (entries.length === 0) throw new Error("Atlas: a VirtualTexture needs at least one channel")

    const options = entries.map(([name, input]) => ({
      name,
      options: isTileSource(input) ? { source: input } : input,
    }))
    const reference = options.reduce((best, c) =>
      c.options.source.manifest.width > best.options.source.manifest.width ? c : best
    )
    this.manifest = reference.options.source.manifest

    for (const { name, options: channelOptions } of options) {
      const channel = new AtlasChannel(name, channelOptions, this.manifest, atlasSize)
      channel.fadeMs = fadeMs
      this.channels.set(name, channel)
    }
    this.reference = this.channels.get(reference.name)!

    this.uniforms = {
      atlasVirtualSize: { value: new THREE.Vector2(this.manifest.width, this.manifest.height) },
      atlasPageGrid: { value: new THREE.Vector2(this.manifest.cols, this.manifest.rows) },
      atlasMaxLevel: { value: this.manifest.levels - 1 },
      atlasLodBias: { value: lodBias },
      atlasFlipV: { value: flipV ? 1 : 0 },
      atlasDebugTint: { value: 0 },
    }

    this.feedback = new FeedbackPass(this.manifest, this.uniforms, { scale: feedbackScale })
    this.scheduler = new TileScheduler(pool ? { ...scheduler, pool } : scheduler)
    this.detailCap = detailCap
  }

  // Levels held back from the finest on every channel, on top of each channel's maxSize.
  // Nothing finer is requested or sampled while it is set; finer pages already resident stay
  // and show again the moment it drops, so it can follow network speed or camera movement.
  public set detailCap(levels: number) {
    this.detailCapLevels = Math.max(0, Math.floor(levels))
    for (const channel of this.channels.values()) channel.detailCap = this.detailCapLevels
  }

  public get detailCap(): number {
    return this.detailCapLevels
  }

  //=========================
  // Convenience views of the reference channel
  //=========================

  public get cache() {
    return this.reference.cache
  }

  public get pageTable() {
    return this.reference.pageTable
  }

  public channel(name: ChannelName): AtlasChannel | undefined {
    return this.channels.get(name)
  }

  //=========================
  // Meshes
  //=========================

  public attach(mesh: THREE.Mesh, { triangleTint = false }: AttachOptions = {}): void {
    this.meshes.add(mesh)
    if (triangleTint) {
      const original = mesh.geometry
      const flat = prepareTriangleTint(original)
      if (flat !== original) {
        this.originalGeometry.set(mesh, original)
        mesh.geometry = flat
      }
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) =>
      applyVirtualTexture(material as PatchableMaterial, this.channels.values(), this.uniforms, {
        triangleTint,
      })
    )
  }

  public detach(mesh: THREE.Mesh): void {
    this.meshes.delete(mesh)
    const original = this.originalGeometry.get(mesh)
    if (original) {
      mesh.geometry.dispose()
      mesh.geometry = original
      this.originalGeometry.delete(mesh)
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) =>
      removeVirtualTexture(material as PatchableMaterial, this.channels.values())
    )
  }

  // The texture's own bias; what is drawn and requested with adds the budget's
  public set lodBias(bias: number) {
    this.ownLodBias = bias
    this.applyLodBias()
  }

  public get lodBias(): number {
    return this.ownLodBias
  }

  // The budget's bias in levels, on top of the texture's own
  public get budgetLodBias(): number {
    return this.budgetBias
  }

  private applyLodBias(): void {
    const bias = this.ownLodBias + this.budgetBias
    this.uniforms.atlasLodBias.value = bias
    this.feedback.setLodBias(bias)
  }

  // Milliseconds a landed tile dissolves in over the page it replaced, on every channel
  public set fadeMs(ms: number) {
    for (const channel of this.channels.values()) channel.fadeMs = ms
  }

  public get fadeMs(): number {
    return this.reference.fadeMs
  }

  // Tints the map channel by the level drawn from (green finest, red coarsest):
  // 1 per pixel, 2 flat per triangle (meshes attached with triangleTint), 0 off
  public set debugTint(mode: TintMode | boolean) {
    this.uniforms.atlasDebugTint.value = typeof mode === "boolean" ? (mode ? 1 : 0) : mode
  }

  public get debugTint(): TintMode {
    return this.uniforms.atlasDebugTint.value as TintMode
  }

  public cycleDebugTint(): TintMode {
    this.debugTint = ((this.debugTint + 1) % 3) as TintMode
    return this.debugTint
  }

  // UV rect of the real image inside the padded virtual texture (three convention, v up)
  public get contentUvRect(): { u0: number; v0: number; u1: number; v1: number } {
    const { width, height, contentWidth, contentHeight } = this.manifest
    return { u0: 0, v0: 1 - contentHeight / height, u1: contentWidth / width, v1: 1 }
  }

  //=========================
  // Frame loop
  //=========================

  public update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    this.frame++
    for (const channel of this.channels.values()) {
      channel.cache.initialise(renderer)
      if (!channel.pageTable.isResident(channel.root) && !this.scheduler.has(channel, channel.root)) {
        this.scheduler.want(channel, channel.root, Infinity, true, this.pass)
      }
    }

    if (this.meshes.size > 0 && this.frame % this.feedbackInterval === 0) {
      this.collectRequests(this.feedback.render(renderer, scene, camera, this.meshes))
    }

    // Each upload reads a tile's pixels and writes them, a fraction of a millisecond; a burst
    // after a zoom is spread over frames by the budget
    const minIdleFrame = this.minIdleFrame
    const now = performance.now()
    const deadline = now + this.uploadBudgetMs
    for (const channel of this.channels.values()) {
      channel.uploadLoaded(renderer, this.scheduler, this.frame, minIdleFrame, this.uploadsPerFrame, now, deadline)
    }
  }

  private get minIdleFrame(): number {
    return this.frame - this.feedbackInterval * 2
  }

  // Wanted pages arrive in reference terms with their screen coverage and position. Each
  // page and its ancestors is mapped into every channel; what is resident gets touched, the
  // rest is ranked by coverage, the quality gap it would close and closeness to the screen
  // centre, and only as many as the channel's cache can take are asked for. Whatever does not
  // make the cut simply keeps drawing from its resident ancestor, so with a small atlas the
  // finest level appears at the centre and fades to coarser levels toward the edges.
  private collectRequests(wanted: Map<PageKey, PageCoverage>): void {
    this.pass++
    this.lastRequested = wanted.size
    const maxLevel = this.manifest.levels - 1

    // Ancestors accumulate the coverage, and the coverage-weighted position, of every wanted
    // page beneath them
    const reference = new Map<PageKey, Demand>()
    for (const [key, coverage] of wanted) {
      let current: PageKey = key
      let direct = true
      while (true) {
        accumulate(reference, current, coverage.pixels, coverage.x, coverage.y, direct)
        if (pageLevel(current) >= maxLevel) break
        current = parentKey(current)
        direct = false
      }
    }

    const minIdleFrame = this.minIdleFrame
    let unmet = 0
    let pending = 0
    for (const channel of this.channels.values()) {
      const wants = new Map<PageKey, Demand>()
      for (const [key, entry] of reference) {
        accumulate(wants, channel.keyFor(key), entry.coverage, entry.x, entry.y, entry.direct)
      }

      const candidates: Array<{ key: PageKey; priority: number; direct: boolean }> = []
      let pendingHere = 0
      for (const [key, entry] of wants) {
        if (channel.pageTable.isResident(key)) {
          channel.cache.touch(key, this.frame)
          continue
        }
        const gap = channel.shownLevel(key) - pageLevel(key)
        const priority = entry.coverage * (1 + gap) * (1 + gap) * this.centreWeight(entry)
        if (this.scheduler.has(channel, key)) {
          this.scheduler.want(channel, key, priority, entry.direct, this.pass)
          pendingHere++
        } else if (this.scheduler.canRequest(channel, key, this.frame)) {
          candidates.push({ key, priority, direct: entry.direct })
        }
      }

      const budget =
        channel.cache.availableSlots(minIdleFrame, (k) => k === channel.root) - pendingHere
      candidates.sort((a, b) => b.priority - a.priority)
      for (const candidate of candidates.slice(0, Math.max(0, budget))) {
        this.scheduler.want(channel, candidate.key, candidate.priority, candidate.direct, this.pass)
      }
      unmet += Math.max(0, candidates.length - Math.max(0, budget))
      pending += pendingHere
    }

    this.scheduler.endPass(this.pass)
    this.adjustBudget(unmet, pending, minIdleFrame)
  }

  // Judged every 600 ms, longer than a page's protection: the bias rises half a level while
  // pages are wanted that no slot can take and nothing was placed since the last decision, and
  // eases back a quarter at a time once nothing is unmet or in flight and a tenth of the
  // reference atlas is free
  private adjustBudget(unmet: number, pending: number, minIdleFrame: number): void {
    const now = performance.now()
    if (!this.budget || now - this.lastBudget < 600) return
    const uploads = [...this.channels.values()].reduce((n, c) => n + c.stats.uploads, 0)
    const placed = uploads - this.uploadsAtBudget
    this.uploadsAtBudget = uploads
    this.lastBudget = now
    const cache = this.reference.cache
    let bias = this.budgetBias
    if (unmet > 0 && placed === 0) bias = Math.min(4, bias + 0.5)
    else if (unmet === 0 && pending === 0 && bias > 0 && cache.availableSlots(minIdleFrame, (k) => k === this.reference.root) > cache.capacity * 0.1) bias = Math.max(0, bias - 0.25)
    if (bias !== this.budgetBias) {
      this.budgetBias = bias
      this.applyLodBias()
    }
  }

  // 1 at the centre falling to 1 / (1 + 0.25 · centreBias) at the corners
  private centreWeight(entry: Demand): number {
    if (this.centreBias <= 0) return 1
    const distance = Math.min(1, Math.hypot(entry.x, entry.y) / Math.SQRT2)
    return 1 / (1 + this.centreBias * 0.25 * distance * distance)
  }

  public get stats(): VirtualTextureStats {
    const channels = [...this.channels.values()].map((c) => c.stats)
    const sum = (pick: (c: ChannelStats) => number) => channels.reduce((n, c) => n + pick(c), 0)
    const network = this.scheduler.stats
    return {
      frame: this.frame,
      resident: sum((c) => c.resident),
      capacity: sum((c) => c.capacity),
      pending: network.queued + network.inFlight,
      requested: this.lastRequested,
      uploads: sum((c) => c.uploads),
      failures: network.failures,
      channels,
      network,
      memoryBytes: sum((c) => c.memoryBytes),
      detailCap: this.detailCapLevels,
      budgetLodBias: this.budgetBias,
    }
  }

  public dispose(): void {
    for (const mesh of [...this.meshes]) this.detach(mesh)
    this.scheduler.dispose()
    this.feedback.dispose()
    for (const channel of this.channels.values()) channel.dispose()
    this.channels.clear()
  }
}

interface Demand {
  coverage: number
  // Coverage-weighted mean screen position, -1..1
  x: number
  y: number
  direct: boolean
}

const accumulate = (
  into: Map<PageKey, Demand>,
  key: PageKey,
  coverage: number,
  x: number,
  y: number,
  direct: boolean
): void => {
  const entry = into.get(key)
  if (!entry) {
    into.set(key, { coverage, x, y, direct })
    return
  }
  const total = entry.coverage + coverage
  entry.x = (entry.x * entry.coverage + x * coverage) / total
  entry.y = (entry.y * entry.coverage + y * coverage) / total
  entry.coverage = total
  entry.direct = entry.direct || direct
}
