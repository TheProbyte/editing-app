// Neural object removal, run with ONNX Runtime Web.
//  * LaMa (big-lama, Apache-2.0): float image 0..1 + float mask (1 = fill), fixed 512x512, output
//    0..255. Large-mask inpainting with Fourier convolutions — the best quality, 208 MB, downloaded
//    once on request.
//  * MI-GAN (Picsart AI Research, MIT): the small "pipeline" model that ships with the app: uint8
//    image + uint8 mask (255 = keep, 0 = fill), any size.
// Both get a crop around the hole (with context) and the result is pasted back with a soft edge.
import * as ort from 'onnxruntime-web/wasm';
import { dilate, featherAlpha } from './inpaint';

type Kind = 'lama' | 'migan';
let session: ort.InferenceSession | null = null;
let kind: Kind = 'migan';
const post = (m: unknown, t?: Transferable[]) => (self as unknown as Worker).postMessage(m, t ?? []);

/** Bilinear resize of an RGBA buffer. */
function resizeRGBA(src: Uint8ClampedArray | Uint8Array, w: number, h: number, nw: number, nh: number) {
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / nh - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / nw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * w + x0) * 4 + c] * (1 - tx) + src[(y0 * w + x1) * 4 + c] * tx;
        const b = src[(y1 * w + x0) * 4 + c] * (1 - tx) + src[(y1 * w + x1) * 4 + c] * tx;
        out[(y * nw + x) * 4 + c] = a * (1 - ty) + b * ty;
      }
    }
  }
  return out;
}

/** Resize a 0/1 mask: a pixel is hole if any source pixel it covers was (so the hole never shrinks). */
function resizeMask(src: Uint8Array, w: number, h: number, nw: number, nh: number) {
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.min(h - 1, Math.floor((y * h) / nh)), sy1 = Math.min(h, Math.max(sy0 + 1, Math.ceil(((y + 1) * h) / nh)));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.min(w - 1, Math.floor((x * w) / nw)), sx1 = Math.min(w, Math.max(sx0 + 1, Math.ceil(((x + 1) * w) / nw)));
      let hit = 0;
      for (let yy = sy0; yy < sy1 && !hit; yy++) for (let xx = sx0; xx < sx1; xx++) if (src[yy * w + xx]) { hit = 1; break; }
      out[y * nw + x] = hit;
    }
  }
  return out;
}

interface Roi {
  x0: number;
  y0: number;
  rw: number;
  rh: number;
  img: Uint8ClampedArray;
  mask: Uint8Array;
}

function crop(rgba: Uint8ClampedArray, grown: Uint8Array, w: number, x0: number, y0: number, rw: number, rh: number): Roi {
  const img = new Uint8ClampedArray(rw * rh * 4);
  const mask = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    const si = (y0 + y) * w + x0;
    img.set(rgba.subarray(si * 4, (si + rw) * 4), y * rw * 4);
    mask.set(grown.subarray(si, si + rw), y * rw);
  }
  return { x0, y0, rw, rh, img, mask };
}

/** Paste the filled crop back: new pixels inside the hole, a soft edge around it. */
function paste(out: Uint8ClampedArray, w: number, roi: Roi, filled: Uint8ClampedArray, original: Uint8ClampedArray) {
  const alpha = featherAlpha(roi.mask, roi.rw, roi.rh);
  for (let y = 0; y < roi.rh; y++) {
    for (let x = 0; x < roi.rw; x++) {
      const li = y * roi.rw + x;
      if (!roi.mask[li] && alpha[li] <= 0.001) continue;
      const gi = (roi.y0 + y) * w + roi.x0 + x;
      for (let c = 0; c < 3; c++) out[gi * 4 + c] = roi.mask[li] ? filled[li * 4 + c] : original[gi * 4 + c];
      out[gi * 4 + 3] = Math.round(Math.min(1, alpha[li]) * 255);
    }
  }
}

