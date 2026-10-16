#!/usr/bin/env node
// Serves a tile pyramid (and sibling channel pyramids) together with this package's dist and
// the host project's three, and opens a viewer page: a plane the shape of the image, stats,
// debug tint and the atlas overlay on keys.
//
//   atlas preview <dir> [--normalMap dir] [--roughnessMap dir] [--aoMap dir] ... [--port 4181] [--no-open] [--atlasSize 4096]
//
// Sibling folders named <dir>-<channel> are picked up without flags.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { serve, parseArgs } from "./serve.mjs"

const channelNames = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "specularMap"]
const { positional, option, flag } = parseArgs(process.argv.slice(2))
const [dir] = positional
const fail = (message) => {
  console.error(`preview: ${message}`)
  process.exit(1)
}
if (!dir) fail("usage: atlas preview <dir> [--<channel> dir]... [--port 4181] [--no-open] [--atlasSize 4096]")
if (!existsSync(join(dir, "manifest.json"))) fail(`${dir} has no manifest.json`)

const channels = { map: dir }
for (const name of channelNames.slice(1)) {
  const given = option(name, null)
  const candidate = given ?? `${dir.replace(/\/$/, "")}-${name}`
  if (existsSync(join(candidate, "manifest.json"))) channels[name] = candidate
  else if (given) fail(`${given} has no manifest.json`)
}

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, "..", "dist")
if (!existsSync(join(dist, "index.js"))) fail(`${dist} has no build; run "npm run build" in the package first`)
// three's exports map hides its package.json, so resolve the entry point and walk up to the folder
let threeDir
try {
  threeDir = dirname(createRequire(import.meta.url).resolve("three"))
  while (!existsSync(join(threeDir, "package.json")) || JSON.parse(readFileSync(join(threeDir, "package.json"), "utf8")).name !== "three") {
    const parent = dirname(threeDir)
    if (parent === threeDir) throw new Error("no package root")
    threeDir = parent
  }
} catch {
  fail("three is not installed next to this package")
}

const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Atlas preview: ${dir}</title>
<style>
  html, body { margin: 0; height: 100%; background: #1c1c1e; overflow: hidden; }
  canvas { display: block; }
  #hud, #help { position: fixed; left: 12px; padding: 10px 12px; background: rgba(0,0,0,.72); color: #fff;
    font: 12px/1.5 ui-monospace, Menlo, monospace; border-radius: 6px; white-space: pre; pointer-events: none; }
  #hud { top: 12px; }
  #help { bottom: 12px; display: none; }
  #hint { position: fixed; right: 12px; bottom: 12px; color: #fff; background: rgba(0,0,0,.72); padding: 8px 12px;
    border-radius: 6px; font: 12px ui-monospace, Menlo, monospace; }
</style>
<script type="importmap">
{ "imports": { "three": "/three/build/three.module.js", "three/addons/": "/three/examples/jsm/", "@nickpaustian/atlas": "/dist/index.js" } }
</script>
</head>
<body>
<div id="hud">loading…</div>
<div id="help">H  this help
T  debug tint: off / per pixel / per triangle
D  atlas overlay
, .  detail cap down / up
- =  lod bias down / up</div>
<div id="hint">H help</div>
<script type="module">
import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { VirtualTexture, loadTileSource, AtlasDebugOverlay } from "@nickpaustian/atlas"

const channelNames = ${JSON.stringify(Object.keys(channels))}
const params = new URLSearchParams(location.search)
const hud = document.getElementById("hud")
const help = document.getElementById("help")
const hint = document.getElementById("hint")

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(window.devicePixelRatio)
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1c1c1e)
scene.add(new THREE.GridHelper(40, 40, 0x3a3a3c, 0x2c2c2e).translateY(-1.2))
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2))
const key = new THREE.DirectionalLight(0xffffff, 1.5)
key.position.set(2, 3, 4)
scene.add(key)

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100)
camera.position.set(0, 0, 3)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.minDistance = 0.02
controls.maxDistance = 20

