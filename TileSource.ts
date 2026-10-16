// A fetch-shaped function: hosts wrap the global one to add headers or sign URLs
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export const TILE_FORMAT_VERSION = 1

export interface TileManifest {
  // Layout version of the pyramid; absent on pyramids built before the field existed (= 1)
  version?: number
  // Per-build token appended to tile URLs, so a rebuilt pyramid is never served from a cache of the old one
  build?: string
  // Virtual texture size in texels. Padded so the level-0 page grid is a power of two.
  width: number
  height: number
  // The real image inside the padding, anchored top-left
  contentWidth: number
  contentHeight: number
  tileSize: number
  border: number
  // Pages at level 0; each level above halves both until a single page
  cols: number
  rows: number
  levels: number
  format: string
}

export interface TileSource {
  readonly manifest: TileManifest
  url(level: number, x: number, y: number): string
  // Used for tile requests when present, the global fetch otherwise
  readonly fetch?: FetchLike
}

export interface TileSourceOptions {
  fetch?: FetchLike
}

export class UrlTileSource implements TileSource {
  public readonly manifest: TileManifest
  public readonly fetch?: FetchLike
  private baseUrl: string
  private suffix: string

  constructor(baseUrl: string, manifest: TileManifest, { fetch }: TileSourceOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "")
    this.manifest = manifest
    this.fetch = fetch
    this.suffix = manifest.build ? `?v=${manifest.build}` : ""
  }

  public url(level: number, x: number, y: number): string {
    return `${this.baseUrl}/${level}/${x}_${y}.${this.manifest.format}${this.suffix}`
  }
}

export async function loadTileSource(baseUrl: string, options: TileSourceOptions = {}): Promise<UrlTileSource> {
  const base = baseUrl.replace(/\/$/, "")
  const response = await (options.fetch ?? fetch)(`${base}/manifest.json`, { cache: "no-cache" })
  if (!response.ok) throw new Error(`Atlas: manifest not found at ${base}`)
  const manifest = (await response.json()) as TileManifest
  const version = manifest.version ?? TILE_FORMAT_VERSION
  if (version !== TILE_FORMAT_VERSION) {
    throw new Error(`Atlas: ${base} is tile format ${version}; this build reads ${TILE_FORMAT_VERSION}. Rebuild it with "atlas tiles"`)
  }
  return new UrlTileSource(base, manifest, options)
}

//=========================
// Page keys
//=========================

// level:8 | y:12 | x:12, so a page grid can be up to 4096 pages a side
export type PageKey = number

export const pageKey = (level: number, x: number, y: number): PageKey =>
  (level << 24) | (y << 12) | x

export const pageLevel = (key: PageKey): number => key >>> 24
export const pageX = (key: PageKey): number => key & 0xfff
export const pageY = (key: PageKey): number => (key >>> 12) & 0xfff

export const parentKey = (key: PageKey): PageKey =>
  pageKey(pageLevel(key) + 1, pageX(key) >> 1, pageY(key) >> 1)

export const pagesAtLevel = (
  manifest: TileManifest,
  level: number
): { cols: number; rows: number } => ({
  cols: Math.max(1, manifest.cols >> level),
  rows: Math.max(1, manifest.rows >> level),
})

export const rootKey = (manifest: TileManifest): PageKey =>
  pageKey(manifest.levels - 1, 0, 0)
