#!/usr/bin/env node
const commands = {
  tiles: ["./build-tiles.mjs", "tiles <image> <outDir> [options]        cut an image into a tile pyramid"],
  "test-texture": ["./make-test-texture.mjs", "test-texture <out.png> [options]       draw a diagnostic texture"],
  inspect: ["./inspect.mjs", "inspect <dir>                          check a tile pyramid and summarise it per level"],
  preview: ["./preview.mjs", "preview <dir> [--port N] [--no-open]    serve a tile pyramid and view it in the browser"],
}
const command = process.argv.splice(2, 1)[0]
if (!commands[command]) {
  console.error(`usage: atlas <command> [arguments]\n\n${Object.values(commands).map(([, help]) => "  " + help).join("\n")}`)
  process.exit(command === undefined || command === "--help" || command === "-h" ? 0 : 1)
}
await import(commands[command][0])
