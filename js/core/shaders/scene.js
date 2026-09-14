import { glsl } from './common.js';

// Attribute slots, fixed by number rather than looked up by name.
//
// Every program that draws world geometry -- the scene pass now, the shadow
// pass next -- reads its vertices out of the same buffers, and a vertex array
// records which slot each buffer feeds. Pinning the slots in the shader source
// means one vertex array per mesh serves every program, instead of one per
// mesh per program.
export const ATTR = { POS: 0, NORMAL: 1, COLOR: 2 };

// The vertex stage stopped deciding what anything looks like.
//
// It used to: the sun, the hemispheric term and the ambient floor were all
// resolved here and handed over as a finished colour. Moving that to the
// fragment stage changes nothing at all on its own, and that is not a
// disappointment -- it is the point. Every triangle in this world carries one
// normal and one colour across all three of its vertices (see MeshData.tri),
// so interpolating them interpolates a constant, and a constant interpolates
// to itself. The old picture survives the move exactly.
//
// What the move buys is everything that cannot be a constant across a face: a
// highlight that slides along the tarmac as the car turns, a headlight that
// falls off with distance, and -- next -- whether this particular point is in
// the sun or in the shade of something else.
export const SCENE_VS = glsl(`
layout(location = ${ATTR.POS}) in vec3 aPos;
layout(location = ${ATTR.NORMAL}) in vec3 aNormal;
layout(location = ${ATTR.COLOR}) in vec3 aColor;
uniform mat4 uProj, uView, uModel;
uniform float uFogNear, uFogFar, uFogScale;
out vec3 vAlbedo;
out vec3 vNormal;
out vec3 vWorld;
out float vFog;
void main(){
  vec4 world = uModel * vec4(aPos, 1.0);
  vec4 vp = uView * world;
  gl_Position = uProj * vp;
  // w = 0 rotates the normal without translating it, which is all a rigid
  // model matrix needs.
  vNormal = (uModel * vec4(aNormal, 0.0)).xyz;
  vWorld = world.xyz;
  vAlbedo = aColor;
  vFog = clamp((-vp.z - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0) * uFogScale;
}`);

