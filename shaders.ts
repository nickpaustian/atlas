import type { ChannelName } from "./AtlasChannel.js"

// Shared GLSL. Virtual UVs follow three.js (v = 0 at the bottom) unless atlasFlipV is 0;
// page rows and the atlas are stored top-down, so lookups flip v once and stay top-down.

export const atlasSharedChunk = /* glsl */ `
uniform vec2 atlasVirtualSize;   // reference texels at level 0
uniform vec2 atlasPageGrid;      // reference pages at level 0
uniform float atlasMaxLevel;     // reference
uniform float atlasLodBias;
uniform float atlasFlipV;        // 1 when v = 0 is the image bottom (three), 0 when it is the top (glTF)
uniform float atlasDebugTint;    // 1 tints the map channel per pixel, 2 per triangle, by the level drawn from

// Centroid UV of the triangle, constant across it (see prepareTriangleTint)
#ifdef ATLAS_TRI_TINT
flat varying vec2 vAtlasTriUv;
#endif

float atlasLod( vec2 uv ) {
  vec2 p = uv * atlasVirtualSize;
  vec2 dx = dFdx( p );
  vec2 dy = dFdy( p );
  return 0.5 * log2( max( dot( dx, dx ), dot( dy, dy ) ) ) + atlasLodBias;
}

// 0 = finest level (green) through to 1 = coarsest (red); matches levelColor() in JS
vec3 atlasLevelColor( float t ) {
  t = clamp( t, 0.0, 1.0 );
  return vec3( min( 1.0, t * 2.0 ), min( 1.0, ( 1.0 - t ) * 2.0 ), 0.0 );
}

// The texel of the cache slot a page table entry names, at the page's own level
vec4 atlasSlotTexel( sampler2D cache, vec2 grid, vec4 cacheParams, vec4 entry, vec2 uvTop ) {
  float residentLevel = entry.b * 255.0;
  vec2 slot = entry.rg * 255.0;
  vec2 pages = max( floor( grid / exp2( residentLevel ) ), vec2( 1.0 ) );
  vec2 inPage = fract( uvTop * pages );
  vec2 texel = slot * cacheParams.x + cacheParams.y + inPage * cacheParams.z;
  return texture2D( cache, texel / cacheParams.w );
}

// Looks a channel up at a page level: page table entry, then the slot it names in the cache.
// A page still fading in (alpha below 1) is blended with the coarser page it replaced, which
// the table one level above the resident one still names.
vec4 atlasFetch( sampler2D pageTable, sampler2D cache, vec2 grid, vec4 cacheParams, vec4 fallback, float level, float maxLevel, vec2 uv, float tintMaxLevel ) {
  vec2 uvTop = vec2( uv.x, mix( uv.y, 1.0 - uv.y, atlasFlipV ) );
  vec4 entry = texture2DLodEXT( pageTable, uvTop, level );
  if ( entry.a <= 0.0 ) return fallback;

  float residentLevel = entry.b * 255.0;
  vec4 color = atlasSlotTexel( cache, grid, cacheParams, entry, uvTop );
  if ( entry.a < 1.0 && residentLevel < maxLevel ) {
    vec4 previous = texture2DLodEXT( pageTable, uvTop, residentLevel + 1.0 );
    if ( previous.a > 0.0 ) color = mix( atlasSlotTexel( cache, grid, cacheParams, previous, uvTop ), color, entry.a );
  }
  if ( tintMaxLevel >= 0.0 && atlasDebugTint > 0.5 ) {
    float shown = residentLevel;
    #ifdef ATLAS_TRI_TINT
    if ( atlasDebugTint > 1.5 ) {
      vec2 triTop = vec2( vAtlasTriUv.x, mix( vAtlasTriUv.y, 1.0 - vAtlasTriUv.y, atlasFlipV ) );
      shown = texture2DLodEXT( pageTable, triTop, level ).b * 255.0;
    }
    #endif
    float luma = dot( color.rgb, vec3( 0.299, 0.587, 0.114 ) );
    color.rgb = mix( vec3( luma ), atlasLevelColor( shown / max( tintMaxLevel, 1.0 ) ), 0.7 );
  }
  return color;
}
`

// Uniforms and sampler for one channel. params = (maxLevel, minLevel, offset, unused).
export const atlasChannelChunk = (name: ChannelName, tinted: boolean): string => /* glsl */ `
uniform sampler2D atlas_${name}_cache;
uniform sampler2D atlas_${name}_pageTable;
uniform vec2 atlas_${name}_grid;
uniform vec4 atlas_${name}_params;
uniform vec4 atlas_${name}_cacheParams;
uniform vec4 atlas_${name}_fallback;

vec4 atlasSample_${name}( vec2 uv ) {
  float level = clamp( floor( atlasLod( uv ) ) - atlas_${name}_params.z, atlas_${name}_params.y, atlas_${name}_params.x );
  return atlasFetch(
    atlas_${name}_pageTable, atlas_${name}_cache, atlas_${name}_grid, atlas_${name}_cacheParams, atlas_${name}_fallback,
    level, atlas_${name}_params.x, uv, ${tinted ? `atlas_${name}_params.x` : "-1.0"}
  );
}
`

export const feedbackVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`

// Writes the reference page each pixel wants: r = page x, g = page y, b = level, a = 1
export const feedbackFragmentShader = /* glsl */ `
uniform vec2 atlasVirtualSize;
uniform vec2 atlasPageGrid;
uniform float atlasMaxLevel;
uniform float atlasLodBias;
uniform float atlasFlipV;
varying vec2 vUv;

float atlasLod( vec2 uv ) {
  vec2 p = uv * atlasVirtualSize;
  vec2 dx = dFdx( p );
  vec2 dy = dFdy( p );
  return 0.5 * log2( max( dot( dx, dx ), dot( dy, dy ) ) ) + atlasLodBias;
}

void main() {
  float level = clamp( floor( atlasLod( vUv ) ), 0.0, atlasMaxLevel );
  vec2 pages = max( floor( atlasPageGrid / exp2( level ) ), vec2( 1.0 ) );
  vec2 page = floor( vec2( vUv.x, mix( vUv.y, 1.0 - vUv.y, atlasFlipV ) ) * pages );
  gl_FragColor = vec4( page / 255.0, level / 255.0, 1.0 );
}
`
