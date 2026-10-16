import * as THREE from "three"
import type AtlasChannel from "./AtlasChannel.js"
import type { ChannelName } from "./AtlasChannel.js"
import { atlasChannelChunk, atlasSharedChunk } from "./shaders.js"

export type PatchableMaterial = THREE.Material & Partial<Record<ChannelName, THREE.Texture | null>>

export interface PatchOptions {
  // The geometry carries an atlasTriUv attribute (see prepareTriangleTint) for per-triangle tint
  triangleTint?: boolean
}

export const triangleUvAttribute = "atlasTriUv"

// Per-triangle tint needs a value that is constant across each triangle: the triangle's
// centroid UV, carried as a flat varying. That needs one vertex per corner, so the geometry
// is made non-indexed (three times the vertices), which is why this is opt-in.
export function prepareTriangleTint(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry
  if (flat.getAttribute(triangleUvAttribute)) return flat
  const uv = flat.getAttribute("uv") as THREE.BufferAttribute | undefined
  if (!uv) throw new Error("Atlas: geometry has no uv attribute")
  const centroids = new Float32Array(uv.count * 2)
  for (let i = 0; i + 2 < uv.count; i += 3) {
    const cu = (uv.getX(i) + uv.getX(i + 1) + uv.getX(i + 2)) / 3
    const cv = (uv.getY(i) + uv.getY(i + 1) + uv.getY(i + 2)) / 3
    for (let k = 0; k < 3; k++) {
      centroids[(i + k) * 2] = cu
      centroids[(i + k) * 2 + 1] = cv
    }
  }
  flat.setAttribute(triangleUvAttribute, new THREE.BufferAttribute(centroids, 2))
  return flat
}

// Where each channel is sampled in three's chunks, and the call to swap for ours
const hooks: Record<ChannelName, { chunk: string; call: string; uv: string }> = {
  map: { chunk: "map_fragment", call: "texture2D( map, vMapUv )", uv: "vMapUv" },
  normalMap: { chunk: "normal_fragment_maps", call: "texture2D( normalMap, vNormalMapUv )", uv: "vNormalMapUv" },
  roughnessMap: { chunk: "roughnessmap_fragment", call: "texture2D( roughnessMap, vRoughnessMapUv )", uv: "vRoughnessMapUv" },
  metalnessMap: { chunk: "metalnessmap_fragment", call: "texture2D( metalnessMap, vMetalnessMapUv )", uv: "vMetalnessMapUv" },
  aoMap: { chunk: "aomap_fragment", call: "texture2D( aoMap, vAoMapUv )", uv: "vAoMapUv" },
  emissiveMap: { chunk: "emissivemap_fragment", call: "texture2D( emissiveMap, vEmissiveMapUv )", uv: "vEmissiveMapUv" },
  specularMap: { chunk: "specularmap_fragment", call: "texture2D( specularMap, vSpecularMapUv )", uv: "vSpecularMapUv" },
}

interface PreviousPatch {
  onBeforeCompile: THREE.Material["onBeforeCompile"]
  customProgramCacheKey: THREE.Material["customProgramCacheKey"] | undefined
}

const previousPatches = new WeakMap<THREE.Material, PreviousPatch>()
// Each attach gets a cache key of its own. three keeps every program a material has used and,
// on returning to one, reuses it without calling onBeforeCompile again or restoring that
// program's uniform set, so a detach followed by an attach would render the atlas program with
// the bare material's uniforms: samplers bound to whatever was last on the unit.
let generation = 0

// Reroutes a built-in material's texture slots through the virtual texture channels. Each
// channel's cache is assigned to its slot so three defines USE_* and the UV varying; the
// chunk that samples it is expanded and its texture2D call replaced with the atlas lookup.
// Any patch already on the material runs first and stays.
export function applyVirtualTexture(
  material: PatchableMaterial,
  channels: Iterable<AtlasChannel>,
  sharedUniforms: Record<string, THREE.IUniform>,
  { triangleTint = false }: PatchOptions = {}
): void {
  const list = [...channels]
  for (const channel of list) material[channel.name] = channel.cache.texture

  const ownKey = Object.prototype.hasOwnProperty.call(material, "customProgramCacheKey")
  const previous: PreviousPatch = {
    onBeforeCompile: material.onBeforeCompile,
    customProgramCacheKey: ownKey ? material.customProgramCacheKey : undefined,
  }
  previousPatches.set(material, previous)
  const previousKey = previous.customProgramCacheKey ?? (() => "")

  material.onBeforeCompile = (shader, renderer) => {
    previous.onBeforeCompile.call(material, shader, renderer)
    Object.assign(shader.uniforms, sharedUniforms)
    for (const channel of list) Object.assign(shader.uniforms, channel.uniforms)

    const define = triangleTint ? "#define ATLAS_TRI_TINT\n" : ""
    if (triangleTint) {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\n${define}attribute vec2 ${triangleUvAttribute};\nflat varying vec2 vAtlasTriUv;`
        )
        .replace("#include <uv_vertex>", `#include <uv_vertex>\nvAtlasTriUv = ${triangleUvAttribute};`)
    }

    const header = [define + atlasSharedChunk, ...list.map((c) => atlasChannelChunk(c.name, c.name === "map"))].join("\n")
    let fragment = shader.fragmentShader.replace("#include <common>", `#include <common>\n${header}`)

    for (const channel of list) {
      const hook = hooks[channel.name]
      const include = `#include <${hook.chunk}>`
      if (!fragment.includes(include)) continue
      const expanded = THREE.ShaderChunk[hook.chunk].split(hook.call).join(`atlasSample_${channel.name}( ${hook.uv} )`)
      fragment = fragment.replace(include, expanded)
    }
    shader.fragmentShader = fragment
  }
  const key = `atlas:${list.map((c) => c.name).join(",")}${triangleTint ? ":tri" : ""}#${++generation}`
  material.customProgramCacheKey = () => `${previousKey.call(material)}|${key}`
  material.needsUpdate = true
}

export function removeVirtualTexture(material: PatchableMaterial, channels: Iterable<AtlasChannel>): void {
  for (const channel of channels) material[channel.name] = null
  const previous = previousPatches.get(material)
  previousPatches.delete(material)
  material.onBeforeCompile = previous?.onBeforeCompile ?? (() => {})
  if (previous?.customProgramCacheKey) {
    material.customProgramCacheKey = previous.customProgramCacheKey
  } else {
    delete (material as Partial<THREE.Material>).customProgramCacheKey
  }
  material.needsUpdate = true
}
