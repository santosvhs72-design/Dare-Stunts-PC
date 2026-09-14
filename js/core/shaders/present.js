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

// The last pass: the scene plus its own glow, onto the canvas.
export const PRESENT_FS = glsl(`
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uKnee;
in vec2 vUv;
out vec4 oColor;

// Highlight rolloff, per channel.
//
// Deliberately not a film curve. A proper tone map would touch every colour in
// the picture, and every colour in this picture was chosen by hand for a game
// that has looked the way it looks for three versions -- re-grading all of it
// is not what this is for. Below the knee this is the identity function, to
// the bit: the tarmac, the grass and the sky come through untouched. Above it,
// values are pulled in towards 1 and never reach it, so a headlight two and a
// half times brighter than white still has somewhere to go instead of
// flattening into a white shape with a hard edge.
float roll(float x) {
  if (x <= uKnee) return x;
  float t = (x - uKnee) / (1.0 - uKnee);
  return uKnee + (1.0 - uKnee) * (t / (1.0 + t));
}

void main(){
  vec3 c = texture(uScene, vUv).rgb;
  c += texture(uBloom, vUv).rgb * uBloomStrength;
  oColor = vec4(roll(c.r), roll(c.g), roll(c.b), 1.0);
}`);
