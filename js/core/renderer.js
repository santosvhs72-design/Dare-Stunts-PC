import { mat4, v3, frustumPlanes, sphereVisible } from './math.js';
import { hex } from './mesh.js';

const VS = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform mat4 uProj, uView, uModel;
uniform vec3 uLightDir;
uniform float uAmbient, uLit, uFogNear, uFogFar, uFogScale;
varying vec3 vColor;
varying float vFog;
void main(){
  vec4 vp = uView * (uModel * vec4(aPos, 1.0));
  gl_Position = uProj * vp;
  // w = 0 rotates the normal without translating it, which is all a rigid
  // model matrix needs -- and avoids a mat3 cast for WebGL 1's sake.
  vec3 n = normalize((uModel * vec4(aNormal, 0.0)).xyz);
  float diff = max(dot(n, uLightDir), 0.0);
  // Hemispheric ambient: sky above, ground bounce below. Without it the vertical
  // faces of loops and viaducts read as near-black slabs.
  float hemi = 0.5 + 0.5 * n.y;
  // uAmbient is a brightness floor, not a mix weight: the inside of a loop faces
  // away from the sun, and it still has to be readable to drive through.
  float lit = uAmbient + (1.0 - uAmbient) * (0.45 * hemi + 0.55 * diff);
  vColor = mix(aColor, aColor * lit, uLit);
  vFog = clamp((-vp.z - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0) * uFogScale;
}`;

const FS = `
precision mediump float;
uniform vec3 uFogColor;
uniform float uAlpha;
varying vec3 vColor;
varying float vFog;
void main(){
  gl_FragColor = vec4(mix(vColor, uFogColor, vFog), uAlpha);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

// Default until a track sets its own (see Game.load / world/scenery.js's sky
// presets) -- day, the same horizon the sky always used before tracks had a
// choice.
const DEFAULT_FOG = hex('#aac6e2');

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, depth: true });
    if (!gl) throw new Error('WebGL não disponível neste browser.');
    this.gl = gl;
    this.canvas = canvas;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    gl.useProgram(prog);

    this.a = {
      pos: gl.getAttribLocation(prog, 'aPos'),
      normal: gl.getAttribLocation(prog, 'aNormal'),
      color: gl.getAttribLocation(prog, 'aColor'),
    };
    this.u = {};
    for (const n of ['uProj', 'uView', 'uModel', 'uLightDir', 'uAmbient', 'uLit',
                     'uFogNear', 'uFogFar', 'uFogScale', 'uFogColor', 'uAlpha']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }

    gl.enable(gl.DEPTH_TEST);
    // Culling stays off: the ribbon is viewed from both sides inside loops.
    gl.disable(gl.CULL_FACE);

    this.light = v3.norm([0.42, 0.82, 0.38]);
    this.fogColor = DEFAULT_FOG;
    this.fogNear = 150;
    this.fogFar = 460;
    this.cullDistance = 540;
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
    this.aspect = (this.canvas.width || 1) / (this.canvas.height || 1);
  }

  // Uploads a MeshData into GPU buffers. Returns a chunk usable by draw().
  upload(meshData) {
    const gl = this.gl;
    const mk = arr => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
      return b;
    };
    const { center, radius } = meshData.bounds();
    return {
      pos: mk(meshData.p), normal: mk(meshData.n), color: mk(meshData.c),
      count: meshData.vertexCount, center, radius,
    };
  }

  dispose(chunks) {
    for (const c of chunks || []) {
      this.gl.deleteBuffer(c.pos);
      this.gl.deleteBuffer(c.normal);
      this.gl.deleteBuffer(c.color);
    }
  }

  beginFrame(camQuat, camPos, fovDeg) {
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(this.fogColor[0], this.fogColor[1], this.fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.proj = mat4.perspective(fovDeg * Math.PI / 180, this.aspect, 0.35, 2600);
    this.viewMat = mat4.view(camQuat, camPos);
    this.skyView = mat4.view(camQuat, camPos, true);
    this.camPos = camPos;
    this.planes = frustumPlanes(mat4.mul(this.proj, this.viewMat));

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uProj, false, this.proj);
    gl.uniformMatrix4fv(this.u.uModel, false, IDENTITY);
    gl.uniform1f(this.u.uAlpha, 1);
    gl.uniform3fv(this.u.uLightDir, this.light);
    gl.uniform3fv(this.u.uFogColor, this.fogColor);
    gl.uniform1f(this.u.uFogNear, this.fogNear);
    gl.uniform1f(this.u.uFogFar, this.fogFar);
  }

  bind(chunk) {
    const gl = this.gl;
    for (const [loc, buf] of [[this.a.pos, chunk.pos], [this.a.normal, chunk.normal], [this.a.color, chunk.color]]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    }
  }

  drawSky(chunk) {
    const gl = this.gl;
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.uniformMatrix4fv(this.u.uView, false, this.skyView);
    gl.uniform1f(this.u.uLit, 0);
    gl.uniform1f(this.u.uFogScale, 0);
    gl.uniform1f(this.u.uAmbient, 1);
    this.bind(chunk);
    gl.drawArrays(gl.TRIANGLES, 0, chunk.count);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  // A single moving, see-through object. Blending is enabled only here, and
  // depth writing is off so the ghost never hides the road behind it -- it is a
  // replay, not an obstacle.
  drawGhost(chunk, model, ambient = 0.62, alpha = 0.45) {
    const gl = this.gl;
    if (!chunk || !chunk.count) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniformMatrix4fv(this.u.uView, false, this.viewMat);
    gl.uniformMatrix4fv(this.u.uModel, false, model);
    gl.uniform1f(this.u.uLit, 1);
    gl.uniform1f(this.u.uFogScale, 1);
    gl.uniform1f(this.u.uAmbient, ambient);
    gl.uniform1f(this.u.uAlpha, alpha);
    this.bind(chunk);
    gl.drawArrays(gl.TRIANGLES, 0, chunk.count);
    gl.uniformMatrix4fv(this.u.uModel, false, IDENTITY);
    gl.uniform1f(this.u.uAlpha, 1);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  // Draws chunks with distance + frustum culling.
  draw(chunks, ambient = 0.52) {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.u.uView, false, this.viewMat);
    gl.uniform1f(this.u.uLit, 1);
    gl.uniform1f(this.u.uFogScale, 1);
    gl.uniform1f(this.u.uAmbient, ambient);
    const cull = this.cullDistance;
    for (const c of chunks) {
      if (!c.count) continue;
      if (v3.dist(c.center, this.camPos) - c.radius > cull) continue;
      if (!sphereVisible(this.planes, c.center, c.radius)) continue;
      this.bind(c);
      gl.drawArrays(gl.TRIANGLES, 0, c.count);
    }
  }
}
