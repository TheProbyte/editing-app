// On-device subject / people selection for masks, using MediaPipe:
//  * Magic Touch v2 (interactive): an encoder looks at the photo once, then a light decoder
//    turns taps and strokes (include / exclude) into a mask — a SAM-style segmenter small
//    enough for a phone.
//  * Selfie multiclass: person parts (hair, face, skin, clothes) and the background.
// Models download on first use and are kept in the Cache API, so it works offline after that.
import type { BrushMode, ImageSegmenter, InteractiveSegmenter } from '@mediapipe/tasks-vision';

const MODELS = {
  subject: 'https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/1/interactive_segmentation.task',
  people: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};
const CACHE = 'lumen-models-v1';

export interface MaskData {
  data: Float32Array;
  w: number;
  h: number;
}

/** A stroke for the subject model, in normalized image coordinates. */
export interface AiStroke {
  neg: boolean;
  pts: number[];
}

/** People parts offered in the UI → selfie-multiclass categories. */
export const PEOPLE_PARTS: { label: string; cats: number[] }[] = [
  { label: 'Person', cats: [1, 2, 3, 4, 5] },
  { label: 'Face', cats: [3] },
  { label: 'Skin', cats: [2, 3] },
  { label: 'Hair', cats: [1] },
  { label: 'Clothes', cats: [4] },
  { label: 'Background', cats: [0] },
];

const lib = (() => {
  let p: Promise<typeof import('@mediapipe/tasks-vision')> | null = null;
  return () => (p ??= import('@mediapipe/tasks-vision'));
})();

function fileset() {
  const base = new URL('mediapipe/', document.baseURI).href;
  return { wasmLoaderPath: base + 'vision_wasm_internal.js', wasmBinaryPath: base + 'vision_wasm_internal.wasm' };
}

