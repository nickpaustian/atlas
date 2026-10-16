# Atlas tile pyramid format

The layouts the build tools write and the runtimes read. The pyramid carries a version field that the loader checks, and it may change before 1.0.

All multi-byte values are little-endian. "Word" means a 32-bit unsigned integer unless marked `f32`.

## Format 1

A folder holding `manifest.json` and one sub-folder per level, `0` being the finest. Each level holds `{x}_{y}.{format}` tiles.

### manifest.json

| field | meaning |
| --- | --- |
| `version` | 1. Absent on pyramids built before the field existed, which are read as 1 |
| `build` | per-build token; the runtime appends it to each tile URL as `?v=<build>` |
| `width`, `height` | the padded virtual texture in texels, `cols × tileSize` by `rows × tileSize` |
| `contentWidth`, `contentHeight` | the real image inside the padding, anchored top-left |
| `tileSize` | content texels per tile side, 256 by default |
| `border` | edge texels replicated around each tile, 4 by default |
| `cols`, `rows` | pages at level 0, each a power of two |
| `levels` | `log2(max(cols, rows)) + 1`; the last level is a single page |
| `format` | the image extension and encoding: `webp`, `png`, `jpg` or `avif` |

### Tiles

A tile image is `tileSize + 2·border` texels square: the page's content with `border` texels of its neighbours (or replicated edge texels at the image boundary) on every side, so bilinear filtering inside a page never reads another page's texels. Level `n` is the padded image downscaled by `2^n` and cut the same way. The page grid is at most 256 pages a side, since the feedback pass carries page coordinates in 8 bits each.

The sibling Theia hierarchy format is documented in [the Theia repository](https://github.com/nickpaustian/theia/blob/main/docs/formats.md).
