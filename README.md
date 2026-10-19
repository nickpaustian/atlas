# Atlas

Virtual texturing for three.js. Atlas lets a mesh show an image far larger than any single GPU texture (tens of thousands of texels a side) by streaming only the tiles the camera can actually see, at the resolution it needs, into one fixed-size cache texture, the atlas.

Use it when a single object carries more texture than fits in memory at once: scanned artefacts with 8k to 16k maps, large documents and paintings, or several high-resolution maps (colour, normal, roughness) on one mesh. For textures that already fit on the GPU, a plain `Texture` is simpler and faster.

Terms follow the literature: tiles are *pages*, the indirection texture is the *page table*, and the one physical texture the pages are packed into is the *atlas*. Atlas is the Titan who holds up the sky; its sibling [Theia](https://github.com/nickpaustian/theia) streams geometry the same way, and [Tethys](https://github.com/nickpaustian/tethys) shares a connection budget between them.

## Install

```
npm install @nickpaustian/atlas three
```

`three` is a peer dependency, tested from r159 to r169. The build tools need Node 18 or later; they use [sharp](https://sharp.pixelplumbing.com), which installs with the package.

## Usage

```ts
import * as THREE from "three"
import { VirtualTexture, loadTileSource } from "@nickpaustian/atlas"

const source = await loadTileSource("/tiles/letter")
const vt = new VirtualTexture({ source })

const mesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, source.manifest.height / source.manifest.width),
  new THREE.MeshBasicMaterial()
)
vt.attach(mesh)     // reroutes the material's map through the atlas
scene.add(mesh)

function render() {
  vt.update(renderer, scene, camera)   // feedback, loads, uploads, page table
  renderer.render(scene, camera)
}
```

The virtual texture is padded so its page grid is a power of two; `vt.contentUvRect` gives the UV rectangle of the real image if the geometry should only show that part. Call `vt.detach(mesh)` to restore the original material (and geometry, if `triangleTint` replaced it) and `vt.dispose()` to detach everything, abort pending fetches and release the GPU textures.

`loadTileSource(url, { fetch })` takes a fetch-shaped function for the manifest and every tile request, so a host can add headers, sign URLs or route through a proxy; a custom `TileSource` can expose the same `fetch` property. Tile URLs carry the manifest's `build` token as a query string, so tiles can be served with a long cache lifetime and a rebuild is never served stale.

### Channels

Every texture slot of a material can stream. Each is a *channel* with its own tile pyramid, cache, page table and loader; all share the mesh UV space, so one feedback pass serves them all.

```ts
const vt = new VirtualTexture({
  channels: {
    map: await loadTileSource("/tiles/statue"),
    normalMap: { source: await loadTileSource("/tiles/statue-normalMap"), maxSize: 1024 },
    aoMap: await loadTileSource("/tiles/statue-aoMap"),
  },
  flipV: false,
})
```

- Channel names are the material properties: `map`, `normalMap`, `roughnessMap`, `metalnessMap`, `aoMap`, `emissiveMap`, `specularMap`.
- The largest channel is the *reference*; feedback requests are made in its page grid. A smaller channel must be the reference halved a whole number of times (same tile size and border), and simply sits that many levels coarser.
- Colour space is sRGB for `map` and `emissiveMap`, linear for the rest, unless `colorSpace` is given.
- Normal maps suffer most under lossy compression; build their tiles with a higher `--quality` (92 is a reasonable floor) than colour.
- Before a channel's root page lands it returns a neutral fallback (grey diffuse, flat normal, white roughness, metalness and AO).

Any built-in material works: `attach` expands the three chunk that samples each slot (`map_fragment`, `normal_fragment_maps`, `aomap_fragment`, ...) and swaps its `texture2D` call for the atlas lookup through `onBeforeCompile`. A patch already on the material runs first and stays, and `detach` restores it. Custom materials can include `atlasSharedChunk` and `atlasChannelChunk(name)` and call `atlasSample_<name>(uv)` directly.

## Options

`new VirtualTexture(options)`:

| option | default | meaning |
| --- | --- | --- |
| `source` | | shorthand for `channels: { map: source }` |
| `channels` | | one tile source or channel options per material slot (see below) |
| `atlasSize` | 4096 | largest each channel's square atlas may be, in texels. As many whole slots of `tileSize + 2·border` as fit are used: with 256 px tiles and a 4 px border a slot is 264 texels, so 4096 holds 15 × 15 = 225 tiles (60 MB), 2048 holds 7 × 7 = 49 (13 MB), 1024 holds 3 × 3 = 9 (2 MB). Anything under one slot still gets one, so that channel only ever shows its root page. Must not exceed `renderer.capabilities.maxTextureSize` |
| `detailCap` | 0 | levels held back from the finest on every channel, on top of `maxSize`. A runtime knob (`vt.detailCap = 1` halves the resolution) for slow networks or weak devices; nothing finer is requested or sampled while it is set, and resident finer pages show again the moment it drops |
| `lodBias` | 0 | positive picks coarser pages |
| `centreBias` | 1 | how much closeness to the screen centre counts when pages compete for slots. Screen coverage is the main factor and position mostly breaks ties: 1 makes a centre page worth about 1.25 corner pages of the same size, 4 about two, 0 ignores position |
| `flipV` | true | three's own geometry puts v = 0 at the image bottom; pass `false` for glTF meshes, whose UVs put it at the top |
| `feedbackScale` | 8 | the feedback target is the viewport divided by this in each axis |
| `feedbackInterval` | 2 | frames between feedback passes |
| `uploadsPerFrame` | 8 | atlas uploads per frame per channel |
| `uploadBudgetMs` | 2 | milliseconds of main-thread time a frame may spend on uploads across the channels; at least one tile lands a frame on each, the rest wait their turn, so a burst after a zoom cannot stall a frame |
| `fadeMs` | 250 | milliseconds a landed tile dissolves in over the page it replaced, so a level change is a blend rather than a pop; `0` switches at once. A live field |
| `budget` | true | when a channel's atlas is full and pages are still wanted, pick coarser pages (a bias on top of `lodBias`, half a level at a time, every 600 ms) until the cut fits, and ease it back a quarter at a time as room returns, so a small atlas shows a coarser whole rather than the finest level in a patch |
| `scheduler.concurrency` | 6 | parallel tile fetches across all channels; ignored when `pool` is set |
| `scheduler.graceMs` | 250 | how long a tile may be unwanted before its fetch is aborted |
| `scheduler.abortBelow` | 0.5 | fetches past this fraction downloaded are left to finish |
| `scheduler.cooldownFrames` | 30 | frames before re-requesting a tile the cache could not take |
| `scheduler.valuePerByte` | false | with `pool`: rank tiles by priority per byte of the tile rather than by priority alone, so a small tile that closes as much of a gap as a large one goes first and a pool shared with Theia weighs tiles against pages by one measure. A tile's size is the mean received at its level on its channel |
| `scheduler.expectedTileBytes` | 16384 | the size assumed for a level until a tile of it has arrived |
| `pool` | none | a client of a shared fetch pool ([Tethys](https://github.com/nickpaustian/tethys)); the pool then owns the connection budget |

A channel entry is either a `TileSource` or:

| option | default | meaning |
| --- | --- | --- |
| `source` | | the channel's tile source |
| `maxSize` | none | finest texels the channel ever streams. A 4k normal map with `maxSize: 1024` stops at its level 2 and never loads the two finer levels, however close the camera gets |
| `atlasSize` | the texture's | this channel's own atlas size, say a smaller one for a roughness map |
| `colorSpace` | by name | overrides the sRGB / linear default |

`vt.attach(mesh, { triangleTint: true })` rebuilds the geometry non-indexed with a per-triangle centroid UV so debug tint mode 2 works (three times the vertices, so it is opt-in).

## Sizing for a device

`atlasSize` is the knob, globally and per channel, so a cheap map can run on a small cache while the diffuse keeps a large one. Each channel costs `atlasSize² × 4` bytes of GPU memory plus a tiny page table; `vt.stats.memoryBytes` reports the total. Pick the size from the device class before constructing, and keep it under `renderer.capabilities.maxTextureSize`.

When a view wants more pages than a channel's atlas can hold, requests are cut by priority and the pages that miss out keep drawing from their resident ancestor, so the finest level appears at the screen centre and fades to coarser levels toward the edges. Nothing is evicted while it is wanted, so a still camera never pops. `detailCap` is the runtime counterpart: raise it while the network is slow or the camera is moving, lower it once things settle.

## Building tiles

```
atlas tiles input.png out/dir [--tile 256] [--border 4] [--format webp] [--quality 85] [--force]
```

The tool pads the image so the level-0 page grid is a power of two, builds mip levels down to a single page (Lanczos), and cuts every level into tiles of `tileSize` with a `border` of edge pixels on each side, so bilinear filtering never bleeds across tiles. It writes `manifest.json` next to `{level}/{x}_{y}.webp`; the manifest carries a `version` (1) that the loader checks and a per-build token. The output folder must be empty unless `--force` is given, which replaces its contents. Serve the folder as static files with a long cache lifetime. The layout is written down in [formats.md](docs/formats.md).

### Diagnostic texture

```
atlas test-texture test8k.png [--size 8192] [--cell 256] [--font family]
atlas tiles test8k.png out/test8k
```

One cell per level-0 page: hue across, lightness down, the page coordinates in large text (legible from level 3), a small caption and 1 px pinstripes that only resolve at level 0, thick white lines every four cells (one level-2 page) and a red diagonal for orientation. Put it on any mesh to see which level each part of the surface is drawing from. A 16k texture is 64 × 64 cells, 7 levels and 5461 tiles, a few minutes to build. Text is set in the system's Arial or sans-serif; `--font` names another family.

## Inspecting and previewing a build

```
atlas inspect out/dir
atlas preview out/dir [--normalMap dir] [--roughnessMap dir] ... [--port 4181] [--no-open] [--atlasSize 4096]
```

`inspect` checks the manifest's geometry (power-of-two page grid, level count, content inside the padding, the 256-page limit), confirms every tile of every level is present and decodes to the slot size, and prints a table per level of tiles, bytes and average tile size. It exits non-zero on a missing or mis-sized tile.

`preview` serves the pyramid and any sibling folders named `<dir>-<channel>` (or folders given by flag), alongside this package's build and the three.js installed next to it, and opens a viewer: a plane the shape of the image, lit when more than one channel is present, with debug tint, the atlas overlay and the detail cap on keys (H lists them). It needs the package built (`npm run build` in the package, already done for a published copy).

The `atlas` command runs from the package (`npx atlas`, or on the path after a global install). `atlas --help` lists the commands.

## Stats and debugging

`vt.stats` reports, per frame: resident pages and capacity across channels, pending and requested pages, uploads, failures, GPU memory, the current `detailCap` and `budgetLodBias`, a per-channel breakdown (resident, capacity, uploads, dropped, `minLevel`, atlas size, memory) and the network counters (queued, in flight, completed, aborted, failures, bytes).

- `vt.debugTint = 1` tints every pixel by the level it draws from, green for level 0 through red for the coarsest, keeping the texture's luminance so the image stays readable. `vt.debugTint = 2` paints each triangle flat with the level its centroid draws from (needs `triangleTint` on attach). `vt.cycleDebugTint()` steps off, pixel, triangle.
- `new AtlasDebugOverlay(vt)` adds a fixed-position panel: the virtual texture unwrapped with each level-0 page coloured by the level it currently draws from and resident pages outlined at their own size, the content rect, the atlas slot occupancy, and a legend of levels with texel sizes and resident counts. Call `overlay.update()` each frame and `toggle()` to show it.

Both use the same ramp, `levelColor(t)` in JS and `atlasLevelColor(t)` in GLSL.

## How it works

1. **Tile pyramid** (offline). The build tool writes the padded pyramid described above.
2. **Feedback pass** (every `feedbackInterval` frames). The attached meshes are rendered alone at `1/feedbackScale` resolution with a shader that outputs, per pixel, the page it wants: page x, page y and mip level, derived from the screen-space derivatives of the virtual UVs. The result is read back and decoded into a set of page keys.
3. **Scheduler.** One queue for every channel with a shared concurrency budget. Each feedback pass restates what is wanted; anything not restated is dropped from the queue, and an in-flight fetch that stays unwanted past a grace period is aborted unless it is already mostly downloaded. A page's priority is its screen coverage, times the square of the quality gap it would close, times closeness to the screen centre, so a region drawing three levels too coarse outranks one drawing one level too coarse. An ancestor accumulates the coverage of every wanted page beneath it, so it wins while nothing covers that area and loses once a reasonable fallback is resident. Requests are capped to the slots the channel's cache can give, and a tile the cache could not take is not asked for again for a cooldown. Bodies are streamed so progress is known, direct pages use the fetch priority hint `high` and ancestors `low`, and tiles are decoded with `createImageBitmap`.
4. **Page cache.** A square atlas of equal slots. Loaded tiles are uploaded into a slot with `texSubImage2D` on the raw context, which touches nothing else, as many a frame as the upload budget allows. Slots are reused least-recently-used first, and the root page is never evicted. When the atlas stays full while pages are still wanted, the level asked for is biased coarser until the cut fits, and eased back as room returns.
5. **Page table.** One mip level per page level. Each texel names the atlas slot of the finest resident page covering that virtual page, at that level or coarser, with how far that page has faded in since it landed in alpha. It is rebuilt on the CPU whenever residency changes or a page is still fading, and re-uploaded as a tiny data texture with explicit mip levels.
6. **Sampling.** The material shader computes the desired level, looks up the page table at that level with `textureLod`, then samples the atlas inside the slot it names. A page with no tile of its own inherits its parent's slot, so there is always something to draw once the root has landed. A page still fading in is blended with the page it replaced, which the table one level above still names, so a level change dissolves rather than pops.

## Limitations

- WebGL 2 only.
- One `VirtualTexture` per object, and one UV set. Packing several images into one virtual canvas is a build-time job.
- Page coordinates travel through an RGBA8 feedback target, so a level can have at most 256 pages a side (65 536 texels at 256 px tiles).
- No trilinear blend between levels: a level change dissolves over `fadeMs` and is then a hard switch, softened only by the border filtering.
- Meshes that are not attached are hidden during the feedback pass, so geometry occluding a virtual-textured surface does not stop its tiles being requested.
- The feedback readback is synchronous. The target is small, but it still stalls the pipeline on the frames it runs.
- Tiles keep alpha. An image cut out on a transparent background needs a material with `transparent: true` or an `alphaTest`, or the margin draws black.
- On a lost WebGL context three restores the empty atlas, not the tiles; residency should be reset by recreating the `VirtualTexture`.
- The tile format may change before 1.0.

## Development

```
npm ci
npm test            # vitest: page keys, the page table and its fade, the tile scheduler against a hand-driven fetch (ranking by value per byte too), the tools on a generated image
npm run typecheck
npm run build       # dist/
npm run smoke       # headless Chromium through Playwright: the preview on a generated pyramid, tiles resident, level 0 reached, texture visible, detail cap
```

CI runs typecheck, tests and build against three r159, r164 and r169, and the smoke suite once in Chromium, on every push and pull request, and publishes to npm with provenance on a `v*` tag.

## Licence

MIT.
