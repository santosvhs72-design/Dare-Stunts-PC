import { glsl } from './common.js';

// What is brighter than the picture can show, on its own, at a quarter of the
// size. Headlight pools, the tunnel's strip lights, the glint on the tarmac --
// everything the half-float buffer has been quietly holding above 1 since the
// lamps were lit, and which the screen would otherwise just clip flat.
//
// The threshold has a soft knee rather than a hard edge: with a hard one, a
// surface drifting across the line as the car turns pops in and out of
// glowing, and the eye catches that immediately.
export const BRIGHT_FS = glsl(`
uniform sampler2D uScene;
uniform float uThreshold, uKnee;
in vec2 vUv;
out vec4 oColor;
void main(){
  vec3 c = texture(uScene, vUv).rgb;
  float b = max(c.r, max(c.g, c.b));
  float w = clamp((b - uThreshold) / max(uKnee, 0.001), 0.0, 1.0);
  oColor = vec4(c * w * w, 1.0);
}`);

// One half of a separable blur -- run twice, across and then down, which costs
// two passes of nine taps instead of one pass of eighty-one.
//
// The taps sit halfway between texel centres so the bilinear filter averages
// two of them for free: nine samples covering seventeen texels.
export const BLUR_FS = glsl(`
uniform sampler2D uSource;
uniform vec2 uDirection;      // one texel across, in the direction being blurred
in vec2 vUv;
out vec4 oColor;
const float W[5] = float[5](0.2270270, 0.1945946, 0.1216216, 0.0540540, 0.0162162);
void main(){
  vec3 sum = texture(uSource, vUv).rgb * W[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDirection * (float(i) * 2.0 - 0.5);
    sum += texture(uSource, vUv + o).rgb * W[i];
    sum += texture(uSource, vUv - o).rgb * W[i];
  }
  oColor = vec4(sum, 1.0);
}`);
