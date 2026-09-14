import { mat4, v3, quat, frustumPlanes, sphereVisible } from './math.js';
import { hex } from './mesh.js';
import { program, Target, screenPass, shadowTarget } from './gl.js';
import { ATTR, SCENE_VS, SCENE_FS } from './shaders/scene.js';
import { SHADOW_VS, SHADOW_FS } from './shaders/shadow.js';
import { SCREEN_VS, PRESENT_FS } from './shaders/present.js';
import { BRIGHT_FS, BLUR_FS } from './shaders/post.js';

// Default until a track sets its own (see Game.load and the sky presets in
// world/scenery.js) -- day, the same horizon the sky always used.
const DEFAULT_FOG = hex('#aac6e2');

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// Multisampling, on the off-screen buffer rather than on the canvas.
//
// The television version asked for `antialias: true` and let the browser
// multisample the canvas itself, which a browser will only do for the picture
// it shows directly. The moment a frame is built in stages -- and it has to
// be, for a shadow map to exist -- that picture is a texture, and the browser
// does nothing for it. So the samples are asked for explicitly here, and
// resolved by hand afterwards.
const SAMPLES = 4;

// Where the lamps sit relative to whatever is carrying them, in its own frame:
// out to the sides, forward of the driver, and below eye level. In the
// cockpit view there is no car body to measure from -- the camera is the
// driver's head -- so these are measured from there, which puts them roughly
// where a real pair would be on the car you cannot see.
const HEAD_SIDE = 0.62;     // m, either side of centre
const HEAD_FWD = 1.7;       // m, ahead
const HEAD_DOWN = 0.62;     // m, below the eyes
const HEAD_DIP = 0.05;      // rad, aimed down: dipped beams, not full
// How bright the pool gets at its centre, before the cone and the falloff take
// anything away. Over 1 on purpose -- a headlight blows out what is directly
// in front of it, and the buffer this lands in is now wide enough to hold
// that until there is a tone map to bring it back down.
const HEAD_STRENGTH = 1.5;

// Shadows.
//
// A track is up to 3.3 km across. One shadow map over the whole of it, even at
// 2048 texels a side, gives a texel a metre and a half wide -- which is not a
// shadow, it is a rumour of one. So there are two, both centred on the car and
// redrawn every frame: a small one that carries the shadows you are driving
// through, and a big one for everything from there to the fog.
//
// The radii are chosen against what the game actually shows. The near one has
// to comfortably cover a loop (about 40 m tall) and the trees beside the road;
// the far one has to reach the fog, which starts closing at 150 m and is total
// by 460. Nothing past that is ever seen.
const SHADOW_SIZE = 2048;
const SHADOW_RADIUS = [80, 300];      // m, half-width of each slab
// Pushed forward along the view, because the half of a circle behind the car
// is the half nobody is looking at.
const SHADOW_AHEAD = [0.45, 0.55];
// How far above and below the slab the sun still looks for casters: a viaduct
// 40 m up has to be found from underneath it, and a hill 120 m away has to be
// found at all.
const SHADOW_DEPTH = 260;
// How dark a full shadow gets. Not 1: a real shadow outdoors is lit by the
// whole sky, and the ambient term here is a crude stand-in for that -- taking
// the sun away entirely made the underside of every viaduct read as a hole.
const SHADOW_STRENGTH = 0.88;

// Glow.
//
// At a quarter of the width and height, which is a sixteenth of the pixels:
// the whole point of a bloom is that it is blurred, so there is nothing in it
// that survives being computed small. Anything past the threshold is already
// brighter than the screen can show and is going to be pulled back towards 1
// by the rolloff anyway -- the glow is what is left of it.
const BLOOM_SCALE = 4;
const BLOOM_THRESHOLD = 0.82;
const BLOOM_KNEE = 0.45;
const BLOOM_STRENGTH = 0.55;
// Where the highlight rolloff starts. Below this the picture is passed through
// untouched, which is most of it.
const ROLLOFF_KNEE = 0.78;

