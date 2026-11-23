// Speech to text for captions, in a worker: Whisper tiny.en (OpenAI, MIT) as exported for ONNX by
// sherpa-onnx (an encoder, and a decoder that keeps its own attention cache), with the decoder's
// word table stored as 8-bit (30 MB instead of 90). The sound is first cut into phrases where the
// speaker pauses; each phrase is turned into Whisper's log-mel picture of the sound and read out
// word by word (greedy decoding).
import * as ort from 'onnxruntime-web/wasm';

let enc: ort.InferenceSession | null = null;
let dec: ort.InferenceSession | null = null;
let tokens: string[] = [];
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

// special tokens of the English-only tiny model
const SOT = 50257, EOT = 50256, BLANK = 220, NO_TS = 50362, NO_SPEECH = 50361, TRANSLATE = 50357;
const SR = 16000;
const LAYERS = 4, CTX = 448, STATE = 384;

// ---- log-mel, as Whisper computes it: 25 ms Hann windows every 10 ms (centred), power
// spectrum, 80 Slaney mel bands to 8 kHz, log10, at most 8 decades of range, scaled to ~±1

let melW: Float32Array | null = null;
function melFilters() {
  if (melW) return melW;
  const lin = 1000, mlin = lin / (200 / 3), ls = Math.log(6.4) / 27;
  const hz2mel = (f: number) => (f >= lin ? mlin + Math.log(f / lin) / ls : f / (200 / 3));
  const mel2hz = (m: number) => (m >= mlin ? lin * Math.exp(ls * (m - mlin)) : m * (200 / 3));
  const pts = Array.from({ length: 82 }, (_, i) => mel2hz(hz2mel(0) + ((hz2mel(8000) - hz2mel(0)) * i) / 81));
  const W = new Float32Array(80 * 201);
  for (let i = 0; i < 80; i++) {
    const norm = 2 / (pts[i + 2] - pts[i]);
    for (let k = 0; k < 201; k++) {
      const f = (8000 * k) / 200;
      const lo = (f - pts[i]) / (pts[i + 1] - pts[i]), hi = (pts[i + 2] - f) / (pts[i + 2] - pts[i + 1]);
      W[i * 201 + k] = Math.max(0, Math.min(lo, hi)) * norm;
    }
  }
  return (melW = W);
}

let dft: { c: Float32Array; s: Float32Array; win: Float32Array } | null = null;
function dftTables() {
  if (dft) return dft;
  const c = new Float32Array(201 * 400), s = new Float32Array(201 * 400), win = new Float32Array(400);
  for (let n = 0; n < 400; n++) win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / 400);
  for (let k = 0; k < 201; k++) for (let n = 0; n < 400; n++) {
    const a = (2 * Math.PI * k * n) / 400;
    c[k * 400 + n] = Math.cos(a);
    s[k * 400 + n] = Math.sin(a);
  }
  return (dft = { c, s, win });
}

/** [80, frames] log-mel of the sound, frames = len / 160 (+1500 frames of silence after: the model needs room to end) */
function logMel(x: Float32Array) {
  const { c, s, win } = dftTables(), W = melFilters();
  const n = Math.floor(x.length / 160);
  const PADF = 1500, T = n + PADF;
  const out = new Float32Array(80 * T);
  const fr = new Float32Array(400), pw = new Float32Array(201);
  const at = (i: number) => {
    // reflect at the ends, like torch.stft(center=True)
    const L = x.length;
    if (i < 0) i = -i;
    if (i >= L) i = 2 * L - i - 2;
    return x[Math.max(0, Math.min(L - 1, i))];
  };
  let mx = -Infinity;
  for (let t = 0; t < n; t++) {
    const o = t * 160 - 200;
    for (let j = 0; j < 400; j++) fr[j] = at(o + j) * win[j];
    for (let k = 0; k < 201; k++) {
      let re = 0, im = 0;
      const b = k * 400;
      for (let j = 0; j < 400; j++) {
        re += fr[j] * c[b + j];
        im -= fr[j] * s[b + j];
      }
      pw[k] = re * re + im * im;
    }
    for (let m = 0; m < 80; m++) {
      let e = 0;
      for (let k = 0; k < 201; k++) e += W[m * 201 + k] * pw[k];
      const l = Math.log10(Math.max(e, 1e-10));
      out[m * T + t] = l;
      if (l > mx) mx = l;
    }
  }
  for (let m = 0; m < 80; m++) {
    for (let t = 0; t < n; t++) out[m * T + t] = (Math.max(out[m * T + t], mx - 8) + 4) / 4;
    // the silence after: what log(0) becomes once clamped and scaled
    for (let t = n; t < T; t++) out[m * T + t] = 0;
  }
  return { mel: out, T };
}

