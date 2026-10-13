import type { Mask, Stroke } from '../params';

const LONG = 1024;

interface Slot {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  id: number;
  /** AI selection drawn underneath the strokes */
  base: CanvasImageSource | null;
  /** strokes drawn so far, points drawn in the last of them, and a fingerprint of them */
  n: number;
  lastPts: number;
  fp: number;
}

/** Cheap fingerprint of the first n strokes (catches undo/redo replacing strokes). */
function fingerprint(strokes: Stroke[], n: number) {
  let f = n;
  for (let k = 0; k < n; k++) {
    const p = strokes[k].pts;
    f += (p[0] ?? 0) * 7919 + (p[1] ?? 0) * 104729 + (k < n - 1 ? p.length : 0) * 13 + (strokes[k].erase ? 3 : 0);
  }
  return f;
}

/**
 * Rasterizes brush-mask strokes into two RGBA textures (one channel per mask slot).
 * Strokes are vectors in frame coordinates, so the mask is resolution independent;
 * redraws are incremental while painting.
 */
export class BrushAtlas {
  tex: [WebGLTexture, WebGLTexture];
  private w = 1;
  private h = 1;
  private slots: (Slot | null)[] = new Array(8).fill(null);
  private packed: [Uint8Array, Uint8Array];
  private dabs = new Map<number, HTMLCanvasElement>();
  /** Raster for an AI ('subject') mask, or null while it's being computed. */
  getBase: (m: Mask) => CanvasImageSource | null = () => null;

  constructor(private gl: WebGL2RenderingContext) {
    this.tex = [this.mkTex(), this.mkTex()];
    this.packed = [new Uint8Array(4), new Uint8Array(4)];
    this.resize(1);
  }

  private mkTex() {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Match the frame's aspect ratio (w/h). Clears everything. */
  resize(aspect: number) {
    const w = aspect >= 1 ? LONG : Math.round(LONG * aspect);
    const h = aspect >= 1 ? Math.round(LONG / aspect) : LONG;
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.slots = new Array(8).fill(null);
    this.packed = [new Uint8Array(w * h * 4), new Uint8Array(w * h * 4)];
    const gl = this.gl;
    for (const t of this.tex) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.packed[0]);
    }
  }

  /** Bring the atlas in line with the masks (mask index = slot). */
  sync(masks: Mask[]) {
    for (let i = 0; i < 8; i++) {
      const m = masks[i];
      if (!m || (m.type !== 'brush' && m.type !== 'subject')) {
        if (this.slots[i]) this.clearSlot(i);
        continue;
      }
      this.syncSlot(i, m.id, m.strokes, m.type === 'subject' ? this.getBase(m) : null);
    }
  }

  private clearSlot(i: number) {
    this.slots[i] = null;
    this.writeChannel(i, null, 0, 0, this.w, this.h);
  }

  private syncSlot(i: number, id: number, strokes: Stroke[], base: CanvasImageSource | null) {
    let s = this.slots[i];
    if (!s) {
      const canvas = document.createElement('canvas');
      canvas.width = this.w;
      canvas.height = this.h;
      s = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })!, id, base: null, n: 0, lastPts: 0, fp: 0 };
      this.slots[i] = s;
    }
    const incremental =
      s.id === id && s.base === base && strokes.length >= s.n &&
      (s.n === 0 || strokes[s.n - 1].pts.length >= s.lastPts) &&
      fingerprint(strokes, s.n) === s.fp;
    if (incremental && strokes.length === s.n && (s.n === 0 || strokes[s.n - 1].pts.length === s.lastPts)) return;
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    if (!incremental) {
      s.ctx.clearRect(0, 0, this.w, this.h);
      if (base) s.ctx.drawImage(base, 0, 0, this.w, this.h);
      s.base = base;
      for (const st of strokes) this.drawStroke(s.ctx, st, 0, box);
    } else {
      if (s.n > 0) this.drawStroke(s.ctx, strokes[s.n - 1], Math.max(0, s.lastPts - 2), box, false);
      for (let k = s.n; k < strokes.length; k++) this.drawStroke(s.ctx, strokes[k], 0, box);
    }
    s.id = id;
    s.n = strokes.length;
    s.lastPts = strokes.length ? strokes[strokes.length - 1].pts.length : 0;
    s.fp = fingerprint(strokes, s.n);
    if (!incremental) {
      this.writeChannel(i, s.ctx, 0, 0, this.w, this.h);
      return;
    }
    if (box.x1 < box.x0) return;
    const x = Math.max(0, Math.floor(box.x0)), y = Math.max(0, Math.floor(box.y0));
    const w = Math.min(this.w, Math.ceil(box.x1)) - x, h = Math.min(this.h, Math.ceil(box.y1)) - y;
    if (w > 0 && h > 0) this.writeChannel(i, s.ctx, x, y, w, h);
  }

  private dab(hard: number) {
    const key = Math.round(hard * 10);
    let c = this.dabs.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d')!;
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      const inner = Math.min(0.95, key / 10);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(inner, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      this.dabs.set(key, c);
    }
    return c;
  }

  /** Dabs along a stroke from point `start`; `first` = also stamp that starting point (a tap paints one dab). */
  private drawStroke(ctx: CanvasRenderingContext2D, st: Stroke, start: number, box: { x0: number; y0: number; x1: number; y1: number }, first = true) {
    const r = Math.max(1, st.r * this.h);
    const dab = this.dab(st.hard);
    ctx.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
    ctx.globalAlpha = Math.min(1, 0.08 + st.flow * 0.5);
    const step = Math.max(1, r * 0.22);
    const P = st.pts;
    if (P.length < 2 || start + 1 >= P.length) return box;
    let px = P[start] * this.w, py = P[start + 1] * this.h;
    const put = (x: number, y: number) => {
      ctx.drawImage(dab, x - r, y - r, r * 2, r * 2);
      box.x0 = Math.min(box.x0, x - r);
      box.y0 = Math.min(box.y0, y - r);
      box.x1 = Math.max(box.x1, x + r);
      box.y1 = Math.max(box.y1, y + r);
    };
    if (first && start === 0) put(px, py);
    for (let k = start + 2; k < P.length; k += 2) {
      const x = P[k] * this.w, y = P[k + 1] * this.h;
      const d = Math.hypot(x - px, y - py);
      const n = Math.floor(d / step);
      for (let j = 1; j <= n; j++) put(px + ((x - px) * j) / n, py + ((y - py) * j) / n);
      if (n > 0) {
        px = x;
        py = y;
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    return box;
  }

  /** Copy one slot's alpha into its texture channel for the given rect and upload it. */
  private writeChannel(i: number, ctx: CanvasRenderingContext2D | null, x: number, y: number, w: number, h: number) {
    const ti = i < 4 ? 0 : 1;
    const ch = i % 4;
    const buf = this.packed[ti];
    const src = ctx ? ctx.getImageData(x, y, w, h).data : null;
    const full = x === 0 && y === 0 && w === this.w && h === this.h;
    // a full update uploads the packed buffer as is; a partial one goes through a small copy
    const sub = full ? buf : new Uint8Array(w * h * 4);
    for (let r = 0; r < h; r++) {
      let o = ((y + r) * this.w + x) * 4;
      let q = r * w * 4;
      for (let c = 0; c < w; c++, o += 4, q += 4) {
        buf[o + ch] = src ? src[q + 3] : 0;
        if (!full) {
          sub[q] = buf[o];
          sub[q + 1] = buf[o + 1];
          sub[q + 2] = buf[o + 2];
          sub[q + 3] = buf[o + 3];
        }
      }
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex[ti]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, sub);
  }
}