export class Renderer {
  constructor(canvas) {
    // No depth and no antialias on the canvas itself: it never receives
    // anything but one full-screen quad, already finished.
    const gl = canvas.getContext('webgl2', { alpha: false, depth: false, antialias: false });
    if (!gl) {
      throw new Error('WebGL 2 não disponível neste browser.');
    }
    this.gl = gl;
    this.canvas = canvas;

    this.scene = program(gl, SCENE_VS, SCENE_FS, 'cena');
    this.shadow = program(gl, SHADOW_VS, SHADOW_FS, 'sombras');
    this.bright = program(gl, SCREEN_VS, BRIGHT_FS, 'realces');
    this.blur = program(gl, SCREEN_VS, BLUR_FS, 'desfoque');
    this.present = program(gl, SCREEN_VS, PRESENT_FS, 'apresentação');
    this.screen = screenPass(gl);

    this.shadowMaps = SHADOW_RADIUS.map(() => shadowTarget(gl, SHADOW_SIZE));
    this.lightVP = SHADOW_RADIUS.map(() => mat4.identity());
    this.shadowWorldTexel = new Float32Array(
      SHADOW_RADIUS.map(r => 2 * r / SHADOW_SIZE));

    // Where the world is drawn, and where it lands once the samples are
    // averaged down. Sized in resize().
    this.hdr = new Target(gl, { samples: SAMPLES, hdr: true, depth: true });
    this.resolved = new Target(gl, { samples: 0, hdr: true, depth: false });
    // Two of them, because a separable blur reads one and writes the other,
    // then reads that one and writes back.
    this.bloom = [
      new Target(gl, { samples: 0, hdr: true, depth: false }),
      new Target(gl, { samples: 0, hdr: true, depth: false }),
    ];

    gl.enable(gl.DEPTH_TEST);
    // Culling stays off: the ribbon is viewed from both sides inside loops.
    gl.disable(gl.CULL_FACE);

    this.light = v3.norm([0.42, 0.82, 0.38]);
    this.fogColor = DEFAULT_FOG;
    this.fogNear = 150;
    this.fogFar = 460;
    this.cullDistance = 540;
    this.headStrength = HEAD_STRENGTH;
    this.headPos = new Float32Array(6);
    this.headDir = [0, 0, 1];
    this.shadowStrength = SHADOW_STRENGTH;
    this.bloomStrength = BLOOM_STRENGTH;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w && h && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const cw = this.canvas.width || 1, ch = this.canvas.height || 1;
    this.aspect = cw / ch;
    this.hdr.resize(cw, ch);
    this.resolved.resize(cw, ch);
    const bw = Math.max(1, Math.round(cw / BLOOM_SCALE));
    const bh = Math.max(1, Math.round(ch / BLOOM_SCALE));
    for (const b of this.bloom) b.resize(bw, bh);
  }