// ---- phrases: where the sound is loud enough to be speech, split at the pauses

interface Phrase { a: number; b: number }

function phrases(x: Float32Array): Phrase[] {
  const F = 320; // 20 ms
  const n = Math.floor(x.length / F);
  if (!n) return [];
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = 0; j < F; j++) e += x[i * F + j] ** 2;
    db[i] = 10 * Math.log10(e / F + 1e-10);
  }
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(n * 0.1)], peak = sorted[Math.floor(n * 0.99)];
  const thr = Math.max(floor + 10, peak - 40, -55);
  // speech frames, with a short hold after each so word gaps don't break a phrase
  const on = new Uint8Array(n);
  let hold = 0;
  for (let i = 0; i < n; i++) {
    if (db[i] > thr) hold = 12;
    if (hold > 0) (on[i] = 1), hold--;
  }
  const out: Phrase[] = [];
  for (let i = 0; i < n;) {
    if (!on[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && on[j]) j++;
    out.push({ a: i, b: j });
    i = j;
  }
  // close gaps under 0.3 s, drop blips under 0.25 s
  const merged: Phrase[] = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && p.a - last.b < 15) last.b = p.b;
    else merged.push({ ...p });
  }
  const long: Phrase[] = [];
  for (const p of merged.filter((p) => p.b - p.a >= 12)) {
    // longer than 9 s: cut at the quietest moment between 4 and 9 s in, again and again
    let a = p.a;
    while (p.b - a > 450) {
      let cut = a + 200, low = Infinity;
      for (let i = a + 200; i < a + 450; i++) {
        let s = 0;
        for (let k = -5; k <= 5; k++) s += db[Math.min(n - 1, Math.max(0, i + k))];
        if (s < low) (low = s), (cut = i);
      }
      long.push({ a, b: cut });
      a = cut;
    }
    long.push({ a, b: p.b });
  }
  // a little room either side, in seconds
  return long.map((p) => ({ a: Math.max(0, (p.a * F) / SR - 0.15), b: Math.min(x.length / SR, (p.b * F) / SR + 0.15) }));
}

// ---- reading a phrase

function argmax(a: Float32Array, from: number, len: number) {
  let b = 0, bv = -Infinity;
  for (let i = 0; i < len; i++) if (a[from + i] > bv) (bv = a[from + i]), (b = i);
  return b;
}

const decodeTok = (() => {
  const td = new TextDecoder();
  return (ids: number[]) => {
    const bytes: number[] = [];
    for (const id of ids) {
      const b64 = tokens[id];
      if (!b64) continue;
      const s = atob(b64);
      for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
    }
    return td.decode(new Uint8Array(bytes));
  };
})();

