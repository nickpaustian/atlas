import { describe, it, expect, beforeAll } from "vitest"
import { TileScheduler, pageKey } from "../index.js"
import type { AtlasChannel, PoolClient, PoolTicket } from "../index.js"
import { fakeFetch, settle } from "./fakeFetch.js"

beforeAll(() => {
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({ width: 1, height: 1, close() {} })
})

const channelWith = (fetch: (url: string, init?: RequestInit) => Promise<Response>, name = "map") =>
  ({ name, source: { url: (l: number, x: number, y: number) => `/t/${l}/${x}_${y}.webp`, fetch, manifest: {} }, loaded: [] as Array<{ key: number }> }) as unknown as AtlasChannel

const fakePool = () => {
  type Entry = { priority: number; run: (c: { progress: (n: number) => void }) => Promise<void>; onCancel?: () => void; started: boolean }
  const waiting: Entry[] = []
  const client: PoolClient = {
    submit(priority, run, onCancel): PoolTicket {
      const entry: Entry = { priority, run, onCancel, started: false }
      waiting.push(entry)
      return { setPriority: (p) => { entry.priority = p }, cancel: () => { const i = waiting.indexOf(entry); if (i !== -1) { waiting.splice(i, 1); onCancel?.() } }, get started() { return entry.started } }
    },
  }
  const startBest = () => {
    waiting.sort((a, b) => b.priority - a.priority)
    const entry = waiting.shift()!
    entry.started = true
    return entry.run({ progress: () => {} })
  }
  return { client, waiting, startBest }
}