async function fetchModel(url: string, progress: (f: number) => void): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = null;
  }
  const r = await fetch(url, { mode: 'cors' });
  if (!r.ok || !r.body) throw new Error(`Model download failed (${r.status})`);
  const total = +(r.headers.get('content-length') ?? 0);
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) progress(got / total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  try {
    await cache?.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch {
    /* storage full: fine, we just download again next time */
  }
  return buf;
}

export class Segmenter {
  private subject: Promise<InteractiveSegmenter> | null = null;
  private people: Promise<ImageSegmenter> | null = null;
  private subjectKey = '';
  private subjectDelegate: 'GPU' | 'CPU' = 'GPU';
  private forceCpu = false;
  private peopleCache: { key: string; masks: Float32Array[]; w: number; h: number } | null = null;

  /** True when a result for this image can come back quickly (model loaded, photo encoded). */
  warm(kind: 'subject' | 'people', key: string) {
    return kind === 'subject' ? !!this.subject && this.subjectKey === key : this.peopleCache?.key === key;
  }

  private async create<T>(make: (buf: Uint8Array, delegate: 'GPU' | 'CPU') => Promise<T>, url: string, progress: (f: number) => void, onDelegate?: (d: 'GPU' | 'CPU') => void) {
    const buf = await fetchModel(url, progress);
    // the GPU delegate is much faster, but not every WebView gives MediaPipe a usable context
    try {
      if (this.forceCpu || (window as unknown as { LUMEN_CPU?: boolean }).LUMEN_CPU) throw new Error('CPU requested');
      const r = await make(buf, 'GPU');
      onDelegate?.('GPU');
      return r;
    } catch (e) {
      console.warn('Using the CPU segmenter:', (e as Error).message);
      onDelegate?.('CPU');
      return make(buf, 'CPU');
    }
  }

  private getSubject(progress: (f: number) => void) {
    this.subject ??= lib().then((mp) =>
      this.create(
        (buf, delegate) => mp.InteractiveSegmenter.createFromOptions(fileset(), { baseOptions: { modelAssetBuffer: buf, delegate } }),
        MODELS.subject,
        progress,
        (d) => (this.subjectDelegate = d),
      ),
    );
    this.subject.catch(() => (this.subject = null));
    return this.subject;
  }

  private getPeople(progress: (f: number) => void) {
    this.people ??= lib().then((mp) =>
      this.create(
        // small model: the CPU is quick enough, and reading GPU-side masks back gives
        // empty results on some phones
        (buf) => mp.ImageSegmenter.createFromOptions(fileset(), {
          baseOptions: { modelAssetBuffer: buf, delegate: 'CPU' },
          runningMode: 'IMAGE',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        }),
        MODELS.people,
        progress,
      ),
    );
    this.people.catch(() => (this.people = null));
    return this.people;
  }

  /** Mask from include/exclude strokes. `key` identifies the image, so the encoder runs once per photo. */
  async subjectMask(image: HTMLCanvasElement, key: string, strokes: AiStroke[], progress: (f: number) => void): Promise<MaskData> {
    const seg = await this.getSubject(progress);
    if (this.subjectKey !== key) {
      seg.setImage(image);
      this.subjectKey = key;
    }
    const s = strokes.filter((st) => st.pts.length >= 2).map((st) => {
      const point: { x: number; y: number }[] = [];
      for (let i = 0; i < st.pts.length; i += 2) point.push({ x: clamp01(st.pts[i]), y: clamp01(st.pts[i + 1]) });
      // BrushMode.POSITIVE = 1, NEGATIVE = 2 (the enum isn't exported at runtime)
      return { brushMode: (st.neg ? 2 : 1) as BrushMode, point, isCompleted: true };
    });
    if (!s.length) return { data: new Float32Array(1), w: 1, h: 1 };
    const m = seg.segment(s);
    let out: MaskData;
    try {
      out = { data: m.getAsFloat32Array().slice(), w: m.width, h: m.height };
    } finally {
      m.close();
    }
    // Some GPU drivers hand back an empty mask; if an include stroke produced nothing, redo it
    // on the CPU (and stay there).
    if (this.subjectDelegate === 'GPU' && s.some((x) => x.brushMode === 1) && !out.data.some((v) => v > 0.02)) {
      console.warn('GPU segmenter returned an empty mask; switching to CPU');
      seg.close();
      this.forceCpu = true;
      this.subject = null;
      this.subjectKey = '';
      return this.subjectMask(image, key, strokes, progress);
    }
    return out;
  }

  /** People parts (union of the given selfie-multiclass categories). */
  async peopleMask(image: HTMLCanvasElement, key: string, cats: number[], progress: (f: number) => void): Promise<MaskData> {
    if (this.peopleCache?.key !== key) {
      const seg = await this.getPeople(progress);
      const r = seg.segment(image);
      try {
        const ms = r.confidenceMasks ?? [];
        if (!ms.length) throw new Error('No people found');
        this.peopleCache = { key, masks: ms.map((m) => m.getAsFloat32Array().slice()), w: ms[0].width, h: ms[0].height };
      } finally {
        r.close();
      }
    }
    const P = this.peopleCache!;
    const out = new Float32Array(P.w * P.h);
    for (const c of cats) {
      const m = P.masks[c];
      if (!m) continue;
      for (let i = 0; i < out.length; i++) out[i] += m[i];
    }
    let any = 0;
    for (let i = 0; i < out.length; i++) {
      out[i] = Math.min(1, out[i]);
      if (out[i] > 0.5) any++;
    }
    if (any < out.length * 0.002) throw new Error(cats.includes(0) ? 'Couldn’t find the background' : 'No people found in this photo');
    return { data: out, w: P.w, h: P.h };
  }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Snap a soft mask to the photo's edges (guided filter, grayscale guide). The models work
 * at low resolution; this pulls the mask onto hair, fabric and outlines at full mask size.
 */
export function refineMask(mask: MaskData, guide: Uint8ClampedArray | Uint8Array, w: number, h: number, r = 5, eps = 1e-3): Float32Array {
  // resample the mask to the guide's size
  const p = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = ((y + 0.5) / h) * mask.h - 0.5;
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(mask.h - 1, y0 + 1), ty = Math.min(1, Math.max(0, fy - y0));
    for (let x = 0; x < w; x++) {
      const fx = ((x + 0.5) / w) * mask.w - 0.5;
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(mask.w - 1, x0 + 1), tx = Math.min(1, Math.max(0, fx - x0));
      const a = mask.data[y0 * mask.w + x0] * (1 - tx) + mask.data[y0 * mask.w + x1] * tx;
      const b = mask.data[y1 * mask.w + x0] * (1 - tx) + mask.data[y1 * mask.w + x1] * tx;
      p[y * w + x] = a * (1 - ty) + b * ty;
    }
  }
  const I = new Float32Array(w * h);
  for (let i = 0; i < I.length; i++) {
    const o = i * 4;
    I[i] = (0.299 * guide[o] + 0.587 * guide[o + 1] + 0.114 * guide[o + 2]) / 255;
  }
  const box = (src: Float32Array) => boxFilter(src, w, h, r);
  const II = new Float32Array(w * h), Ip = new Float32Array(w * h);
  for (let i = 0; i < I.length; i++) {
    II[i] = I[i] * I[i];
    Ip[i] = I[i] * p[i];
  }
  const mI = box(I), mp = box(p), mII = box(II), mIp = box(Ip);
  const a = new Float32Array(w * h), b = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) {
    const v = mII[i] - mI[i] * mI[i];
    a[i] = (mIp[i] - mI[i] * mp[i]) / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = box(a), mb = box(b);
  const q = new Float32Array(w * h);
  for (let i = 0; i < q.length; i++) q[i] = Math.min(1, Math.max(0, ma[i] * I[i] + mb[i]));
  return q;
}

/** Mean over a (2r+1)² window, via a summed-area table. */
function boxFilter(src: Float32Array, w: number, h: number, r: number) {
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
      const sum = S[yb * (w + 1) + xb] - S[ya * (w + 1) + xb] - S[yb * (w + 1) + xa] + S[ya * (w + 1) + xa];
      out[y * w + x] = sum / ((yb - ya) * (xb - xa));
    }
  }
  return out;
}
