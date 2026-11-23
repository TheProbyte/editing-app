// Beats in a song, for cutting to the music: an onset-strength curve (how much the sound's
// spectrum jumps, band by band), its tempo (the lag where the curve repeats best, preferring
// 80–160 BPM), then the beat grid that lines up with the strongest onsets at that tempo
// (dynamic programming, as in Ellis 2007), so beats stay on the music even where it's quiet.

export interface Beats {
  /** beats per minute */
  bpm: number;
  /** beat times in seconds from the start of the sound given */
  times: number[];
  /** each beat's strength 0..1 (the downbeats of a bar tend to be the strong ones) */
  strength: number[];
}

const HOP = 512, WIN = 1024;

/** Onset strength per hop (spectral flux over log-magnitude, a few bands summed). */
function onsets(x: Float32Array, sr: number) {
  const n = Math.max(0, Math.floor((x.length - WIN) / HOP) + 1);
  const out = new Float32Array(n);
  // a small real FFT
  const re = new Float32Array(WIN), im = new Float32Array(WIN);
  const win = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);
  const bins = WIN / 2;
  // ~40 log-spaced bands from 30 Hz to 8 kHz
  const NB = 40;
  const edges = Array.from({ length: NB + 1 }, (_, i) => Math.min(bins, Math.max(1, Math.round((30 * Math.pow(8000 / 30, i / NB) * WIN) / sr))));
  let prev = new Float32Array(NB);
  for (let f = 0; f < n; f++) {
    const o = f * HOP;
    for (let i = 0; i < WIN; i++) {
      re[i] = x[o + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const cur = new Float32Array(NB);
    for (let b = 0; b < NB; b++) {
      let s = 0;
      for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) s += re[k] * re[k] + im[k] * im[k];
      cur[b] = Math.log(1 + 100 * Math.sqrt(s));
    }
    let flux = 0;
    for (let b = 0; b < NB; b++) flux += Math.max(0, cur[b] - prev[b]);
    out[f] = f ? flux : 0;
    prev = cur;
  }
  // take away the slowly moving level, keep what stands out
  const m = movingMean(out, Math.round((0.5 * sr) / HOP));
  for (let i = 0; i < n; i++) out[i] = Math.max(0, out[i] - m[i]);
  let sd = 0;
  for (let i = 0; i < n; i++) sd += out[i] * out[i];
  sd = Math.sqrt(sd / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

function movingMean(a: Float32Array, r: number) {
  const out = new Float32Array(a.length);
  let s = 0, c = 0;
  for (let i = 0; i < Math.min(a.length, r); i++) (s += a[i]), c++;
  for (let i = 0; i < a.length; i++) {
    if (i + r < a.length) (s += a[i + r]), c++;
    if (i - r - 1 >= 0) (s -= a[i - r - 1]), c--;
    out[i] = s / Math.max(1, c);
  }
  return out;
}

/** In-place radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** The beat period (in hops) from the onset curve's autocorrelation, weighted toward ~120 BPM. */
function tempo(env: Float32Array, fps: number) {
  const lo = Math.floor((fps * 60) / 200), hi = Math.ceil((fps * 60) / 60);
  let best = 0, bestLag = Math.round((fps * 60) / 120);
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    s /= env.length - lag;
    // a log-normal preference around 120 BPM (people tap there), so double / half tempo don't win
    const bpm = (60 * fps) / lag;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (s * w > best) (best = s * w), (bestLag = lag);
  }
  // refine to a fraction of a hop (parabola through the neighbours)
  const at = (lag: number) => {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    return s / Math.max(1, env.length - lag);
  };
  const a = at(bestLag - 1), b = at(bestLag), c = at(bestLag + 1);
  const d = a - 2 * b + c;
  return bestLag + (d < 0 ? (0.5 * (a - c)) / d : 0);
}

/** Beats of a sound (mono or the first channels mixed), from `from` to `to` seconds. */
export function findBeats(chans: Float32Array[], sr: number, from = 0, to = Infinity): Beats {
  const a = Math.max(0, Math.floor(from * sr)), b = Math.min(chans[0].length, Math.floor(Math.min(to, chans[0].length / sr) * sr));
  const x = new Float32Array(Math.max(0, b - a));
  for (const c of chans) for (let i = 0; i < x.length; i++) x[i] += c[a + i] / chans.length;
  const env = onsets(x, sr);
  const fps = sr / HOP;
  if (env.length < fps * 2) return { bpm: 0, times: [], strength: [] };
  const period = tempo(env, fps);
  // dynamic programming: each frame's best score = its onset + the best earlier beat about one
  // period back (penalised for straying from the period)
  const n = env.length, score = new Float32Array(n), back = new Int32Array(n).fill(-1);
  const tight = 100;
  for (let i = 0; i < n; i++) {
    let best = 0, from2 = -1;
    const lo = Math.max(0, Math.round(i - 2 * period)), hi = i - Math.round(period / 2);
    for (let j = lo; j <= hi; j++) {
      const s = score[j] - tight * Math.log((i - j) / period) ** 2;
      if (s > best) (best = s), (from2 = j);
    }
    score[i] = env[i] + best;
    back[i] = from2;
  }
  // the best last beat within the final period, then back through the chain
  let end = n - 1;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i] > score[end]) end = i;
  const idx: number[] = [];
  for (let i = end; i >= 0; i = back[i]) idx.push(i);
  idx.reverse();
  // a frame's sound starts half a window in; times are from `from`
  const times = idx.map((i) => (i * HOP + WIN / 2) / sr);
  let mx = 1e-6;
  for (const i of idx) mx = Math.max(mx, env[i]);
  return { bpm: Math.round(((60 * fps) / period) * 10) / 10, times, strength: idx.map((i) => Math.min(1, env[i] / mx)) };
}
