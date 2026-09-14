import { glsl } from './common.js';

// Attribute slots, fixed by number rather than looked up by name.
//
// Every program that draws world geometry -- the scene pass now, the shadow
// pass next -- reads its vertices out of the same buffers, and a vertex array
// records which slot each buffer feeds. Pinning the slots in the shader source
// means one vertex array per mesh serves every program, instead of one per
// mesh per program.
export const ATTR = { POS: 0, NORMAL: 1, COLOR: 2 };

// The world, lit exactly the way the television version lights it: one flat
// ambient floor, one hemispheric term, one directional sun, all resolved per
// vertex and baked into vColor before the fragment stage ever sees it.
//
// That is deliberate for now. This pass exists to prove the new pipeline --
// WebGL 2, an off-screen buffer, a resolve, a composite -- puts the same
// picture on the screen the old single pass did. Changing how it looks at the
// same time would leave no way to tell an infrastructure bug from an intended
// difference. The lighting is the next commit's job.
export const SCENE_VS = glsl(`
layout(location = ${ATTR.POS}) in vec3 aPos;
layout(location = ${ATTR.NORMAL}) in vec3 aNormal;
layout(location = ${ATTR.COLOR}) in vec3 aColor;
uniform mat4 uProj, uView, uModel;
uniform vec3 uLightDir;
uniform float uAmbient, uLit, uFogNear, uFogFar, uFogScale;
out vec3 vColor;
out float vFog;
void main(){
  vec4 vp = uView * (uModel * vec4(aPos, 1.0));
  gl_Position = uProj * vp;
  // w = 0 rotates the normal without translating it, which is all a rigid
  // model matrix needs.
  vec3 n = normalize((uModel * vec4(aNormal, 0.0)).xyz);
  float diff = max(dot(n, uLightDir), 0.0);
  // Hemispheric ambient: sky above, ground bounce below. Without it the
  // vertical faces of loops and viaducts read as near-black slabs.
  float hemi = 0.5 + 0.5 * n.y;
  // uAmbient is a brightness floor, not a mix weight: the inside of a loop
  // faces away from the sun, and it still has to be readable to drive through.
  float lit = uAmbient + (1.0 - uAmbient) * (0.45 * hemi + 0.55 * diff);
  vColor = mix(aColor, aColor * lit, uLit);
  vFog = clamp((-vp.z - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0) * uFogScale;
}`);

export const SCENE_FS = glsl(`
uniform vec3 uFogColor;
uniform float uAlpha;
in vec3 vColor;
in float vFog;
out vec4 oColor;
void main(){
  oColor = vec4(mix(vColor, uFogColor, vFog), uAlpha);
}`);
