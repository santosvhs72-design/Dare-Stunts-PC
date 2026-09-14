import { glsl } from './common.js';
import { ATTR } from './scene.js';

// The world as the sun sees it. Position only -- the pass writes nothing but
// depth, so the normal and the colour are along for the ride and never read.
// They stay bound anyway: the vertex array a mesh was uploaded with feeds all
// three slots, and rebinding them per pass would cost more than ignoring them.
export const SHADOW_VS = glsl(`
layout(location = ${ATTR.POS}) in vec3 aPos;
uniform mat4 uLightVP, uModel;
void main(){
  gl_Position = uLightVP * (uModel * vec4(aPos, 1.0));
}`);

// Nothing. There is no colour attachment to write to, and depth is written
// whether a fragment shader asks for it or not.
export const SHADOW_FS = glsl(`
void main(){}`);
