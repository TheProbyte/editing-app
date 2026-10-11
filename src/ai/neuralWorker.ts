// Runs the MI-GAN inpainting network (Picsart AI Research, MIT) with ONNX Runtime Web.
// The "pipeline" model takes any-size uint8 image + mask (255 = keep, 0 = fill) and returns the
// image with the hole rebuilt. We hand it a crop around the hole (with context) and paste the
// result back with a soft edge.
import * as ort from 'onnxruntime-web/wasm';
import { dilate, featherAlpha } from './inpaint';

let session: ort.InferenceSession | null = null;
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

async function run(rgba: Uint8ClampedArray, w: number, h: number, mask: Uint8Array) {
  if (!session) throw new Error('Model not loaded');
  const grown = dilate(mask, w, h, 3);
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
  const out = new Uint8ClampedArray(w * h * 4);
  if (x1 < 0) return out;
  // plenty of surroundings for the network to learn the scene from
  const m = Math.max(64, Math.round(Math.max(x1 - x0, y1 - y0) * 0.9));
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m);
  y1 = Math.min(h - 1, y1 + m);
  const rw = x1 - x0 + 1, rh = y1 - y0 + 1;

  // the crop, at a size the phone can handle
  const roi = new Uint8ClampedArray(rw * rh * 4);
  const rmask = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const si = (y0 + y) * w + x0 + x, o = y * rw + x;
      roi.set(rgba.subarray(si * 4, si * 4 + 4), o * 4);
      rmask[o] = grown[si];
    }
  }
  const k = Math.min(1, 1100 / Math.max(rw, rh));
  const pw = Math.max(32, Math.round(rw * k)), ph = Math.max(32, Math.round(rh * k));
  const img = k < 1 ? resizeRGBA(roi, rw, rh, pw, ph) : roi;
  const msk = new Uint8Array(pw * ph);
  if (k < 1) {
    // a pixel is hole if any of the source pixels it covers was
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const sx0 = Math.floor((x * rw) / pw), sx1 = Math.max(sx0 + 1, Math.ceil(((x + 1) * rw) / pw));
        const sy0 = Math.floor((y * rh) / ph), sy1 = Math.max(sy0 + 1, Math.ceil(((y + 1) * rh) / ph));
        let hit = 0;
        for (let yy = sy0; yy < Math.min(rh, sy1) && !hit; yy++) for (let xx = sx0; xx < Math.min(rw, sx1); xx++) if (rmask[yy * rw + xx]) { hit = 1; break; }
        msk[y * pw + x] = hit;
      }
    }
  } else msk.set(rmask);

  const chw = new Uint8Array(3 * pw * ph);
  const known = new Uint8Array(pw * ph);
  for (let i = 0; i < pw * ph; i++) {
    chw[i] = img[i * 4];
    chw[pw * ph + i] = img[i * 4 + 1];
    chw[2 * pw * ph + i] = img[i * 4 + 2];
    known[i] = msk[i] ? 0 : 255; // the network wants 255 = keep, 0 = fill
  }
  const res = await session.run({
    image: new ort.Tensor('uint8', chw, [1, 3, ph, pw]),
    mask: new ort.Tensor('uint8', known, [1, 1, ph, pw]),
  });
  const t = res[session.outputNames[0]];
  const d = t.data as Uint8Array;
  const [, , oh, ow] = t.dims as number[];
  // result as RGBA at the crop's working size
  const outp = new Uint8ClampedArray(ow * oh * 4);
  for (let i = 0; i < ow * oh; i++) {
    outp[i * 4] = d[i];
    outp[i * 4 + 1] = d[ow * oh + i];
    outp[i * 4 + 2] = d[2 * ow * oh + i];
    outp[i * 4 + 3] = 255;
  }
  const full = ow === rw && oh === rh ? outp : resizeRGBA(outp, ow, oh, rw, rh);

  const alpha = featherAlpha(grown, w, h);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const gi = (y0 + y) * w + x0 + x;
      if (!grown[gi] && alpha[gi] <= 0.001) continue;
      for (let c = 0; c < 3; c++) out[gi * 4 + c] = grown[gi] ? full[(y * rw + x) * 4 + c] : rgba[gi * 4 + c];
      out[gi * 4 + 3] = Math.round(Math.min(1, alpha[gi]) * 255);
    }
  }
  return out;
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      ort.env.wasm.wasmPaths = { wasm: m.wasm, mjs: m.mjs };
      // one thread: multi-threaded start-up can hang in some WebViews, and a single thread is plenty here
      ort.env.wasm.numThreads = m.threads || 1;
      post({ log: `starting AI model (${ort.env.wasm.numThreads} threads, isolated=${self.crossOriginIsolated})` });
      const t0 = performance.now();
      session = await ort.InferenceSession.create(new Uint8Array(m.bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      post({ log: `AI model ready in ${Math.round(performance.now() - t0)} ms, ${ort.env.wasm.numThreads} threads` });
      post({ ready: true });
    } else if (m.type === 'run') {
      const t0 = performance.now();
      const out = await run(m.rgba, m.w, m.h, m.mask);
      post({ log: `AI fill ran in ${Math.round(performance.now() - t0)} ms` });
      post({ done: out }, [out.buffer]);
    }
  } catch (err) {
    post({ error: (err as Error).message || String(err) });
  }
};
