import type AtlasChannel from "./AtlasChannel.js"
import { pageLevel, pageX, pageY } from "./TileSource.js"
import type VirtualTexture from "./VirtualTexture.js"

// 0 = finest level (green) through to 1 = coarsest (red), the same ramp the shader tint uses
export const levelColor = (t: number): [number, number, number] => {
  const clamped = Math.min(1, Math.max(0, t))
  return [Math.min(1, clamped * 2), Math.min(1, (1 - clamped) * 2), 0]
}

const css = ([r, g, b]: [number, number, number], alpha = 1): string =>
  `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`

export interface AtlasDebugOverlayOptions {
  size?: number
  // Redraw every n calls to update()
  interval?: number
}

interface ChannelView {
  channel: AtlasChannel
  pages: HTMLCanvasElement
  slots: HTMLCanvasElement
  legend: HTMLDivElement
}

// Draws every channel unwrapped: each level-0 page coloured by the level it currently draws
// from, resident pages outlined at their own size, the content rect, the atlas slot
// occupancy, and a legend of levels with texel sizes and resident counts.
export default class AtlasDebugOverlay {
  public readonly element: HTMLDivElement
  private views: ChannelView[] = []
  private interval: number
  private calls: number = 0
  private visible: boolean = false

  constructor(vt: VirtualTexture, { size = 200, interval = 4 }: AtlasDebugOverlayOptions = {}) {
    this.interval = interval

    this.element = document.createElement("div")
    Object.assign(this.element.style, {
      position: "fixed",
      right: "12px",
      top: "12px",
      display: "none",
      padding: "10px",
      background: "rgba(0, 0, 0, 0.75)",
      color: "#fff",
      font: "11px/1.4 ui-monospace, Menlo, monospace",
      borderRadius: "6px",
      pointerEvents: "none",
      zIndex: "10",
      maxHeight: "calc(100vh - 24px)",
      overflow: "hidden",
    } as CSSStyleDeclaration)

    const title = (text: string): HTMLDivElement => {
      const div = document.createElement("div")
      div.textContent = text
      div.style.opacity = "0.7"
      div.style.marginTop = "6px"
      return div
    }

    const columns = document.createElement("div")
    columns.style.display = "flex"
    columns.style.gap = "12px"
    this.element.appendChild(columns)

    for (const channel of vt.channels.values()) {
      const { width, height } = channel.manifest
      const column = document.createElement("div")

      const pages = document.createElement("canvas")
      pages.width = size
      pages.height = Math.round((size * height) / width)
      pages.style.display = "block"

      const slots = document.createElement("canvas")
      slots.width = size
      slots.height = Math.round(size / 4)
      slots.style.display = "block"

      const legend = document.createElement("div")
      legend.style.whiteSpace = "pre"
      legend.style.marginTop = "4px"

      const cap = channel.minLevel > 0 ? `  cap ${width >> channel.minLevel}px` : ""
      column.append(
        title(`${channel.name}  ${width}x${height}${cap}`),
        pages,
        title("atlas slots"),
        slots,
        legend
      )
      columns.appendChild(column)
      this.views.push({ channel, pages, slots, legend })
    }
    document.body.appendChild(this.element)
  }

  public show(): void {
    this.visible = true
    this.element.style.display = "block"
    this.draw()
  }

  public hide(): void {
    this.visible = false
    this.element.style.display = "none"
  }

  public toggle(): void {
    this.visible ? this.hide() : this.show()
  }

  public update(): void {
    if (!this.visible) return
    if (this.calls++ % this.interval !== 0) return
    this.draw()
  }

  private draw(): void {
    for (const view of this.views) {
      this.drawPages(view)
      this.drawSlots(view)
      this.drawLegend(view)
    }
  }

  private drawPages({ channel, pages }: ChannelView): void {
    const { manifest, pageTable } = channel
    const ctx = pages.getContext("2d")!
    const { width, height } = pages
    const cellW = width / manifest.cols
    const cellH = height / manifest.rows
    const maxLevel = Math.max(1, manifest.levels - 1)
    const base = pageTable.levels[0]

    ctx.clearRect(0, 0, width, height)
    for (let y = 0; y < manifest.rows; y++) {
      for (let x = 0; x < manifest.cols; x++) {
        const offset = (y * base.width + x) * 4
        ctx.fillStyle =
          base.data[offset + 3] === 0 ? "#222" : css(levelColor(base.data[offset + 2] / maxLevel), 0.9)
        ctx.fillRect(x * cellW, y * cellH, cellW, cellH)
      }
    }

    // Resident pages outlined at their own size
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)"
    ctx.lineWidth = 1
    for (const key of pageTable.residentKeys()) {
      const scale = 2 ** pageLevel(key)
      ctx.strokeRect(
        pageX(key) * cellW * scale + 0.5,
        pageY(key) * cellH * scale + 0.5,
        cellW * scale - 1,
        cellH * scale - 1
      )
    }

    // The real image inside the padding
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)"
    ctx.strokeRect(
      0.5,
      0.5,
      (manifest.contentWidth / manifest.width) * width - 1,
      (manifest.contentHeight / manifest.height) * height - 1
    )
  }

  private drawSlots({ channel, slots }: ChannelView): void {
    const { cache, manifest } = channel
    const ctx = slots.getContext("2d")!
    const { width, height } = slots
    const maxLevel = Math.max(1, manifest.levels - 1)
    const cols = Math.max(cache.slotsPerRow, Math.ceil(cache.capacity / Math.max(1, Math.floor(height / 8))))
    const rows = Math.ceil(cache.capacity / cols)
    const cellW = width / cols
    const cellH = height / rows

    ctx.clearRect(0, 0, width, height)
    for (let slot = 0; slot < cache.capacity; slot++) {
      const key = cache.slotKey(slot)
      ctx.fillStyle = key === -1 ? "#222" : css(levelColor(pageLevel(key) / maxLevel), 0.9)
      ctx.fillRect((slot % cols) * cellW + 0.5, Math.floor(slot / cols) * cellH + 0.5, cellW - 1, cellH - 1)
    }
  }

  private drawLegend({ channel, legend }: ChannelView): void {
    const { manifest, pageTable, cache } = channel
    const maxLevel = Math.max(1, manifest.levels - 1)
    const counts = new Array<number>(manifest.levels).fill(0)
    for (const key of pageTable.residentKeys()) counts[pageLevel(key)]++

    const lines: string[] = []
    for (let level = 0; level < manifest.levels; level++) {
      const size = Math.max(1, manifest.width >> level)
      const swatch = `<span style="display:inline-block;width:9px;height:9px;background:${css(levelColor(level / maxLevel))};vertical-align:middle;margin-right:5px"></span>`
      const capped = level < channel.minLevel ? ' <span style="opacity:0.5">capped</span>' : ""
      lines.push(`${swatch}L${level} ${String(size).padStart(5)}px ${String(counts[level]).padStart(4)}${capped}`)
    }
    lines.push(`<span style="opacity:0.7">slots ${pageTable.residentCount}/${cache.capacity}</span>`)
    legend.innerHTML = lines.join("\n")
  }

  public dispose(): void {
    this.element.remove()
  }
}
