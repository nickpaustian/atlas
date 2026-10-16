// A fetch whose responses are streamed by hand: each call hands back a handle to respond,
// push chunks, close or fail, and reports whether the caller aborted it.
export interface FetchHandle {
  url: string
  init: RequestInit | undefined
  aborted: boolean
  respond(options?: { status?: number; headers?: Record<string, string> }): void
  push(chunk: Uint8Array): void
  close(): void
}

export const fakeFetch = () => {
  const calls: FetchHandle[] = []
  const fetch = (url: string, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null
      let responded = false
      const handle: FetchHandle = {
        url,
        init,
        aborted: false,
        respond({ status = 200, headers = {} } = {}) {
          responded = true
          const stream = new ReadableStream<Uint8Array>({ start: (c) => { controller = c } })
          resolve(new Response(stream, { status, headers }))
        },
        push: (chunk) => controller!.enqueue(chunk),
        close: () => controller!.close(),
      }
      init?.signal?.addEventListener("abort", () => {
        handle.aborted = true
        const error = new DOMException("aborted", "AbortError")
        if (!responded) reject(error)
        else controller?.error(error)
      })
      calls.push(handle)
    })
  return { fetch, calls, last: () => calls[calls.length - 1] }
}

export const settle = () => new Promise((r) => setTimeout(r, 0))

// Serves whole or ranged slices of in-memory files, like a static host
export const staticFetch = (files: Record<string, Uint8Array>, { honourRange = true } = {}) => {
  const requests: Array<{ url: string; range: string | null }> = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = url.split("?")[0]
    const file = files[path]
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null
    requests.push({ url, range })
    if (!file) return new Response("not found", { status: 404 })
    if (range && honourRange) {
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!
      return new Response(file.slice(Number(from), Number(to) + 1), { status: 206, headers: { "Content-Length": String(Number(to) - Number(from) + 1) } })
    }
    return new Response(file, { status: 200, headers: { "Content-Length": String(file.length) } })
  }
  return { fetch, requests }
}