  // Uploads a MeshData into GPU buffers. Returns a chunk usable by a scene.
  upload(meshData) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffers = [];
    const mk = (arr, slot) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(slot);
      gl.vertexAttribPointer(slot, 3, gl.FLOAT, false, 0, 0);
      buffers.push(b);
    };
    mk(meshData.p, ATTR.POS);
    mk(meshData.n, ATTR.NORMAL);
    mk(meshData.c, ATTR.COLOR);
    gl.bindVertexArray(null);

    const { center, radius } = meshData.bounds();
    return { vao, buffers, count: meshData.vertexCount, center, radius };
  }

  dispose(chunks) {
    const gl = this.gl;
    for (const c of chunks || []) {
      if (!c) continue;
      for (const b of c.buffers) gl.deleteBuffer(b);
      gl.deleteVertexArray(c.vao);
    }
  }

  /* ------------------------------------------------------------- a frame -- */

  // One frame, from a description of the scene rather than a sequence of draw
  // calls.
  //
  // This is the one place the game had to give something up. On the television
  // Game.render drew: it called beginFrame and then draw() once per group, and
  // the renderer never saw the scene as a whole. A shadow pass has to walk the
  // same geometry a second time, from somewhere else, before any of it reaches
  // the screen -- so the list of what there is to draw has to exist before the
  // drawing starts. Game.render now hands that list over and stays out of the
  // order things happen in.
  //
  //   camera   { q, pos, fov }
  //   sky      one chunk, drawn behind everything and lit by nothing
  //   groups   [{ chunks, material }]  the static world
  //   dynamic  [{ chunk, model, material, alpha }]  ghost or replay car
  //   ambient  the track's own lighting mood, scaling every material's floor
  renderFrame(sc) {
    const gl = this.gl;
    this.resize();

    const cam = sc.camera;
    this.proj = mat4.perspective(cam.fov * Math.PI / 180, this.aspect, 0.35, 2600);
    this.viewMat = mat4.view(cam.q, cam.pos);
    this.skyView = mat4.view(cam.q, cam.pos, true);
    this.camPos = cam.pos;
    this.camFwd = quat.fwd(cam.q);
    this.planes = frustumPlanes(mat4.mul(this.proj, this.viewMat));
    this.ambientScale = sc.ambient || 1;
    this.aimHeadlights(sc.headlights);

    this.shadowPass(sc);
    this.scenePass(sc);
    this.hdr.blitTo(this.resolved);
    this.bloomPass();
    this.presentPass();
  }

  // Puts the two lamps where the car is and points them where it points. The
  // car's own frame, not the world's: inside a loop the beams go round with
  // it, and on a corkscrew they roll.
  aimHeadlights(h) {
    if (!h) { this.headOn = false; return; }
    this.headOn = true;
    const fwd = quat.fwd(h.q), up = quat.up(h.q), right = quat.right(h.q);
    const base = v3.mad(v3.mad(h.pos, fwd, HEAD_FWD), up, -HEAD_DOWN);
    for (const [i, side] of [[0, -1], [1, 1]]) {
      const p = v3.mad(base, right, side * HEAD_SIDE);
      this.headPos[i * 3] = p[0];
      this.headPos[i * 3 + 1] = p[1];
      this.headPos[i * 3 + 2] = p[2];
    }
    // Dipped, so the pool lands on the road ahead rather than on the horizon.
    this.headDir = v3.norm(v3.mad(fwd, up, -HEAD_DIP));
  }

  // The world as the sun sees it, into each shadow map in turn.
  //
  // Same geometry, same vertex arrays, a different point of view and depth
  // only. Everything that can cast is drawn -- the ground is the one thing
  // that cannot, being a flat plane with nothing underneath it, and leaving it
  // in would only give it the chance to shadow itself.
  shadowPass(sc) {
    const gl = this.gl;
    const u = this.shadow.u;
    gl.useProgram(this.shadow.prog);
    gl.uniformMatrix4fv(u.uModel, false, IDENTITY);
    // Depth is pushed away from the light by a hair, scaled by how steeply the
    // surface is tilted away from it. The normal offset at lookup time (see
    // the scene shader) does most of the work; this catches the rest.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2.2, 4.0);

    for (let i = 0; i < this.shadowMaps.length; i++) {
      const map = this.shadowMaps[i];
      const { vp, centre } = this.lightMatrix(SHADOW_RADIUS[i], SHADOW_AHEAD[i]);
      this.lightVP[i] = vp;
      gl.bindFramebuffer(gl.FRAMEBUFFER, map.fbo);
      gl.viewport(0, 0, map.size, map.size);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(u.uLightVP, false, vp);

      for (const g of sc.groups || []) {
        if (g.material.casts === false) continue;
        for (const c of g.chunks) {
          if (!c || !c.count) continue;
          // Culled against the light's slab, not the camera's frustum: what
          // matters here is whether it can throw a shadow into the picture,
          // not whether it is in the picture.
          if (v3.dist(c.center, centre) - c.radius > SHADOW_RADIUS[i] * 1.6) continue;
          gl.bindVertexArray(c.vao);
          gl.drawArrays(gl.TRIANGLES, 0, c.count);
        }
      }
      // The ghost and the replay car cast too -- a car with no shadow is the
      // whole complaint this commit exists to answer, and it is one more draw.
      for (const d of sc.dynamic || []) {
        if (!d.chunk || !d.chunk.count) continue;
        gl.uniformMatrix4fv(u.uModel, false, d.model);
        gl.bindVertexArray(d.chunk.vao);
        gl.drawArrays(gl.TRIANGLES, 0, d.chunk.count);
        gl.uniformMatrix4fv(u.uModel, false, IDENTITY);
      }
    }

    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // The sun's view of one slab of world: a box `radius` wide, centred a little
  // ahead of the car, looking along the light.
  lightMatrix(radius, ahead) {
    const centre = v3.mad(this.camPos, this.camFwd, radius * ahead);

    // Looking from far enough back that everything tall is still in front.
    const eye = v3.mad(centre, this.light, SHADOW_DEPTH);
    const view = mat4.lookAlong(v3.scale(this.light, -1), eye);

    // Snapped to whole texels, in the light's own frame.
    //
    // Without this the box slides by a fraction of a texel every frame as the
    // car moves, every shadow edge is re-rasterised against a slightly
    // different grid, and the whole world crawls with shimmering edges. It is
    // the single cheapest thing that separates a shadow map that looks solid
    // from one that boils.
    const texel = 2 * radius / SHADOW_SIZE;
    const cx = view[0] * centre[0] + view[4] * centre[1] + view[8] * centre[2] + view[12];
    const cy = view[1] * centre[0] + view[5] * centre[1] + view[9] * centre[2] + view[13];
    const dx = Math.round(cx / texel) * texel - cx;
    const dy = Math.round(cy / texel) * texel - cy;

    const proj = mat4.ortho(-radius + dx, radius + dx, -radius + dy, radius + dy,
                            1, SHADOW_DEPTH * 2);
    return { vp: mat4.mul(proj, view), centre };
  }

  // The world, into the multisampled off-screen buffer.
  scenePass(sc) {
    const gl = this.gl;
    const u = this.scene.u;
    this.hdr.bind();
    gl.clearColor(this.fogColor[0], this.fogColor[1], this.fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.scene.prog);
    gl.uniformMatrix4fv(u.uProj, false, this.proj);
    gl.uniformMatrix4fv(u.uModel, false, IDENTITY);
    gl.uniform1f(u.uAlpha, 1);
    gl.uniform3fv(u.uLightDir, this.light);
    gl.uniform3fv(u.uFogColor, this.fogColor);
    gl.uniform1f(u.uFogNear, this.fogNear);
    gl.uniform1f(u.uFogFar, this.fogFar);
    gl.uniform3fv(u.uCamPos, this.camPos);
    gl.uniform3fv(u.uHeadPos, this.headPos);
    gl.uniform3fv(u.uHeadDir, this.headDir);
    gl.uniform1f(u.uHeadStrength, this.headOn ? this.headStrength : 0);

    gl.uniformMatrix4fv(u.uLightNear, false, this.lightVP[0]);
    gl.uniformMatrix4fv(u.uLightFar, false, this.lightVP[1]);
    gl.uniform1f(u.uShadowTexel, 1 / SHADOW_SIZE);
    gl.uniform2fv(u.uShadowWorldTexel, this.shadowWorldTexel);
    gl.uniform1f(u.uShadowStrength, this.shadowStrength);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowMaps[0].texture);
    gl.uniform1i(u.uShadowNear, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowMaps[1].texture);
    gl.uniform1i(u.uShadowFar, 1);

    if (sc.sky) this.drawSky(sc.sky);
    for (const g of sc.groups || []) this.drawGroup(g);
    // Last, over the finished scene, because it is blended.
    for (const d of sc.dynamic || []) this.drawDynamic(d);
  }

  drawSky(chunk) {
    const gl = this.gl, u = this.scene.u;
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.uniformMatrix4fv(u.uView, false, this.skyView);
    gl.uniform1f(u.uLit, 0);
    gl.uniform1f(u.uFogScale, 0);
    gl.uniform1f(u.uAmbient, 1);
    // uLit at 0 already gates every lit term, but a glint on the sky dome
    // would be the one thing that could still get through.
    gl.uniform1f(u.uSpecular, 0);
    gl.bindVertexArray(chunk.vao);
    gl.drawArrays(gl.TRIANGLES, 0, chunk.count);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  // A group of static chunks, with distance + frustum culling.
  drawGroup({ chunks, material }) {
    const gl = this.gl, u = this.scene.u;
    gl.uniformMatrix4fv(u.uView, false, this.viewMat);
    gl.uniform1f(u.uLit, 1);
    gl.uniform1f(u.uFogScale, 1);
    gl.uniform1f(u.uAmbient, material.ambient * this.ambientScale);
    gl.uniform1f(u.uSpecular, material.specular || 0);
    gl.uniform1f(u.uShine, material.shine || 1);
    const cull = this.cullDistance;
    for (const c of chunks) {
      if (!c || !c.count) continue;
      if (v3.dist(c.center, this.camPos) - c.radius > cull) continue;
      if (!sphereVisible(this.planes, c.center, c.radius)) continue;
      gl.bindVertexArray(c.vao);
      gl.drawArrays(gl.TRIANGLES, 0, c.count);
    }
  }

  // A single moving, see-through object. Blending is enabled only here, and
  // depth writing is off so the ghost never hides the road behind it -- it is
  // a replay, not an obstacle.
  drawDynamic({ chunk, model, material, alpha = 1 }) {
    const gl = this.gl, u = this.scene.u;
    if (!chunk || !chunk.count) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniformMatrix4fv(u.uView, false, this.viewMat);
    gl.uniformMatrix4fv(u.uModel, false, model);
    gl.uniform1f(u.uLit, 1);
    gl.uniform1f(u.uFogScale, 1);
    gl.uniform1f(u.uAmbient, material.ambient);
    gl.uniform1f(u.uSpecular, material.specular || 0);
    gl.uniform1f(u.uShine, material.shine || 1);
    gl.uniform1f(u.uAlpha, alpha);
    gl.bindVertexArray(chunk.vao);
    gl.drawArrays(gl.TRIANGLES, 0, chunk.count);
    gl.uniformMatrix4fv(u.uModel, false, IDENTITY);
    gl.uniform1f(u.uAlpha, 1);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  // What is brighter than the screen can show, blurred, kept aside.
  bloomPass() {
    const gl = this.gl;
    const [a, b] = this.bloom;
    gl.disable(gl.DEPTH_TEST);

    a.bind();
    gl.useProgram(this.bright.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.resolved.texture);
    gl.uniform1i(this.bright.u.uScene, 0);
    gl.uniform1f(this.bright.u.uThreshold, BLOOM_THRESHOLD);
    gl.uniform1f(this.bright.u.uKnee, BLOOM_KNEE);
    this.screen.draw();

    gl.useProgram(this.blur.prog);
    gl.uniform1i(this.blur.u.uSource, 0);
    for (const [src, dst, dir] of [[a, b, [1 / a.width, 0]], [b, a, [0, 1 / a.height]]]) {
      dst.bind();
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform2f(this.blur.u.uDirection, dir[0], dir[1]);
      this.screen.draw();
    }
    gl.enable(gl.DEPTH_TEST);
  }

  // The finished picture, onto the canvas.
  presentPass() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.present.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.resolved.texture);
    gl.uniform1i(this.present.u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloom[0].texture);
    gl.uniform1i(this.present.u.uBloom, 1);
    gl.uniform1f(this.present.u.uBloomStrength, this.bloomStrength);
    gl.uniform1f(this.present.u.uKnee, ROLLOFF_KNEE);
    this.screen.draw();
    gl.enable(gl.DEPTH_TEST);
  }
}