describe("TileScheduler", () => {
  it("starts the highest priority first within the concurrency and hands finished tiles to the channel", async () => {
    const { fetch, calls } = fakeFetch()
    const channel = channelWith(fetch)
    const scheduler = new TileScheduler({ concurrency: 1 })
    scheduler.want(channel, pageKey(0, 0, 0), 1, true, 1)
    scheduler.want(channel, pageKey(0, 1, 0), 5, true, 1)
    scheduler.endPass(1)
    expect(calls.map((c) => c.url)).toEqual(["/t/0/1_0.webp"])
    expect((calls[0].init as { priority?: string }).priority).toBe("high")
    expect(scheduler.has(channel, pageKey(0, 0, 0))).toBe(true)
    calls[0].respond({ headers: { "Content-Length": "4" } })
    calls[0].push(new Uint8Array([1, 2, 3, 4]))
    calls[0].close()
    await settle()
    await settle()
    expect(channel.loaded.map((p) => p.key)).toEqual([pageKey(0, 1, 0)])
    expect(scheduler.stats).toMatchObject({ completed: 1, bytes: 4, inFlight: 1, queued: 0 })
    expect(calls.map((c) => c.url)).toEqual(["/t/0/1_0.webp", "/t/0/0_0.webp"])
    scheduler.taken(channel, pageKey(0, 1, 0))
    expect(scheduler.has(channel, pageKey(0, 1, 0))).toBe(false)
  })

  it("drops queued tiles that are not restated and aborts stale fetches that are under the progress threshold", async () => {
    const { fetch, calls } = fakeFetch()
    const channel = channelWith(fetch)
    const scheduler = new TileScheduler({ concurrency: 2, graceMs: 0, abortBelow: 0.5 })
    scheduler.want(channel, pageKey(0, 0, 0), 1, true, 1)
    scheduler.want(channel, pageKey(0, 1, 0), 1, true, 1)
    scheduler.want(channel, pageKey(0, 2, 0), 1, true, 1)
    scheduler.endPass(1)
    expect(calls.length).toBe(2)
    calls[0].respond({ headers: { "Content-Length": "100" } })
    calls[0].push(new Uint8Array(60))
    calls[1].respond({ headers: { "Content-Length": "100" } })
    calls[1].push(new Uint8Array(10))
    await settle()
    scheduler.endPass(2)
    expect(calls[0].aborted).toBe(false)
    expect(calls[1].aborted).toBe(true)
    expect(scheduler.has(channel, pageKey(0, 2, 0))).toBe(false)
    await settle()
    expect(scheduler.stats.aborted).toBe(1)
    calls[0].push(new Uint8Array(40))
    calls[0].close()
    await settle()
    await settle()
    expect(scheduler.stats.completed).toBe(1)
  })

  it("remembers failures and backs off tiles the cache dropped", async () => {
    const { fetch, calls } = fakeFetch()
    const channel = channelWith(fetch)
    const scheduler = new TileScheduler({ concurrency: 1, cooldownFrames: 10 })
    scheduler.want(channel, pageKey(1, 0, 0), 1, false, 1)
    scheduler.endPass(1)
    expect((calls[0].init as { priority?: string }).priority).toBe("low")
    calls[0].respond({ status: 404 })
    calls[0].close()
    await settle()
    await settle()
    expect(scheduler.stats.failures).toBe(1)
    expect(scheduler.canRequest(channel, pageKey(1, 0, 0), 5)).toBe(false)
    scheduler.dropped(channel, pageKey(0, 3, 3), 100)
    expect(scheduler.canRequest(channel, pageKey(0, 3, 3), 105)).toBe(false)
    expect(scheduler.canRequest(channel, pageKey(0, 3, 3), 110)).toBe(true)
  })

  it("hands every queued tile to a pool with normalised priorities and loads when the pool starts it", async () => {
    const { fetch, calls } = fakeFetch()
    const channel = channelWith(fetch)
    const pool = fakePool()
    const scheduler = new TileScheduler({ pool: pool.client, concurrency: 1 })
    scheduler.want(channel, pageKey(0, 0, 0), 2, true, 1)
    scheduler.want(channel, pageKey(0, 1, 0), 8, true, 1)
    scheduler.want(channel, pageKey(2, 0, 0), Infinity, false, 1)
    scheduler.endPass(1)
    expect(pool.waiting.map((e) => e.priority)).toEqual([0.25, 1, 1])
    expect(calls.length).toBe(0)
    scheduler.want(channel, pageKey(0, 1, 0), 8, true, 2)
    scheduler.endPass(2)
    expect(pool.waiting.length).toBe(1)
    const running = pool.startBest()
    expect(calls.map((c) => c.url)).toEqual(["/t/0/1_0.webp"])
    expect(scheduler.stats).toMatchObject({ queued: 0, inFlight: 1 })
    calls[0].respond({ headers: { "Content-Length": "2" } })
    calls[0].push(new Uint8Array(2))
    calls[0].close()
    await running
    expect(channel.loaded.length).toBe(1)
  })

  it("ranks pooled tiles by priority per byte from the sizes received at each level", async () => {
    const { fetch, calls } = fakeFetch()
    const { client, waiting, startBest } = fakePool()
    const channel = channelWith(fetch)
    const scheduler = new TileScheduler({ pool: client, valuePerByte: true, expectedTileBytes: 1000 })
    scheduler.want(channel, pageKey(0, 0, 0), 2, true, 1)
    scheduler.endPass(1)
    expect(waiting[0].priority).toBe(0.002)
    const run = startBest()
    calls[0].respond({ headers: { "content-length": "4000" } })
    calls[0].push(new Uint8Array(4000))
    calls[0].close()
    await run
    expect(scheduler.tileBytes(channel, 0)).toBe(4000)
    expect(scheduler.tileBytes(channel, 1)).toBe(4000)
    scheduler.want(channel, pageKey(0, 1, 0), 2, true, 2)
    scheduler.want(channel, pageKey(1, 0, 0), 2, true, 2)
    scheduler.endPass(2)
    expect(waiting.map((e) => e.priority)).toEqual([0.0005, 0.0005])
  })

  it("aborts everything in flight and cancels tickets on dispose", () => {
    const { fetch, calls } = fakeFetch()
    const channel = channelWith(fetch)
    const scheduler = new TileScheduler({ concurrency: 1 })
    scheduler.want(channel, pageKey(0, 0, 0), 1, true, 1)
    scheduler.want(channel, pageKey(0, 1, 0), 1, true, 1)
    scheduler.endPass(1)
    scheduler.dispose()
    expect(calls[0].aborted).toBe(true)
    expect(scheduler.stats.queued).toBe(0)
  })
})
