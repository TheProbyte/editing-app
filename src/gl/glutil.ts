export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
  fmt: 'f16' | 'u8';
}

export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export class Program {
  prog: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  private checked = false;
  private vs: WebGLShader;
  private fs: WebGLShader;
  /**
   * Compiling and linking are only *started* here; `check()` waits for the result. Creating all
   * the programs first and checking afterwards lets the driver build them in parallel.
   */
  constructor(private gl: WebGL2RenderingContext, frag: string, private name: string) {
    this.vs = compile(gl, gl.VERTEX_SHADER, VERT);
    this.fs = compile(gl, gl.FRAGMENT_SHADER, frag);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, this.vs);
    gl.attachShader(prog, this.fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    this.prog = prog;
    if (Program.serial) this.check();
  }
  /** `?serialCompile` in the URL: check each program as it's created (to compare start-up times). */
  static serial = typeof location !== 'undefined' && /[?&]serialCompile/.test(location.search);
  check() {
    if (this.checked) return;
    const gl = this.gl;
    for (const [s, kind] of [[this.vs, 'vertex'], [this.fs, 'fragment']] as const) {
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed (${this.name}, ${kind}): ${gl.getShaderInfoLog(s)}`);
    }
    if (!gl.getProgramParameter(this.prog, gl.LINK_STATUS)) throw new Error(`Link failed (${this.name}): ${gl.getProgramInfoLog(this.prog)}`);
    gl.deleteShader(this.vs);
    gl.deleteShader(this.fs);
    this.checked = true;
  }
  loc(n: string) {
    if (!this.locs.has(n)) this.locs.set(n, this.gl.getUniformLocation(this.prog, n));
    return this.locs.get(n)!;
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

export class GL {
  gl: WebGL2RenderingContext;
  floatRT: boolean;
  maxTex: number;
  private vao: WebGLVertexArrayObject;
  private pool: Target[] = [];

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true, // low-latency canvas on Android Chrome
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available on this device/browser.');
    this.gl = gl;
    this.floatRT = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    gl.getExtension('OES_texture_float_linear');
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  }

  texture(w: number, h: number, fmt: 'f16' | 'u8' | 'rgb16f') {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const internal = fmt === 'u8' ? gl.RGBA8 : fmt === 'rgb16f' ? gl.RGB16F : gl.RGBA16F;
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    setSampling(gl);
    return tex;
  }

  /** Get a render target from the pool (or create one). Release it when done. */
  acquire(w: number, h: number, wantFloat = true): Target {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const fmt = wantFloat && this.floatRT ? 'f16' : 'u8';
    const i = this.pool.findIndex((t) => t.w === w && t.h === h && t.fmt === fmt);
    if (i >= 0) return this.pool.splice(i, 1)[0];
    const gl = this.gl;
    const tex = this.texture(w, h, fmt);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h, fmt };
  }

  release(t: Target | null | undefined) {
    if (!t) return;
    this.pool.push(t);
    // keep the pool bounded so memory doesn't balloon after exports
    while (this.pool.length > 24) this.destroy(this.pool.shift()!);
  }

  destroy(t: Target) {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  /** Drop all pooled targets (used after a big export to free GPU memory). */
  trim(maxPixels = 0) {
    this.pool = this.pool.filter((t) => {
      if (t.w * t.h > maxPixels) {
        this.destroy(t);
        return false;
      }
      return true;
    });
  }

  draw(prog: Program, target: Target | null, w: number, h: number, setup: (p: Program) => void) {
    const gl = this.gl;
    prog.check();
    gl.useProgram(prog.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h);
    this.unit = 0;
    setup(prog);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private unit = 0;
  bindTex(prog: Program, name: string, tex: WebGLTexture) {
    const gl = this.gl;
    const u = this.unit++;
    gl.activeTexture(gl.TEXTURE0 + u);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.loc(name), u);
  }
}

export function setSampling(gl: WebGL2RenderingContext) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