function holeBox(grown: Uint8Array, w: number, h: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grown[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

async function runMigan(rgba: Uint8ClampedArray, w: number, h: number, grown: Uint8Array, box: NonNullable<ReturnType<typeof holeBox>>) {
  // plenty of surroundings for the network to learn the scene from
  const m = Math.max(64, Math.round(Math.max(box.x1 - box.x0, box.y1 - box.y0) * 0.9));
  const x0 = Math.max(0, box.x0 - m), y0 = Math.max(0, box.y0 - m);
  const x1 = Math.min(w - 1, box.x1 + m), y1 = Math.min(h - 1, box.y1 + m);
  const roi = crop(rgba, grown, w, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  const k = Math.min(1, 1100 / Math.max(roi.rw, roi.rh));
  const pw = Math.max(32, Math.round(roi.rw * k)), ph = Math.max(32, Math.round(roi.rh * k));
  const img = k < 1 ? resizeRGBA(roi.img, roi.rw, roi.rh, pw, ph) : roi.img;
  const msk = k < 1 ? resizeMask(roi.mask, roi.rw, roi.rh, pw, ph) : roi.mask;
  const n = pw * ph;
  const chw = new Uint8Array(3 * n), known = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    chw[i] = img[i * 4];
    chw[n + i] = img[i * 4 + 1];
    chw[2 * n + i] = img[i * 4 + 2];
    known[i] = msk[i] ? 0 : 255; // MI-GAN wants 255 = keep, 0 = fill
  }
  const res = await session!.run({ image: new ort.Tensor('uint8', chw, [1, 3, ph, pw]), mask: new ort.Tensor('uint8', known, [1, 1, ph, pw]) });
  const t = res[session!.outputNames[0]];
  const d = t.data as Uint8Array;
  const [, , oh, ow] = t.dims as number[];
  const outp = new Uint8ClampedArray(ow * oh * 4);
  for (let i = 0; i < ow * oh; i++) {
    outp[i * 4] = d[i];
    outp[i * 4 + 1] = d[ow * oh + i];
    outp[i * 4 + 2] = d[2 * ow * oh + i];
    outp[i * 4 + 3] = 255;
  }
  return { roi, filled: ow === roi.rw && oh === roi.rh ? outp : resizeRGBA(outp, ow, oh, roi.rw, roi.rh) };
}

const LAMA = 512;

async function runLama(rgba: Uint8ClampedArray, w: number, h: number, grown: Uint8Array, box: NonNullable<ReturnType<typeof holeBox>>) {
  // a square window around the hole with room around it, run at LaMa's fixed 512x512
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  let side = Math.round(Math.max(bw, bh) * 2.4);
  side = Math.min(Math.min(w, h), Math.max(side, Math.min(LAMA, Math.min(w, h))));
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const x0 = Math.min(w - side, Math.max(0, Math.round(cx - side / 2)));
  const y0 = Math.min(h - side, Math.max(0, Math.round(cy - side / 2)));
  const roi = crop(rgba, grown, w, x0, y0, side, side);
  const img = side === LAMA ? roi.img : resizeRGBA(roi.img, side, side, LAMA, LAMA);
  const msk = side === LAMA ? roi.mask : resizeMask(roi.mask, side, side, LAMA, LAMA);
  const n = LAMA * LAMA;
  const chw = new Float32Array(3 * n), mk = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    chw[i] = img[i * 4] / 255;
    chw[n + i] = img[i * 4 + 1] / 255;
    chw[2 * n + i] = img[i * 4 + 2] / 255;
    mk[i] = msk[i] ? 1 : 0; // LaMa: 1 = fill
  }
  const res = await session!.run({ image: new ort.Tensor('float32', chw, [1, 3, LAMA, LAMA]), mask: new ort.Tensor('float32', mk, [1, 1, LAMA, LAMA]) });
  const d = res[session!.outputNames[0]].data as Float32Array;
  // the exported model returns 0..255; accept 0..1 too
  let mx = 0;
  for (let i = 0; i < d.length; i += 97) mx = Math.max(mx, d[i]);
  const s = mx <= 1.5 ? 255 : 1;
  const outp = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    outp[i * 4] = d[i] * s;
    outp[i * 4 + 1] = d[n + i] * s;
    outp[i * 4 + 2] = d[2 * n + i] * s;
    outp[i * 4 + 3] = 255;
  }
  return { roi, filled: side === LAMA ? outp : resizeRGBA(outp, LAMA, LAMA, side, side) };
}

async function run(rgba: Uint8ClampedArray, w: number, h: number, mask: Uint8Array) {
  if (!session) throw new Error('Model not loaded');
  const grown = dilate(mask, w, h, 3);
  const box = holeBox(grown, w, h);
  const out = new Uint8ClampedArray(w * h * 4);
  if (!box) return out;
  const r = kind === 'lama' ? await runLama(rgba, w, h, grown, box) : await runMigan(rgba, w, h, grown, box);
  paste(out, w, r.roi, r.filled, rgba);
  return out;
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      kind = m.kind;
      ort.env.wasm.wasmPaths = { wasm: m.wasm, mjs: m.mjs };
      ort.env.wasm.numThreads = m.threads || 1;
      post({ log: `starting ${kind} (${ort.env.wasm.numThreads} threads, isolated=${self.crossOriginIsolated})` });
      const t0 = performance.now();
      session = await ort.InferenceSession.create(new Uint8Array(m.bytes), { executionProviders: ['wasm'], graphOptimizationLevel: m.kind === 'lama' ? 'basic' : 'all' });
      post({ log: `${kind} ready in ${Math.round(performance.now() - t0)} ms` });
      post({ ready: true });
    } else if (m.type === 'run') {
      const t0 = performance.now();
      const out = await run(m.rgba, m.w, m.h, m.mask);
      post({ log: `${kind} fill ran in ${Math.round(performance.now() - t0)} ms` });
      post({ done: out }, [out.buffer]);
    }
  } catch (err) {
    post({ error: (err as Error).message || String(err) });
  }
};
