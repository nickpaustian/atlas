import type AtlasChannel from "./AtlasChannel.js"
import { pageLevel, pageX, pageY, type PageKey } from "./TileSource.js"
import type { PoolClient, PoolTicket, PoolRunContext } from "./pool.js"

export interface SchedulerOptions {
  // Fetches in flight across every channel (ignored when a pool sets the budget)
  concurrency?: number
  // A shared fetch pool client (see @nickpaustian/tethys): the pool then decides when each tile's fetch
  // starts, by this scheduler's priorities normalised against each other and the client's weight
  pool?: PoolClient
  // Milliseconds a tile may go unwanted before an in-flight fetch is aborted
  graceMs?: number
  // In-flight fetches past this fraction of their bytes are left to finish
  abortBelow?: number
  // Frames to wait before re-requesting a tile the cache could not take
  cooldownFrames?: number
  // With a pool: rank tiles by priority per byte of the tile rather than by priority alone, so a
  // small tile that closes as much of a gap as a large one goes first and a pool shared with
  // Theia can weigh tiles against pages by the same measure. A tile's size is the mean of those
  // received at its level on its channel, `expectedTileBytes` until one has
  valuePerByte?: boolean
  expectedTileBytes?: number
}

export interface SchedulerStats {
  queued: number
  inFlight: number
  completed: number
  aborted: number
  failures: number
  bytes: number
}

export interface LoadedPage {
  key: PageKey
  image: ImageBitmap
}

interface ScheduledTile {
  id: string
  channel: AtlasChannel
  key: PageKey
  priority: number
  // Wanted on screen itself, as opposed to pulled in as an ancestor
  direct: boolean
  pass: number
  wantedAt: number
  controller: AbortController | null
  received: number
  total: number
  ticket: PoolTicket | null
}

const tileId = (channel: AtlasChannel, key: PageKey): string => `${channel.name}:${key}`

// One queue for every channel. Each feedback pass re-states what is wanted with a priority;
// anything not restated is dropped from the queue, and in-flight fetches that stay unwanted
// for a few passes are aborted unless they are mostly downloaded already.
export default class TileScheduler {
  private concurrency: number
  private graceMs: number
  private abortBelow: number
  private cooldownFrames: number
  private pool: PoolClient | null
  private valuePerByte: boolean
  private expectedTileBytes: number
  // Bytes received per channel, and per level within it, so a tile's size can be guessed
  private received: Map<AtlasChannel, { bytes: number; tiles: number; levels: Array<{ bytes: number; tiles: number }> }> = new Map()

  private queue: Map<string, ScheduledTile> = new Map()
  private inFlight: Map<string, ScheduledTile> = new Map()
  private loadedNotTaken: Set<string> = new Set()
  private failed: Set<string> = new Set()
  private cooldown: Map<string, number> = new Map()
  private disposed: boolean = false

  private completed: number = 0
  private aborted: number = 0
  private failures: number = 0
  private bytes: number = 0

  constructor({
    concurrency = 6,
    pool = null,
    graceMs = 250,
    abortBelow = 0.5,
    cooldownFrames = 30,
    valuePerByte = false,
    expectedTileBytes = 16384,
  }: SchedulerOptions = {}) {
    this.valuePerByte = valuePerByte
    this.expectedTileBytes = expectedTileBytes
    this.concurrency = concurrency
    this.graceMs = graceMs
    this.abortBelow = abortBelow
    this.cooldownFrames = cooldownFrames
    this.pool = pool
  }

  // Queued, in flight, or downloaded and waiting for the channel to take it
  public has(channel: AtlasChannel, key: PageKey): boolean {
    const id = tileId(channel, key)
    return this.queue.has(id) || this.inFlight.has(id) || this.loadedNotTaken.has(id)
  }

  public canRequest(channel: AtlasChannel, key: PageKey, frame: number): boolean {
    const id = tileId(channel, key)
    if (this.failed.has(id)) return false
    const until = this.cooldown.get(id)
    if (until !== undefined) {
      if (frame < until) return false
      this.cooldown.delete(id)
    }
    return true
  }

  // States that a tile is wanted this pass; an existing request just has its priority refreshed
  public want(channel: AtlasChannel, key: PageKey, priority: number, direct: boolean, pass: number): void {
    const id = tileId(channel, key)
    const existing = this.queue.get(id) ?? this.inFlight.get(id)
    if (existing) {
      existing.priority = priority
      existing.direct = existing.direct || direct
      existing.pass = pass
      existing.wantedAt = performance.now()
      return
    }
    if (this.loadedNotTaken.has(id)) return
    this.queue.set(id, {
      id,
      channel,
      key,
      priority,
      direct,
      pass,
      wantedAt: performance.now(),
      controller: null,
      received: 0,
      total: 0,
      ticket: null,
    })
  }

  // Called after every feedback pass: forget stale queue entries, abort stale fetches, start more
  public endPass(pass: number): void {
    for (const [id, tile] of this.queue) {
      if (tile.pass < pass) {
        tile.ticket?.cancel()
        this.queue.delete(id)
      }
    }
    const now = performance.now()
    for (const tile of this.inFlight.values()) {
      if (tile.pass >= pass || now - tile.wantedAt < this.graceMs) continue
      const progress = tile.total > 0 ? tile.received / tile.total : 0
      if (progress >= this.abortBelow) continue
      tile.controller?.abort()
    }
    this.pump()
  }

