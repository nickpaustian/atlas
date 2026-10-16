import * as THREE from "three"
import { pageKey, pagesAtLevel, type PageKey, type TileManifest } from "./TileSource.js"
import { feedbackFragmentShader, feedbackVertexShader } from "./shaders.js"

export interface FeedbackPassOptions {
  // Feedback is rendered at 1/scale of the viewport in each axis
  scale?: number
}

export interface PageCoverage {
  // Feedback pixels the page covered
  pixels: number
  // Mean screen position of those pixels, -1..1 with 0 at the centre
  x: number
  y: number
}

// Renders the registered meshes at low resolution with a shader that outputs the page each
// pixel wants, reads the result back and decodes it into a set of page keys.
export default class FeedbackPass {
  public readonly target: THREE.WebGLRenderTarget
  public readonly material: THREE.ShaderMaterial
  public scale: number

  private buffer: Uint8Array = new Uint8Array(0)
  private width: number = 1
  private height: number = 1
  // Wanted pages with how much of the screen each covered and where
  private requested: Map<PageKey, PageCoverage> = new Map()
  private manifest: TileManifest

  constructor(
    manifest: TileManifest,
    uniforms: Record<string, THREE.IUniform>,
    { scale = 8 }: FeedbackPassOptions = {}
  ) {
    this.manifest = manifest
    this.scale = scale
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    })

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        atlasVirtualSize: uniforms.atlasVirtualSize,
        atlasPageGrid: uniforms.atlasPageGrid,
        atlasMaxLevel: uniforms.atlasMaxLevel,
        atlasFlipV: uniforms.atlasFlipV,
        // Derivatives are `scale` times larger at the feedback resolution, so pull the lod back
        atlasLodBias: { value: (uniforms.atlasLodBias.value as number) - Math.log2(scale) },
      },
      vertexShader: feedbackVertexShader,
      fragmentShader: feedbackFragmentShader,
      side: THREE.DoubleSide,
    })
  }

  public setLodBias(bias: number): void {
    this.material.uniforms.atlasLodBias.value = bias - Math.log2(this.scale)
  }

  public setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width / this.scale))
    const h = Math.max(1, Math.round(height / this.scale))
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.target.setSize(w, h)
    this.buffer = new Uint8Array(w * h * 4)
  }

  // Swaps the meshes' materials for the feedback material, renders them alone, restores
  public render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    meshes: Iterable<THREE.Mesh>
  ): Map<PageKey, PageCoverage> {
    const size = renderer.getSize(new THREE.Vector2())
    this.setSize(size.x, size.y)

    const swapped: Array<{ mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }> = []
    const hidden: THREE.Object3D[] = []
    const members = new Set<THREE.Mesh>(meshes)

    for (const mesh of members) {
      swapped.push({ mesh, material: mesh.material })
      mesh.material = this.material
    }
    // Anything else that draws (lines, points, sprites, other meshes) would be decoded as pages
    scene.traverse((object) => {
      if (isRenderable(object) && !members.has(object as THREE.Mesh) && object.visible) {
        object.visible = false
        hidden.push(object)
      }
    })
    const previousBackground = scene.background
    const previousEnvironment = scene.environment
    scene.background = null
    scene.environment = null

    const previousTarget = renderer.getRenderTarget()
    const previousClear = renderer.getClearColor(new THREE.Color())
    const previousAlpha = renderer.getClearAlpha()
    const previousAutoClear = renderer.autoClear

    renderer.setRenderTarget(this.target)
    renderer.setClearColor(0x000000, 0)
    renderer.autoClear = true
    renderer.clear()
    renderer.render(scene, camera)
    renderer.readRenderTargetPixels(this.target, 0, 0, this.width, this.height, this.buffer)

    renderer.setRenderTarget(previousTarget)
    renderer.setClearColor(previousClear, previousAlpha)
    renderer.autoClear = previousAutoClear

    for (const { mesh, material } of swapped) mesh.material = material
    for (const object of hidden) object.visible = true
    scene.background = previousBackground
    scene.environment = previousEnvironment

    return this.decode()
  }

  private decode(): Map<PageKey, PageCoverage> {
    this.requested.clear()
    const buffer = this.buffer
    const maxLevel = this.manifest.levels - 1
    const { width, height } = this
    for (let i = 0; i < buffer.length; i += 4) {
      if (buffer[i + 3] !== 255) continue
      const level = buffer[i + 2]
      if (level > maxLevel) continue
      const { cols, rows } = pagesAtLevel(this.manifest, level)
      const x = buffer[i]
      const y = buffer[i + 1]
      if (x >= cols || y >= rows) continue
      const key = pageKey(level, x, y)
      const pixel = i / 4
      const sx = ((pixel % width) + 0.5) / width * 2 - 1
      const sy = (Math.floor(pixel / width) + 0.5) / height * 2 - 1
      const entry = this.requested.get(key)
      if (entry) {
        entry.x += sx
        entry.y += sy
        entry.pixels++
      } else {
        this.requested.set(key, { pixels: 1, x: sx, y: sy })
      }
    }
    for (const entry of this.requested.values()) {
      entry.x /= entry.pixels
      entry.y /= entry.pixels
    }
    return this.requested
  }

  public dispose(): void {
    this.target.dispose()
    this.material.dispose()
  }
}

const isRenderable = (object: THREE.Object3D): boolean => {
  const o = object as THREE.Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean }
  return Boolean(o.isMesh || o.isLine || o.isPoints || o.isSprite)
}
