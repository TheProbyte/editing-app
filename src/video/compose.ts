// GPU side of the video editor: puts a clip's frame into the project frame (rotation from
// the file, fit or fill, a soft blurred / black / white background) and draws text titles
// over the finished picture.
import { GL, Program, type Target } from '../gl/glutil';

const COMPOSE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform sampler2D uBg;
uniform vec2 uOut;      // output size, px
uniform vec2 uDisp;     // size the source is shown at, px
uniform vec2 uOff;      // offset of its centre, px
uniform int uRot;       // quarter turns, clockwise
uniform int uFlip;
uniform int uBgMode;    // 0 colour, 1 texture
uniform vec3 uBgColor;
uniform float uBgDim;
uniform int uTaps;      // 1: shrinking a lot without mipmaps: average 4 spread taps
uniform float uAng;     // the clip's own rotation (keyframes), radians clockwise
vec4 bgAt(vec2 uv) {
  if (uBgMode == 0) return vec4(uBgColor, 1.0);
  // the background copy is tiny; a few taps smooth its texels into a soft blur
  vec2 px = 1.0 / vec2(textureSize(uBg, 0));
  vec3 c = vec3(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) c += texture(uBg, uv + vec2(i, j) * px * 0.8).rgb;
  return vec4(c / 9.0 * uBgDim, 1.0);
}
void main() {
  // texel rows run top to bottom here, like an uploaded image
  vec2 p = vUv * uOut - (0.5 * uOut + uOff);
  float cs = cos(uAng), sn = sin(uAng);
  p = vec2(cs * p.x + sn * p.y, -sn * p.x + cs * p.y);
  vec2 d = p / uDisp + 0.5;
  vec2 e = min(d, 1.0 - d) * uDisp;
  float a = clamp(min(e.x, e.y) + 0.5, 0.0, 1.0);
  vec2 q = clamp(d, 0.0, 1.0);
  if (uFlip == 1) q.x = 1.0 - q.x;
  vec2 r = q;
  if (uRot == 1) r = vec2(q.y, 1.0 - q.x);
  else if (uRot == 2) r = vec2(1.0 - q.x, 1.0 - q.y);
  else if (uRot == 3) r = vec2(1.0 - q.y, q.x);
  // footprint of one output pixel in the source (taken before any branching)
  vec2 dx = dFdx(r) * 0.3, dy = dFdy(r) * 0.3;
  vec4 bg = bgAt(vUv);
  if (a <= 0.0) { o = bg; return; }
  vec3 c;
  if (uTaps == 1) {
    c = (texture(uSrc, r + dx + dy).rgb + texture(uSrc, r + dx - dy).rgb +
         texture(uSrc, r - dx + dy).rgb + texture(uSrc, r - dx - dy).rgb) * 0.25;
  } else c = texture(uSrc, r).rgb;
  o = mix(bg, vec4(c, 1.0), a);
}`;

const OVER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform int uFlipY;
void main() {
  o = texture(uTex, uFlipY == 1 ? vec2(vUv.x, 1.0 - vUv.y) : vUv);
}`;

export interface FrameSource {
  tex: WebGLTexture;
  /** raw (coded) size */
  w: number;
  h: number;
  /** clockwise quarter turns to show it upright */
  rot: 0 | 1 | 2 | 3;
  flip: boolean;
  /** has mipmaps (else big downscales are supersampled) */
  mip?: boolean;
}

/** A decoded frame already on the GPU. */
export interface GpuFrame {
  tex: WebGLTexture;
  w: number;
  h: number;
}

/** Textures decoded frames are copied into as soon as they arrive (the decoder never waits on us). */
const RING = 7;

/** A clip's framing in the project frame: zoom (1 = as fitted), offset (fractions of the frame), rotation (degrees). */
export interface Framing {
  z: number;
  x: number;
  y: number;
  r: number;
}

export interface Placement {
  fit: 'fit' | 'fill';
  bg: {
    kind: 'blur' | 'color' | 'tex';
    color: [number, number, number];
    /** gradient or photo for 'tex' */
    tex?: GpuFrame | null;
    /** 0 sharp … 1 very soft (blur, and a photo background) */
    blur: number;
    /** darken a little behind the picture */
    dim: number;
  };
  tf?: Framing;
}

export class Compositor {
  private compose: Program;
  private over: Program;
  /** the raw decoded frame (re-specified each frame, so not an immutable texture) */
  raw: WebGLTexture;
  private rawSize = { w: 0, h: 0 };
  private rawMip = false;
  private bgT: Target | null = null;
  private textTex: WebGLTexture;
  private textKey = '';
  private textOn = false;
  private textCanvas = document.createElement('canvas');
  private ring: GpuFrame[] = [];
  private ringNext = 0;

