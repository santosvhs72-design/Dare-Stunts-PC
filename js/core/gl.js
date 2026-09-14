// Small WebGL 2 tools. Nothing here knows what a track is.

export function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) return s;
  // A shader error points at a line of the *assembled* source, preamble
  // included, and hunting for that line by counting in your head is miserable.
  const log = gl.getShaderInfoLog(s);
  const n = /ERROR: \d+:(\d+)/.exec(log);
  const lines = src.split('\n');
  const near = n ? lines.slice(Math.max(0, n[1] - 3), Number(n[1]) + 2)
    .map((l, i) => `${Math.max(1, n[1] - 2) + i}| ${l}`).join('\n') : '';
  throw new Error(`${log}\n${near}`);
}

export function program(gl, vsSrc, fsSrc, name = 'programa') {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`${name}: ${gl.getProgramInfoLog(p)}`);
  }
  // Every uniform the program actually has, looked up once. A location that
  // comes back null is a uniform the compiler dropped because nothing read it,
  // and setting it is a no-op -- which is what we want, rather than a crash.
  const u = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(p, i);
    const base = info.name.replace(/\[0\]$/, '');   // arrays report as name[0]
    u[base] = gl.getUniformLocation(p, base);
  }
  return { prog: p, u };
}

// Half-float colour is what makes a headlight able to be brighter than white
// without the picture clipping before the tone map sees it. Not universal, so
// it is asked for rather than assumed.
export function hdrFormat(gl) {
  if (gl.getExtension('EXT_color_buffer_float')
      || gl.getExtension('EXT_color_buffer_half_float')) {
    return { internal: gl.RGBA16F, type: gl.HALF_FLOAT, hdr: true };
  }
  return { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE, hdr: false };
}

// An off-screen colour+depth buffer.
//
// With `samples` it is built out of renderbuffers, which can be multisampled
// but cannot be read by a shader -- that is the buffer the world is drawn
// into. Without, it is built out of a texture, which is the opposite: no
// multisampling, but readable. A frame goes through one of each, and
// `blitTo` is the step between them that averages the samples down.
export class Target {
  constructor(gl, { samples = 0, hdr = true, depth = true, filter = null } = {}) {
    this.gl = gl;
    this.samples = samples;
    this.depth = depth;
    this.filter = filter || gl.LINEAR;
    const f = hdr ? hdrFormat(gl) : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    this.format = f;
    this.fbo = gl.createFramebuffer();
    this.width = 0;
    this.height = 0;
  }

  resize(w, h) {
    const gl = this.gl;
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    if (w === this.width && h === this.height) return this;
    this.width = w; this.height = h;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);

    if (this.samples > 0) {
      this.color = this.color || gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.color);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, this.format.internal, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.color);
    } else {
      this.texture = this.texture || gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.format.internal, w, h, 0,
                    gl.RGBA, this.format.type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    }

    if (this.depth) {
      this.depthBuf = this.depthBuf || gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuf);
      if (this.samples > 0) {
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, w, h);
      } else {
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      }
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuf);
    }

    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (ok !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`framebuffer incompleto (0x${ok.toString(16)}) a ${w}x${h}`);
    }
    return this;
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    return this;
  }

  // Averages this target's samples down into another target of the same size.
  blitTo(dst) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, dst.width, dst.height,
                       gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return dst;
  }

  dispose() {
    const gl = this.gl;
    gl.deleteFramebuffer(this.fbo);
    if (this.color) gl.deleteRenderbuffer(this.color);
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.depthBuf) gl.deleteRenderbuffer(this.depthBuf);
  }
}

// A depth-only target, readable as a shadow map. DEPTH_COMPONENT32F rather
// than 24: the light's view spans hundreds of metres and the bias that keeps a
// surface from shadowing itself is measured in centimetres.
export function shadowTarget(gl, size) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, size, size, 0,
                gl.DEPTH_COMPONENT, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Sampled through a sampler2DShadow: the hardware compares and filters in
  // one go, which is a 2x2 percentage-closer filter for free.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
  // No colour attachment at all: a shadow pass writes nothing but depth.
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (ok !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`mapa de sombras incompleto (0x${ok.toString(16)})`);
  }
  return { fbo, texture: tex, size };
}

// One triangle covering the screen, for the passes that read a whole picture
// and write a whole picture. A triangle rather than two: no seam down the
// diagonal, and one less vertex to think about. It carries no attributes --
// the vertex shader makes its own positions from gl_VertexID.
export function screenPass(gl) {
  const vao = gl.createVertexArray();
  return {
    draw() {
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
  };
}