export const SCENE_FS = glsl(`
uniform vec3 uLightDir;
uniform vec3 uFogColor;
uniform vec3 uCamPos;
uniform float uAmbient, uLit, uAlpha;
// How much of a sun glint and a headlight highlight this material gets, and
// how tight. Grass and leaves ask for none of it and come out of here looking
// exactly as they always did.
uniform float uSpecular, uShine;
// Two lamps, a real car's width apart, pointed where the car is pointed.
uniform vec3 uHeadPos[2];
uniform vec3 uHeadDir;
uniform float uHeadStrength;

// Two shadow maps, near and far, each holding how close the nearest surface
// is to the sun in its own slice of the world. See Renderer.shadowPass for
// why there are two and how big each one's slice is.
uniform sampler2DShadow uShadowNear, uShadowFar;
uniform mat4 uLightNear, uLightFar;
// One texel of a shadow map, as a fraction of it (for filtering) and as a
// distance in the world (for pushing the lookup off the surface).
uniform float uShadowTexel;
uniform vec2 uShadowWorldTexel;
uniform float uShadowStrength;

in vec3 vAlbedo;
in vec3 vNormal;
in vec3 vWorld;
in float vFog;
out vec4 oColor;

// Where a point sits in one shadow map, in its own 0..1 box.
//
// The lookup is taken from slightly off the surface, along the normal, rather
// than from the surface itself. A shadow map stores one depth per texel, so a
// surface at a glancing angle to the sun covers a whole texel's worth of
// depths with a single number, and comparing itself against that number makes
// it shadow itself in stripes. Pushing the lookup out by about a texel's
// width in the world moves it past its own recorded depth. Along the normal
// rather than along the light, because a surface edge-on to the sun is
// exactly the case that needs it and exactly the case where a push along the
// light goes nowhere.
vec3 shadowCoord(mat4 lightVP, vec3 N, float worldTexel) {
  vec4 p = lightVP * vec4(vWorld + N * worldTexel * 1.6, 1.0);
  return p.xyz * 0.5 + 0.5;
}

// Nine taps in a square. sampler2DShadow compares and filters in hardware, so
// each of these is already a 2x2 average -- nine of them is a soft edge about
// five texels wide, which is what keeps a shadow from looking like a stencil.
float pcf(sampler2DShadow map, vec3 c) {
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      sum += texture(map, vec3(c.xy + vec2(x, y) * uShadowTexel, c.z));
    }
  }
  return sum / 9.0;
}

// 1 in full sun, 0 in full shade.
float sunlight(vec3 N) {
  if (uShadowStrength <= 0.0) return 1.0;
  // The near map first, and the far one only where the near one has run out.
  // The margin keeps the filter from reaching past the edge of the near map,
  // where there is nothing recorded and everything would read as lit.
  vec3 c = shadowCoord(uLightNear, N, uShadowWorldTexel.x);
  if (all(greaterThan(c.xy, vec2(0.03))) && all(lessThan(c.xy, vec2(0.97))) && c.z < 1.0) {
    return mix(1.0, pcf(uShadowNear, c), uShadowStrength);
  }
  c = shadowCoord(uLightFar, N, uShadowWorldTexel.y);
  if (any(lessThan(c.xy, vec2(0.0))) || any(greaterThan(c.xy, vec2(1.0))) || c.z > 1.0) {
    return 1.0;   // beyond both maps: nothing known, so nothing shadowed
  }
  return mix(1.0, pcf(uShadowFar, c), uShadowStrength);
}

// One headlamp: a cone with a soft edge rather than a hard one, so it never
// paints a visible circle on the road, falling off with distance the way a
// light actually does.
vec3 headlamp(vec3 lampPos, vec3 N, vec3 V) {
  vec3 toFrag = vWorld - lampPos;
  float dist = length(toFrag);
  vec3 L = toFrag / max(dist, 0.001);
  // L already points from the lamp out into the scene, the same way uHeadDir
  // does, so the cone is L against uHeadDir and not -L: the cone is about
  // where the light is aimed, not about which way the surface faces it --
  // that part is ndotl, below.
  // A headlight is not a spotlight. The glass scatters, and everything the
  // beam lands on throws some of it back sideways -- which is why the walls
  // of a tunnel are lit at all, and not just the strip of road in front of
  // you. With a hard cone the bore stayed exactly as dark as it was with the
  // lamps off, which was both wrong and duller.
  float cone = 0.14 + 0.86 * smoothstep(0.90, 0.975, dot(L, uHeadDir));
  float atten = cone / (1.0 + 0.02 * dist + 0.004 * dist * dist);
  float ndotl = max(dot(N, -L), 0.0);
  // Slightly warm, the way a filament is, and the way nothing else in this
  // scene is -- which is most of what makes it read as a lamp.
  vec3 tint = vec3(1.0, 0.96, 0.86);
  vec3 diffuse = vAlbedo * tint * ndotl * atten;
  vec3 H = normalize(-L + V);
  float headroom = 1.0 - 0.6 * max(vAlbedo.r, max(vAlbedo.g, vAlbedo.b));
  vec3 spec = tint * pow(max(dot(N, H), 0.0), uShine) * uSpecular * ndotl * atten * headroom;
  return (diffuse + spec) * uHeadStrength;
}

void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);

  // The side of a face that is being looked at.
  //
  // Culling is off, on purpose: the ribbon is driven on from both sides, and
  // inside a loop you see the back of surfaces whose normals point away from
  // you. Which way a mesh builder happened to wind a quad decides that, and
  // for the tunnel bore it decides it differently around the arch. The old
  // per-vertex sun never cared -- a face turned away simply got no sun, which
  // is fine for a sun and wrong for a lamp two metres from the wall. So the
  // new terms light the side facing the camera, and the old ones are left
  // reading the normal exactly as they always did.
  vec3 Nv = dot(N, V) < 0.0 ? -N : N;

  float diff = max(dot(N, uLightDir), 0.0);
  // Whether the sun actually reaches here, or something else got there first.
  // It multiplies the sun and nothing else: the ambient floor and the
  // hemispheric term are the sky and the ground bouncing light around, and
  // those still arrive in shade. A shadow that ate them too would be a black
  // hole rather than a shadow -- and this is exactly the multiplication that
  // could not exist while the sun was resolved per vertex and baked into a
  // single colour.
  float sun = diff > 0.0 ? diff * sunlight(N) : 0.0;
  // Hemispheric ambient: sky above, ground bounce below. Without it the
  // vertical faces of loops and viaducts read as near-black slabs.
  float hemi = 0.5 + 0.5 * N.y;

  // How much light gets here with the sun taken out of the picture: the sky,
  // and the ground throwing some of it back up. This is what a shadow leaves
  // behind, and the sun fills in whatever is left over.
  //
  // The old arrangement added the sun *into* a floor instead of on top of it,
  // and the floor was high -- a surface in full sun and the same surface with
  // the sun completely removed came out 11% apart. That was a reasonable way
  // to light a world with no shadows in it, where the only job was for
  // everything to stay readable. It is a terrible way to light one that has
  // them: there would be nothing for a shadow to do. Same brightness in the
  // sun as before, to within a few percent, and 35% below it in the shade.
  float amb = uAmbient * (0.55 + 0.45 * hemi);
  float lit = amb + (1.0 - amb) * sun;
  vec3 color = mix(vAlbedo, vAlbedo * lit, uLit);

  // Everything below is added on top of the light that was always there,
  // never mixed into it: a material with uSpecular at 0 and no lamp reaching
  // it comes out of here pixel for pixel as it did before any of this existed.
  if (uLit > 0.5) {
    // Viewpoint-dependent, so it travels across the surface as the camera
    // turns -- which is precisely what shading a flat facet can never do.
    vec3 H = normalize(uLightDir + V);
    // Shadowed along with the diffuse it belongs to: a glint that survived
    // into the shade would be the one thing that gave the whole trick away.
    float glint = max(dot(Nv, uLightDir), 0.0) * sunlight(Nv);
    // Weaker on surfaces that are already pale, and that is not a fudge: a
    // highlight is only visible against what is underneath it, and on white
    // paint there is nothing for it to be visible against. Tarmac keeps
    // nearly all of it; the white half of a kerb keeps under half, which is
    // what stops a kerb in full sun from turning into a wall of light.
    float headroom = 1.0 - 0.6 * max(vAlbedo.r, max(vAlbedo.g, vAlbedo.b));
    color += vec3(pow(max(dot(Nv, H), 0.0), uShine) * uSpecular * glint * headroom);
    if (uHeadStrength > 0.0) {
      color += headlamp(uHeadPos[0], Nv, V);
      color += headlamp(uHeadPos[1], Nv, V);
    }
  }

  oColor = vec4(mix(color, uFogColor, vFog), uAlpha);
}`);
