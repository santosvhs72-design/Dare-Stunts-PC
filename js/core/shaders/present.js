import { glsl } from './common.js';

// The vertex shader for every full-screen pass. No attributes and no buffer:
// three vertices whose positions come out of gl_VertexID and cover the screen
// with room to spare.
export const SCREEN_VS = glsl(`
out vec2 vUv;
void main(){
  vUv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
}`);

// The last pass: what the off-screen buffer holds, onto the canvas.
//
// A straight copy, for now. It is the whole point of this commit that it is a
// straight copy -- the picture leaving here has to be the picture the old
// single-pass renderer drew, or something in the new plumbing is wrong and it
// is better to find that out now than underneath a tone map. The tone map,
// the bloom and the anti-aliasing all land here later.
export const PRESENT_FS = glsl(`
uniform sampler2D uScene;
in vec2 vUv;
out vec4 oColor;
void main(){
  oColor = vec4(texture(uScene, vUv).rgb, 1.0);
}`);