  // The cache had no slot for a downloaded tile: back off before asking for it again
  public dropped(channel: AtlasChannel, key: PageKey, frame: number): void {
    this.cooldown.set(tileId(channel, key), frame + this.cooldownFrames)
  }

  public taken(channel: AtlasChannel, key: PageKey): void {
    this.loadedNotTaken.delete(tileId(channel, key))
  }

  private pump(): void {
    if (this.disposed) return
    if (this.pool) {
      this.pumpPooled(this.pool)
      return
    }
    while (this.inFlight.size < this.concurrency && this.queue.size > 0) {
      let best: ScheduledTile | null = null
      for (const tile of this.queue.values()) {
        if (!best || tile.priority > best.priority) best = tile
      }
      if (!best) break
      this.queue.delete(best.id)
      this.inFlight.set(best.id, best)
      this.load(best).finally(() => {
        this.inFlight.delete(best!.id)
        this.pump()
      })
    }
  }

  // Mean bytes of the tiles received at a level of a channel; the channel's mean, then the
  // expected size, until one has
  public tileBytes(channel: AtlasChannel, level: number): number {
    const r = this.received.get(channel)
    if (!r) return this.expectedTileBytes
    const l = r.levels[level]
    if (l && l.tiles > 0) return l.bytes / l.tiles
    return r.tiles > 0 ? r.bytes / r.tiles : this.expectedTileBytes
  }

  // Every queued tile holds a pool ticket with its priority as a fraction of the most wanted
  // tile; the pool starts them in its own order and the tile moves to inFlight then
  private pumpPooled(pool: PoolClient): void {
    let max = 0
    for (const tile of this.queue.values()) if (Number.isFinite(tile.priority)) max = Math.max(max, tile.priority)
    for (const tile of this.queue.values()) {
      const priority = this.valuePerByte
        ? Math.min(tile.priority, Number.MAX_VALUE) / this.tileBytes(tile.channel, pageLevel(tile.key))
        : Number.isFinite(tile.priority) ? (max > 0 ? tile.priority / max : 1) : 1
      if (tile.ticket) {
        tile.ticket.setPriority(priority)
        continue
      }
      tile.ticket = pool.submit(
        priority,
        async (context) => {
          if (!this.queue.has(tile.id)) return
          this.queue.delete(tile.id)
          this.inFlight.set(tile.id, tile)
          try {
            await this.load(tile, context)
          } finally {
            this.inFlight.delete(tile.id)
          }
        },
        () => {
          tile.ticket = null
        }
      )
    }
  }

  private async load(tile: ScheduledTile, context?: PoolRunContext): Promise<void> {
    const { channel, key } = tile
    const url = channel.source.url(pageLevel(key), pageX(key), pageY(key))
    tile.controller = new AbortController()

    try {
      const init: RequestInit & { priority?: string } = {
        signal: tile.controller.signal,
        priority: tile.direct ? "high" : "low",
      }
      const response = await (channel.source.fetch ?? fetch)(url, init)
      if (!response.ok) throw new Error(`${response.status} ${url}`)

      tile.total = Number(response.headers.get("content-length")) || 0
      const blob = await this.readBody(response, tile, context)
      const image = await createImageBitmap(blob, {
        imageOrientation: "none",
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      })
      if (this.disposed) {
        image.close()
        return
      }
      this.completed++
      this.bytes += tile.received
      const r = this.received.get(channel) ?? { bytes: 0, tiles: 0, levels: [] }
      r.bytes += tile.received
      r.tiles++
      const level = (r.levels[pageLevel(key)] ??= { bytes: 0, tiles: 0 })
      level.bytes += tile.received
      level.tiles++
      this.received.set(channel, r)
      this.loadedNotTaken.add(tile.id)
      channel.loaded.push({ key, image })
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        this.aborted++
        return
      }
      this.failures++
      this.failed.add(tile.id)
      console.warn("[atlas] tile failed", url, error)
    }
  }

  // Streams the body so progress is known and a nearly finished download is not thrown away
  private async readBody(response: Response, tile: ScheduledTile, context?: PoolRunContext): Promise<Blob> {
    const reader = response.body?.getReader()
    if (!reader) return response.blob()
    const chunks: BlobPart[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      tile.received += value.byteLength
      context?.progress(value.byteLength)
    }
    return new Blob(chunks, { type: response.headers.get("content-type") ?? "" })
  }

  public get stats(): SchedulerStats {
    return {
      queued: this.queue.size,
      inFlight: this.inFlight.size,
      completed: this.completed,
      aborted: this.aborted,
      failures: this.failures,
      bytes: this.bytes,
    }
  }

  public dispose(): void {
    this.disposed = true
    for (const tile of this.inFlight.values()) tile.controller?.abort()
    for (const tile of this.queue.values()) tile.ticket?.cancel()
    this.queue.clear()
    this.loadedNotTaken.clear()
  }
}
