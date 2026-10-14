// Depth from one photo, for the lens blur: Depth Anything V2 (small, Apache-2.0), run with ONNX
// Runtime Web. It gives relative inverse depth (bigger = nearer) at about 518 px; that's
// normalized to 0..1 and then sharpened against the photo with a guided filter, so the edges of
// the depth follow the edges in the picture (hair, outlines) instead of the model's soft blobs.
import * as ort from 'onnxruntime-web/wasm';

let session: ort.InferenceSession | null = null;
const post = (m: unknown, t?: Transferable[]) => (self as unknown as Worker).postMessage(m, t ?? []);

/** The model's input size: short side 518, both sides multiples of 14 (its patch size). */
function inputSize(w: number, h: number) {
  const s = 518 / Math.min(w, h);
  const m14 = (x: number) => Math.max(14, Math.round(x / 14) * 14);
  let iw = m14(w * s), ih = m14(h * s);
  // very long panoramas: cap the long side (time grows fast with size)
  const cap = 812;
  if (Math.max(iw, ih) > cap) {
    const k = cap / Math.max(iw, ih);
    iw = m14(iw * k);
    ih = m14(ih * k);
  }
  return { iw, ih };
}

/** Bilinear sample of a float image. */
function resizeF(src: Float32Array, w: number, h: number, nw: number, nh: number) {
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / nh - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / nw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * w + x0] * (1 - tx) + src[y0 * w + x1] * tx;
      const b = src[y1 * w + x0] * (1 - tx) + src[y1 * w + x1] * tx;
      out[y * nw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** Mean over a (2r+1)² box (clamped at the edges), with running sums: O(pixels). */
function boxMean(src: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  const n = (2 * r + 1) * (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** He et al.'s guided filter: `p` smoothed so its edges follow the edges of guide `I`. */
function guided(I: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number) {
  const N = w * h;
  const mI = boxMean(I, w, h, r), mP = boxMean(p, w, h, r);
  const II = new Float32Array(N), IP = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    II[i] = I[i] * I[i];
    IP[i] = I[i] * p[i];
  }
  const mII = boxMean(II, w, h, r), mIP = boxMean(IP, w, h, r);
  const a = new Float32Array(N), b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = mII[i] - mI[i] * mI[i];
    a[i] = (mIP[i] - mI[i] * mP[i]) / (v + eps);
    b[i] = mP[i] - a[i] * mI[i];
  }
  const mA = boxMean(a, w, h, r), mB = boxMean(b, w, h, r);
  const q = new Float32Array(N);
  for (let i = 0; i < N; i++) q[i] = Math.min(1, Math.max(0, mA[i] * I[i] + mB[i]));
  return q;
}

async function estimate(rgba: Uint8ClampedArray, w: number, h: number) {
  if (!session) throw new Error('Depth model not loaded');
  const { iw, ih } = inputSize(w, h);
  // the photo at the model's size, normalized the way the model was trained (ImageNet)
  const n = iw * ih;
  const chw = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) ch[i] = rgba[i * 4 + c] / 255;
    const r = resizeF(ch, w, h, iw, ih);
    for (let i = 0; i < n; i++) chw[c * n + i] = (r[i] - mean[c]) / std[c];
  }
  const inName = session.inputNames[0];
  const t0 = performance.now();
  const res = await session.run({ [inName]: new ort.Tensor('float32', chw, [1, 3, ih, iw]) });
  const out = res[session.outputNames[0]];
  const dims = out.dims;
  const oh = dims[dims.length - 2], ow = dims[dims.length - 1];
  const raw = out.data as Float32Array;
  post({ log: `depth ${iw}x${ih} in ${Math.round(performance.now() - t0)} ms` });
  // normalize: the 1st..99th percentile to 0..1 (a few stray values don't squash the rest)
  const sorted = Float32Array.from(raw.filter((_, i) => i % 7 === 0)).sort();
  const lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.floor(sorted.length * 0.99)];
  const span = Math.max(1e-6, hi - lo);
  const d = new Float32Array(ow * oh);
  for (let i = 0; i < d.length; i++) d[i] = Math.min(1, Math.max(0, (raw[i] - lo) / span));
  // up to the guide size, then snap to the photo's edges
  const up = resizeF(d, ow, oh, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) / 255;
  const r = Math.max(2, Math.round(Math.max(w, h) / 160));
  const q = guided(gray, up, w, h, r, 1.5e-3);
  // a second, finer pass tightens the edges further without bringing back the blockiness
  return guided(gray, q, w, h, Math.max(1, r >> 1), 8e-4);
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      ort.env.wasm.wasmPaths = { wasm: m.wasm, mjs: m.mjs };
      ort.env.wasm.numThreads = m.threads || 1;
      const t0 = performance.now();
      session = await ort.InferenceSession.create(new Uint8Array(m.bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      post({ log: `depth model ready in ${Math.round(performance.now() - t0)} ms (${ort.env.wasm.numThreads} threads)` });
      post({ ready: true });
    } else if (m.type === 'run') {
      const out = await estimate(m.rgba, m.w, m.h);
      post({ done: out }, [out.buffer]);
    }
  } catch (err) {
    post({ error: (err as Error).message || String(err) });
  }
};