async function read(x: Float32Array) {
  const { mel, T } = logMel(x);
  const eo = await enc!.run({ [enc!.inputNames[0]]: new ort.Tensor('float32', mel, [1, 80, T]) });
  const ck = eo[enc!.outputNames[0]], cv = eo[enc!.outputNames[1]];
  let sk: ort.Tensor = new ort.Tensor('float32', new Float32Array(LAYERS * CTX * STATE), [LAYERS, 1, CTX, STATE]);
  let sv: ort.Tensor = new ort.Tensor('float32', new Float32Array(LAYERS * CTX * STATE), [LAYERS, 1, CTX, STATE]);
  const names = dec!.inputNames;
  const step = async (toks: number[], off: number) => {
    const r = await dec!.run({
      [names[0]]: new ort.Tensor('int64', BigInt64Array.from(toks.map(BigInt)), [1, toks.length]),
      [names[1]]: sk, [names[2]]: sv, [names[3]]: ck, [names[4]]: cv,
      [names[5]]: new ort.Tensor('int64', BigInt64Array.of(BigInt(off)), [1]),
    });
    sk = r[dec!.outputNames[1]];
    sv = r[dec!.outputNames[2]];
    const lg = r[dec!.outputNames[0]];
    const V = lg.dims[2];
    return { data: lg.data as Float32Array, from: (lg.dims[1] - 1) * V, V };
  };
  const sot = [SOT, NO_TS];
  let lg = await step(sot, 0);
  let off = sot.length;
  const out: number[] = [];
  // at most ~4 tokens a second of sound (a stuck model repeats itself forever otherwise)
  const max = Math.min(CTX - 8, 12 + Math.ceil((x.length / SR) * 5));
  for (let i = 0; i < max; i++) {
    const L = lg.data;
    for (const t of [NO_TS, SOT, NO_SPEECH, TRANSLATE]) L[lg.from + t] = -Infinity;
    if (i === 0) L[lg.from + EOT] = L[lg.from + BLANK] = -Infinity;
    const t = argmax(L, lg.from, lg.V);
    if (t === EOT) break;
    out.push(t);
    // the same 4+ tokens three times over: it's looping
    const k = out.length;
    if (k >= 12) {
      for (let w = 4; w <= Math.floor(k / 3); w++) {
        const a = out.slice(k - w).join(), b = out.slice(k - 2 * w, k - w).join(), c = out.slice(k - 3 * w, k - 2 * w).join();
        if (a === b && b === c) {
          out.length = k - 2 * w;
          i = max;
          break;
        }
      }
      if (i === max) break;
    }
    lg = await step([t], off++);
  }
  return decodeTok(out).replace(/\s+/g, ' ').trim();
}

/** Not words: Whisper's notes on the sound ("[Music]", "(laughs)") and dots on their own. */
const notSpeech = (s: string) => !s || /^[\s.…,!?-]*$/.test(s) || /^[[(♪*].*[\])♪*]$/.test(s);

async function transcribe(x: Float32Array) {
  const ps = phrases(x);
  const out: { start: number; end: number; text: string }[] = [];
  const t0 = performance.now();
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const text = await read(x.subarray(Math.floor(p.a * SR), Math.ceil(p.b * SR)));
    if (!notSpeech(text)) out.push({ start: p.a, end: p.b, text });
    const el = performance.now() - t0;
    post({ progress: (i + 1) / ps.length, left: (el / (i + 1)) * (ps.length - i - 1) });
  }
  return out;
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      ort.env.wasm.wasmPaths = { wasm: m.wasm, mjs: m.mjs };
      ort.env.wasm.numThreads = m.threads || 1;
      const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' } as const;
      enc = await ort.InferenceSession.create(new Uint8Array(m.enc), opt);
      dec = await ort.InferenceSession.create(new Uint8Array(m.dec), opt);
      tokens = [];
      for (const line of (m.tokens as string).split('\n')) {
        const [b64, id] = line.trim().split(/\s+/);
        if (id !== undefined) tokens[+id] = b64;
      }
      post({ ready: true });
    } else if (m.type === 'run') {
      post({ done: await transcribe(m.pcm) });
    }
  } catch (err) {
    post({ error: (err as Error).message || String(err) });
  }
};