  constructor(private g: GL) {
    this.compose = new Program(g.gl, COMPOSE, 'compose');
    this.over = new Program(g.gl, OVER, 'overlay');
    this.raw = this.mutableTex();
    this.textTex = this.mutableTex();
  }

  private mutableTex() {
    const gl = this.g.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return t;
  }

  /** Upload a decoded frame (VideoFrame, bitmap, canvas) into the raw texture. */
  upload(img: TexImageSource, w: number, h: number, outLong: number, quality = true) {
    const gl = this.g.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.raw);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.rawSize = { w, h };
    // shrinking a lot (a 4K clip in a small preview): mipmaps keep fine detail from shimmering
    // (skipped during playback, where a frame is gone before you'd notice)
    const mip = quality && Math.max(w, h) > outLong * 1.6;
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    this.rawMip = mip;
  }

  /** Copy a decoded frame into the next ring texture (playback). */
  uploadRing(img: TexImageSource, w: number, h: number): GpuFrame {
    const gl = this.g.gl;
    if (this.ring.length < RING) this.ring.push({ tex: this.mutableTex(), w: 1, h: 1 });
    const slot = this.ring[this.ringNext];
    this.ringNext = (this.ringNext + 1) % RING;
    gl.bindTexture(gl.TEXTURE_2D, slot.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    slot.w = w;
    slot.h = h;
    return { ...slot };
  }

  /** A still's own texture (made once per image). */
  imageTexture(bmp: ImageBitmap) {
    const gl = this.g.gl;
    const t = this.mutableTex();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    return t;
  }

  /** Draw `src` into `dst` (the project frame), placed per `pl`. Null src = background only. */
  place(src: FrameSource | null, dst: Target, pl: Placement) {
    const g = this.g;
    const dispW = src ? (src.rot % 2 ? src.h : src.w) : 1;
    const dispH = src ? (src.rot % 2 ? src.w : src.h) : 1;
    const fitK = Math.min(dst.w / dispW, dst.h / dispH);
    const fillK = Math.max(dst.w / dispW, dst.h / dispH);
    const tf = pl.tf ?? { z: 1, x: 0, y: 0, r: 0 };
    const k = (pl.fit === 'fill' ? fillK : fitK) * Math.max(0.05, tf.z);
    // the background: soft copies come from a tiny target (smaller = softer), smoothed when sampled
    const B = pl.bg;
    let mode = 0;
    let bgTex: WebGLTexture | null = null;
    const soft = (from: FrameSource) => {
      const bw = Math.round(400 - (400 - 20) * Math.pow(Math.min(1, Math.max(0, B.blur)), 0.5));
      const bh = Math.max(4, Math.round((bw * dst.h) / dst.w));
      if (!this.bgT || this.bgT.w !== bw || this.bgT.h !== bh) {
        if (this.bgT) g.destroy(this.bgT);
        this.bgT = g.acquire(bw, bh, false);
      }
      const fdW = from.rot % 2 ? from.h : from.w, fdH = from.rot % 2 ? from.w : from.h;
      this.draw(from, this.bgT, Math.max(bw / fdW, bh / fdH), { mode: 0, color: [0, 0, 0], tex: null, dim: 1 }, null);
      return this.bgT.tex;
    };
    if (B.kind === 'blur' && src) {
      bgTex = soft(src);
      mode = 1;
    } else if (B.kind === 'tex' && B.tex) {
      const ts: FrameSource = { tex: B.tex.tex, w: B.tex.w, h: B.tex.h, rot: 0, flip: false, mip: true };
      bgTex = B.blur > 0.02 ? soft(ts) : null;
      if (!bgTex) {
        // sharp: fill the frame with it directly
        if (!this.bgT || this.bgT.w !== dst.w || this.bgT.h !== dst.h) {
          if (this.bgT) g.destroy(this.bgT);
          this.bgT = g.acquire(dst.w, dst.h, false);
        }
        this.draw(ts, this.bgT, Math.max(dst.w / ts.w, dst.h / ts.h), { mode: 0, color: [0, 0, 0], tex: null, dim: 1 }, null);
        bgTex = this.bgT.tex;
      }
      mode = 1;
    }
    const bg = { mode, color: B.color, tex: bgTex, dim: B.dim };
    if (!src) {
      g.draw(this.compose, dst, dst.w, dst.h, (p) => {
        const gl = g.gl;
        g.bindTex(p, 'uSrc', this.raw);
        g.bindTex(p, 'uBg', bgTex ?? this.raw);
        gl.uniform2f(p.loc('uOut'), dst.w, dst.h);
        gl.uniform2f(p.loc('uDisp'), 1e-3, 1e-3);
        gl.uniform2f(p.loc('uOff'), 1e6, 1e6);
        gl.uniform1i(p.loc('uRot'), 0);
        gl.uniform1i(p.loc('uFlip'), 0);
        gl.uniform1i(p.loc('uBgMode'), mode);
        gl.uniform3fv(p.loc('uBgColor'), B.color);
        gl.uniform1f(p.loc('uBgDim'), B.dim);
        gl.uniform1f(p.loc('uAng'), 0);
        gl.uniform1i(p.loc('uTaps'), 0);
      });
      return;
    }
    this.draw(src, dst, k, bg, tf);
  }

  private draw(src: FrameSource, dst: Target, k: number, bg: { mode: number; color: [number, number, number]; tex: WebGLTexture | null; dim: number }, tf: Framing | null) {
    const g = this.g;
    const dispW = src.rot % 2 ? src.h : src.w;
    const dispH = src.rot % 2 ? src.w : src.h;
    g.draw(this.compose, dst, dst.w, dst.h, (p) => {
      const gl = g.gl;
      g.bindTex(p, 'uSrc', src.tex);
      g.bindTex(p, 'uBg', bg.mode === 1 && bg.tex ? bg.tex : src.tex);
      gl.uniform2f(p.loc('uOut'), dst.w, dst.h);
      gl.uniform2f(p.loc('uDisp'), dispW * k, dispH * k);
      gl.uniform2f(p.loc('uOff'), (tf?.x ?? 0) * dst.w, (tf?.y ?? 0) * dst.h);
      gl.uniform1f(p.loc('uAng'), ((tf?.r ?? 0) * Math.PI) / 180);
      gl.uniform1i(p.loc('uRot'), src.rot);
      gl.uniform1i(p.loc('uFlip'), src.flip ? 1 : 0);
      gl.uniform1i(p.loc('uBgMode'), bg.mode);
      gl.uniform3fv(p.loc('uBgColor'), bg.color);
      gl.uniform1f(p.loc('uBgDim'), bg.dim);
      // shrinking the raw frame a lot with no mipmaps (playback): supersample instead
      const mipped = src.mip ?? (src.tex === this.raw ? this.rawMip : true);
      gl.uniform1i(p.loc('uTaps'), !mipped && 1 / k > 1.5 ? 1 : 0);
    });
  }

  /** A small texture from a 2D canvas (gradient backgrounds), cached by key. */
  private canvasTex = new Map<string, GpuFrame>();
  canvasTexture(key: string, paint: () => HTMLCanvasElement): GpuFrame {
    let t = this.canvasTex.get(key);
    if (!t) {
      const c = paint();
      const tex = this.mutableTex();
      const gl = this.g.gl;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      t = { tex, w: c.width, h: c.height };
      this.canvasTex.set(key, t);
    }
    return t;
  }

  get rawFrame() {
    return { tex: this.raw, ...this.rawSize };
  }

  /**
   * Text titles: drawn into a canvas the size of the output (only when what's shown changes)
   * and laid over the finished picture on the canvas the app renders to.
   */
  setText(key: string, w: number, h: number, paint: ((ctx: CanvasRenderingContext2D, w: number, h: number) => void) | null) {
    this.textOn = !!paint;
    if (!paint || key === this.textKey) return;
    this.textKey = key;
    const c = this.textCanvas;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    paint(ctx, w, h);
    const gl = this.g.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.textTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  /** Draw a frame texture straight onto the screen canvas (no adjustments to apply). */
  blit(tex: WebGLTexture, w: number, h: number) {
    const g = this.g, gl = g.gl;
    gl.disable(gl.BLEND);
    g.draw(this.over, null, w, h, (p) => {
      g.bindTex(p, 'uTex', tex);
      gl.uniform1i(p.loc('uFlipY'), 1);
    });
  }

  /** Lay the text over whatever was just drawn to the screen canvas (w×h). */
  drawText(w: number, h: number) {
    if (!this.textOn) return;
    const g = this.g, gl = g.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    g.draw(this.over, null, w, h, (p) => {
      g.bindTex(p, 'uTex', this.textTex);
      gl.uniform1i(p.loc('uFlipY'), 1);
    });
    gl.disable(gl.BLEND);
  }

  dispose() {
    const gl = this.g.gl;
    gl.deleteTexture(this.raw);
    gl.deleteTexture(this.textTex);
    for (const r of this.ring) gl.deleteTexture(r.tex);
    for (const t of this.canvasTex.values()) gl.deleteTexture(t.tex);
    this.canvasTex.clear();
    this.ring = [];
    if (this.bgT) this.g.destroy(this.bgT);
  }
}
