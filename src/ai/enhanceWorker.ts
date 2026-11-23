// AI upscale and denoise, in a worker: Real-ESRGAN "general x4v3" (a small 4× super-resolution
// network, BSD-3-Clause), converted to ONNX with its two weight sets (the usual one and the one
// that keeps more of the original texture) blended by a "denoise" input, as its authors' -dn
// option does. The photo is done in overlapping tiles so any size fits in memory.
//  * upscale 2× / 4×: the photo through the model (2× is the 4× result halved)
//  * denoise: half-size in, 4× out, halved again: the same size as the photo, rebuilt from a
//    copy where the noise has already been averaged down (a quarter of the work of full size)
import * as ort from 'onnxruntime-web/wasm';

let session: ort.InferenceSession | null = null;
const post = (m: unknown, t?: Transferable[]) => (self as unknown as Worker).postMessage(m, t ?? []);

/** each tile's own part, and the picture around it the model sees (its reach is ~34 px) */
const TILE = 192, PAD = 24;

/** Halve an RGBA image (2×2 averages). */
function halve(src: Uint8ClampedArray, w: number, h: number) {
  const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = ((2 * y) * w + 2 * x) * 4, b = a + w * 4;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = (src[a + c] + src[a + 4 + c] + src[b + c] + src[b + 4 + c] + 2) >> 2;
      out[o + 3] = 255;
    }
  }
  return { px: out, w: W, h: H };
}

async function run(rgba: Uint8ClampedArray, w0: number, h0: number, mode: 'denoise' | 'up2' | 'up4', dn: number) {
  if (!session) throw new Error('AI model not loaded');
  // what goes in, and how much of the model's 4× comes out (by averaging f×f blocks)
  const src = mode === 'denoise' ? halve(rgba, w0, h0) : { px: rgba, w: w0, h: h0 };
  const { w, h } = src;
  const f = mode === 'up4' ? 1 : 2;
  const S = 4 / f; // output scale against the input fed in
  const OW = w * S, OH = h * S;
  const out = new Uint8ClampedArray(OW * OH * 4);
  const cols = Math.ceil(w / TILE), rows = Math.ceil(h / TILE);
  const total = cols * rows;
  let done = 0;
  const t0 = performance.now();
  const dnT = new ort.Tensor('float32', Float32Array.of(dn), []);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      // this tile, and the padded box around it (mirrored at the photo's edges)
      const x0 = tx * TILE, y0 = ty * TILE, cw = Math.min(TILE, w - x0), ch = Math.min(TILE, h - y0);
      const bx = x0 - PAD, by = y0 - PAD, bw = cw + 2 * PAD, bh = ch + 2 * PAD;
      const n = bw * bh;
      const inp = new Float32Array(3 * n);
      const mirror = (v: number, m: number) => {
        if (m === 1) return 0;
        while (v < 0 || v >= m) v = v < 0 ? -v - 1 : 2 * m - v - 1;
        return v;
      };
      for (let y = 0; y < bh; y++) {
        const sy = mirror(by + y, h);
        for (let x = 0; x < bw; x++) {
          const s = (sy * w + mirror(bx + x, w)) * 4, i = y * bw + x;
          inp[i] = src.px[s] / 255;
          inp[n + i] = src.px[s + 1] / 255;
          inp[2 * n + i] = src.px[s + 2] / 255;
        }
      }
      const r = await session.run({ input: new ort.Tensor('float32', inp, [1, 3, bh, bw]), dn: dnT });
      const o = r[session.outputNames[0]].data as Float32Array;
      const ow = bw * 4, on = ow * bh * 4;
      // the tile's own part of the 4× result, f×f averaged, into place
      const ox = PAD * 4, oy = PAD * 4;
      const k = 1 / (f * f);
      for (let y = 0; y < ch * S; y++) {
        for (let x = 0; x < cw * S; x++) {
          let rr = 0, gg = 0, bb = 0;
          for (let j = 0; j < f; j++) {
            const row = (oy + y * f + j) * ow + ox + x * f;
            for (let i = 0; i < f; i++) {
              rr += o[row + i];
              gg += o[on + row + i];
              bb += o[2 * on + row + i];
            }
          }
          const d = ((y0 * S + y) * OW + x0 * S + x) * 4;
          out[d] = rr * k * 255 + 0.5;
          out[d + 1] = gg * k * 255 + 0.5;
          out[d + 2] = bb * k * 255 + 0.5;
          out[d + 3] = 255;
        }
      }
      done++;
      const el = performance.now() - t0;
      post({ progress: done / total, left: (el / done) * (total - done) });
    }
  }
  post({ log: `enhance ${mode} ${w}x${h} -> ${OW}x${OH} in ${Math.round(performance.now() - t0)} ms (${total} tiles)` });
  return { px: out, w: OW, h: OH };
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      ort.env.wasm.wasmPaths = { wasm: m.wasm, mjs: m.mjs };
      ort.env.wasm.numThreads = m.threads || 1;
      session = await ort.InferenceSession.create(new Uint8Array(m.bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      post({ ready: true });
    } else if (m.type === 'run') {
      const r = await run(m.rgba, m.w, m.h, m.mode, m.dn);
      post({ done: r }, [r.px.buffer]);
    }
  } catch (err) {
    post({ error: (err as Error).message || String(err) });
  }
};