const channels = {}
await Promise.all(channelNames.map(async (name) => { channels[name] = await loadTileSource("/asset/" + name) }))
const vt = new VirtualTexture({ channels, flipV: true, atlasSize: Number(params.get("atlasSize")) || ${Number(option("atlasSize", 4096))} })
window.atlas = vt
window.atlasPreview = { renderer, scene, camera, controls, THREE }
const { manifest } = vt

// A flat plane trimmed to the real image inside the padded virtual texture
const aspect = manifest.contentHeight / manifest.contentWidth
const geometry = new THREE.PlaneGeometry(2, 2 * aspect)
const { u0, v0, u1, v1 } = vt.contentUvRect
const uv = geometry.attributes.uv
for (let i = 0; i < uv.count; i++) uv.setXY(i, THREE.MathUtils.lerp(u0, u1, uv.getX(i)), THREE.MathUtils.lerp(v0, v1, uv.getY(i)))
const lit = channelNames.length > 1
const mesh = new THREE.Mesh(geometry, lit ? new THREE.MeshStandardMaterial({ transparent: true, roughness: 0.75, metalness: 0 }) : new THREE.MeshBasicMaterial({ transparent: true }))
vt.attach(mesh, { triangleTint: true })
scene.add(mesh)
const overlay = new AtlasDebugOverlay(vt)

window.addEventListener("keydown", (event) => {
  switch (event.code) {
    case "KeyH": { const open = help.style.display === "block"; help.style.display = open ? "" : "block"; hint.style.display = open ? "" : "none"; break }
    case "KeyT": vt.cycleDebugTint(); break
    case "KeyD": overlay.toggle(); break
    case "Comma": vt.detailCap = Math.max(0, vt.detailCap - 1); break
    case "Period": vt.detailCap = Math.min(manifest.levels - 1, vt.detailCap + 1); break
    case "Minus": vt.lodBias = Math.max(-4, vt.lodBias - 0.5); break
    case "Equal": vt.lodBias = Math.min(4, vt.lodBias + 0.5); break
  }
})
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

let frames = 0, lastFps = performance.now(), fps = 0
const render = () => {
  requestAnimationFrame(render)
  controls.update()
  vt.update(renderer, scene, camera)
  renderer.render(scene, camera)
  overlay.update()
  frames++
  const now = performance.now()
  if (now - lastFps > 500) { fps = Math.round((frames * 1000) / (now - lastFps)); frames = 0; lastFps = now }
  const s = vt.stats
  hud.textContent = [
    \`${dir}  \${manifest.width}x\${manifest.height}  \${manifest.cols}x\${manifest.rows} pages  \${manifest.levels} levels\`,
    \`channels \${s.channels.map((c) => \`\${c.name} \${c.resident}/\${c.capacity}\`).join("  ")}\`,
    \`wanted \${s.requested}  queued \${s.network.queued}  in flight \${s.network.inFlight}  done \${s.network.completed}  aborted \${s.network.aborted}  failed \${s.network.failures}  \${(s.network.bytes / 1048576).toFixed(1)} MB\`,
    \`uploads \${s.uploads}  detail cap \${s.detailCap}  lod bias \${vt.lodBias.toFixed(1)}  tint \${["off", "pixel", "triangle"][vt.debugTint]}  \${(s.memoryBytes / 1048576).toFixed(0)} MB on GPU\`,
    \`\${fps} fps  distance \${camera.position.length().toFixed(3)}\`,
  ].join("\\n")
}
render()
</script>
</body>
</html>`

await serve({
  mounts: [
    ...Object.entries(channels).map(([name, folder]) => ({ prefix: `/asset/${name}`, dir: folder })),
    { prefix: "/dist", dir: dist },
    { prefix: "/three", dir: threeDir },
  ],
  pages: { "/": page },
  port: Number(option("port", 4181)),
  open: !flag("no-open"),
}).catch((error) => fail(error.message))
