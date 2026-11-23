// Sound for the video editor. Only the parts of each file the timeline uses are decoded (a
// long recording trimmed to a few seconds holds just those seconds), and the whole timeline
// (clips at their speed and volume, the music with its fades) is mixed offline into a single
// track. Playback then plays that one track (nothing to schedule while playing, so nothing can
// drop out), and export uses the very same mix.
import { AudioBufferSink } from 'mediabunny';
import type { Media, MediaLib } from './media';
import { clipLen, layout, speedAt, srcAt, type VideoProject } from './project';

export const MIX_RATE = 48000;
/** a short ramp at every cut, so clips don't click against each other */
const EDGE = 0.004;
/** decoded either side of the part a clip uses (a decoder takes up to ~0.5 s to settle after a jump) */
const PAD = 1;
/** and a few seconds more around a new piece, so a small trim doesn't decode it again */
const SLACK = 5;
/** parts of one file closer than this are decoded as one piece (the halves of a split…) */
const JOIN = 10;

/** Decoded sound of part of a file: `buf` starts at file time `at`; its first `len` seconds are sound. */
interface Piece {
  at: number;
  len: number;
  buf: AudioBuffer;
}
/** A piece (being) decoded for file times lo…hi. */
interface Part {
  lo: number;
  hi: number;
  p: Promise<Piece | null>;
}

export class AudioEngine {
  /** the decoded pieces of each file the last mix used */
  private parts = new Map<string, Part[]>();
  private mixKey = '';
  private mixP: Promise<AudioBuffer | null> | null = null;
  private mixBuf: AudioBuffer | null = null;

  constructor(private lib: MediaLib) {}

  /**
   * The decoded sound of a file from lo to hi: a piece this mix or the last one has that covers
   * it (and isn't much longer), else a new one with a little to spare.
   */
  private part(m: Media, lo: number, hi: number, use: Map<string, Part[]>): Part {
    const mine = use.get(m.id) ?? [];
    use.set(m.id, mine);
    const fits = (r: Part) => r.lo <= lo && r.hi >= hi && r.hi - r.lo <= hi - lo + 4 * SLACK;
    let r = mine.find(fits) ?? this.parts.get(m.id)?.find(fits);
    if (!r) {
      const a = Math.max(0, lo - SLACK), b = hi + SLACK;
      r = {
        lo: a, hi: b,
        p: decodeRange(m, a, b).catch((e) => {
          console.warn('audio decode failed', e);
          return null;
        }),
      };
    }
    if (!mine.includes(r)) mine.push(r);
    return r;
  }

  /** Let go of every decoded piece and the mix. */
  dispose() {
    this.parts.clear();
    this.peakMap.clear();
    this.mixP = null;
    this.mixBuf = null;
    this.mixKey = '';
    this.onPeaks = () => {};
  }

  // ---- waveforms for the timeline: the loudest sample in each 1/100 s, 0…1

  static PEAK_RATE = 100;
  private peakMap = new Map<string, Float32Array | null>();
  /** a file's waveform became ready */
  onPeaks: () => void = () => {};

  /** The waveform of a file's whole sound (null until it's read; then onPeaks fires). */
  peaks(m: Media): Float32Array | null {
    if (!m.audio) return null;
    if (this.peakMap.has(m.id)) return this.peakMap.get(m.id)!;
    this.peakMap.set(m.id, null);
    // one pass through the file keeping just the loudest sample of each bin, not the sound
    let bin = 1, ch = 1;
    let out = new Float32Array(0);
    void walk(m, 0, Infinity, (sr, c, _from, to) => {
      bin = Math.max(1, Math.round(sr / AudioEngine.PEAK_RATE));
      ch = c;
      out = new Float32Array(Math.ceil(to / bin));
    }, (b, skip, at, n) => {
      for (let c = 0; c < ch; c++) {
        const d = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
        // every 4th sample, counted from each bin's start
        for (let j = at, e = at + n; j < e;) {
          const i = Math.floor(j / bin), be = Math.min(e, (i + 1) * bin);
          let mx = out[i];
          for (let k = j + ((4 - ((j - i * bin) % 4)) % 4); k < be; k += 4) {
            const a = Math.abs(d[k - at + skip]);
            if (a > mx) mx = a;
          }
          out[i] = mx;
          j = be;
        }
      }
    }).then((end) => {
      // (let go of meanwhile: not put back)
      if (!end || !this.peakMap.has(m.id)) return;
      const n = Math.ceil(end / bin);
      out = out.slice(0, n);
      // scaled so a loud part reaches the top (a few clipped peaks don't flatten the rest)
      const sorted = Float32Array.from(out).sort();
      const top = Math.max(1e-4, sorted[Math.floor(sorted.length * 0.98)] || 0);
      for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.sqrt(out[i] / top));
      this.peakMap.set(m.id, out);
      this.onPeaks();
    }, (e) => console.warn('waveform failed', e));
    return null;
  }

  /** Start reading a file's waveform in the background (on import; the mix decodes just the parts it uses). */
  warm(m: Media) {
    if (m.audio) this.peaks(m);
  }

  /** What the mix depends on. */
  private key(p: VideoProject) {
    return JSON.stringify([p.clips.map((c) => [c.src, c.in, c.out, c.speed, c.vol, c.ramp]), p.music]);
  }

  /** The mixed soundtrack for the project as it is now (cached; rebuilt after edits). */
  mix(p: VideoProject): Promise<AudioBuffer | null> {
    const key = this.key(p);
    if (key === this.mixKey && this.mixP) return this.mixP;
    this.mixKey = key;
    const snap: VideoProject = JSON.parse(JSON.stringify(p));
    // one render at a time: a newer request waits for the one running, and one that has been
    // overtaken by then just hands on the newest (so a long drag doesn't pile up renders)
    const before = this.mixP;
    const job: Promise<AudioBuffer | null> = (before ? before.catch(() => null) : Promise.resolve(null)).then(() => {
      if (this.mixKey !== key) return this.mixP ?? null;
      return this.render(snap).then((b) => {
        if (this.mixKey === key) this.mixBuf = b;
        return b;
      });
    });
    this.mixP = job;
    return job;
  }

  /** Decoded sound of files the project no longer uses is let go (it's decoded again if they come back). */
  keepOnly(ids: Set<string>) {
    for (const id of [...this.parts.keys()]) if (!ids.has(id)) this.parts.delete(id);
    for (const id of [...this.peakMap.keys()]) if (!ids.has(id)) this.peakMap.delete(id);
  }

  /** The mix if it's ready for this exact project, else null. */
  ready(p: VideoProject) {
    return this.key(p) === this.mixKey ? this.mixBuf : null;
  }

  private async render(p: VideoProject): Promise<AudioBuffer | null> {
    const { starts, total } = layout(p);
    const hasSound = p.clips.some((c) => c.vol > 0 && this.lib.get(c.src)?.audio) || (p.music && p.music.vol > 0);
    if (total <= 0 || !hasSound) {
      this.parts.clear();
      return null;
    }
    // the parts of each file this mix uses (a little either side), close ones as one piece
    const span = (a: number, b: number) => [Math.max(0, a - PAD), b + PAD];
    const want = new Map<string, number[][]>();
    const need = (id: string, a: number, b: number) => want.set(id, [...(want.get(id) ?? []), span(a, b)]);
    for (const c of p.clips) if (c.vol > 0 && this.lib.get(c.src)?.audio) need(c.src, c.in, c.out);
    const mu = p.music;
    const mm = mu && this.lib.get(mu.src);
    if (mu && mm?.audio && mu.vol > 0) need(mm.id, mu.in, mu.in + total);
    const use = new Map<string, Part[]>();
    for (const [id, list] of want) {
      list.sort((x, y) => x[0] - y[0]);
      let [lo, hi] = list[0];
      for (const [a, b] of [...list.slice(1), [Infinity, Infinity]]) {
        if (a <= hi + JOIN) hi = Math.max(hi, b);
        else {
          this.part(this.lib.get(id)!, lo, hi, use);
          [lo, hi] = [a, b];
        }
      }
    }
    // pieces no part of the timeline uses any more are let go
    this.parts = use;
    const piece = (id: string, a: number, b: number) => {
      const [lo, hi] = span(a, b);
      return use.get(id)?.find((r) => r.lo <= lo && r.hi >= hi)?.p ?? null;
    };

    const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * MIX_RATE)), MIX_RATE);
    const out = ctx.destination;
    for (let i = 0; i < p.clips.length; i++) {
      const c = p.clips[i];
      const m = this.lib.get(c.src);
      if (!m?.audio || c.vol <= 0) continue;
      const pc = await piece(m.id, c.in, c.out);
      if (!pc) continue;
      // (file times: where its piece starts, and where the sound ends)
      const at = pc.at, end = pc.at + pc.len;
      const t0 = starts[i], len = clipLen(c);
      const g = ctx.createGain();
      // a few ms of fade at each end: cuts don't click
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(c.vol, t0 + Math.min(EDGE, len / 4));
      g.gain.setValueAtTime(c.vol, Math.max(t0, t0 + len - Math.min(EDGE, len / 4)));
      g.gain.linearRampToValueAtTime(0, t0 + len);
      g.connect(out);
      const s = ctx.createBufferSource();
      s.buffer = pc.buf;
      if (c.ramp) {
        // a speed ramp: the playback rate follows the curve (sampled along the timeline)
        const n = Math.max(2, Math.ceil(len * 120));
        const curve = new Float32Array(n);
        for (let k = 0; k < n; k++) curve[k] = speedAt(c, srcAt(c, (k / (n - 1)) * len));
        s.playbackRate.setValueCurveAtTime(curve, t0, len);
      } else s.playbackRate.value = c.speed;
      s.connect(g);
      s.start(t0, Math.max(0, Math.min(c.in, end) - at), Math.max(0, Math.min(c.out, end) - c.in));
    }
    if (mu && mm?.audio && mu.vol > 0) {
      const pc = await piece(mm.id, mu.in, mu.in + total);
      if (pc) {
        const at = pc.at, end = pc.at + pc.len;
        const g = ctx.createGain();
        if (mu.fade) {
          // fades at the start and at the end of the music (the video's end, or the song's
          // if it's shorter)
          const fend = Math.max(0.05, Math.min(total, end - mu.in));
          const fi = Math.min(1, fend / 3), fo = Math.max(fi, fend - 1.5);
          g.gain.setValueAtTime(0, 0);
          g.gain.linearRampToValueAtTime(mu.vol, fi);
          g.gain.setValueAtTime(mu.vol, fo);
          g.gain.linearRampToValueAtTime(0, fend);
        } else g.gain.value = mu.vol;
        g.connect(out);
        const s = ctx.createBufferSource();
        s.buffer = pc.buf;
        s.connect(g);
        s.start(0, Math.max(0, Math.min(mu.in, end) - at), Math.max(0, Math.min(total, end - mu.in)));
      }
    }
    const mixed = await ctx.startRendering();
    limit(mixed);
    return mixed;
  }

  forget(id: string) {
    this.parts.delete(id);
  }
}

/**
 * Keep the mix under full level. A mix that never gets there is left exactly as it is; where it
 * would go over (a loud clip plus music, a clip at 200%) the level is turned down around those
 * moments (starting a few ms ahead, recovering over a fraction of a second) instead of the peaks
 * being cut off, which is what crackles.
 */
function limit(buf: AudioBuffer) {
  const CEIL = 0.97, B = 16;
  const n = buf.length, sr = buf.sampleRate;
  const ch = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  // the loudest sample in each short block
  const nb = Math.ceil(n / B);
  const env = new Float32Array(nb);
  let top = 0;
  for (const d of ch) {
    for (let b = 0, i = 0; b < nb; b++) {
      let mx = env[b];
      for (const e = Math.min(n, i + B); i < e; i++) {
        const a = d[i] < 0 ? -d[i] : d[i];
        if (a > mx) mx = a;
      }
      env[b] = mx;
      if (mx > top) top = mx;
    }
  }
  if (top <= CEIL) return;
  // rise towards a peak over ~4 ms before it (backwards pass), fall away over ~150 ms after
  const up = Math.exp(-B / (0.004 * sr)), down = Math.exp(-B / (0.15 * sr));
  for (let b = nb - 2; b >= 0; b--) env[b] = Math.max(env[b], env[b + 1] * up);
  for (let b = 1; b < nb; b++) env[b] = Math.max(env[b], env[b - 1] * down);
  // each block's gain is the lowest of its neighbourhood, so easing between blocks never
  // lets a sample through above the ceiling
  const gain = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    const e = Math.max(env[Math.max(0, b - 1)], env[b], env[Math.min(nb - 1, b + 1)]);
    gain[b] = e > CEIL ? CEIL / e : 1;
  }
  for (const d of ch) {
    for (let b = 0; b < nb; b++) {
      const g0 = gain[b], g1 = gain[Math.min(nb - 1, b + 1)];
      if (g0 === 1 && g1 === 1) continue;
      const i0 = b * B, e = Math.min(n, i0 + B);
      for (let i = i0; i < e; i++) d[i] *= g0 + ((g1 - g0) * (i - i0)) / B;
    }
  }
}


/**
 * Decode a file's sound from `lo` to `hi` (seconds), handing each chunk to `put` at its place:
 * sample `at` of the file, counted from its time 0, so the mix lines up with the picture.
 * Decoded chunks are laid end to end; their timestamps only move the write position for real
 * gaps (more than 10 ms off), so rounding in the file's timestamps can't open hairline gaps
 * between chunks. Anything before 0 (codec priming) or `lo` is dropped. Returns the sample the
 * sound ends at (0: none).
 */
async function walk(
  m: Media, lo: number, hi: number,
  begin: (sr: number, ch: number, from: number, to: number) => void,
  put: (b: AudioBuffer, skip: number, at: number, n: number) => void,
): Promise<number> {
  if (!m.audio) return 0;
  const sink = new AudioBufferSink(m.audio);
  // from part way in, the write position starts where a decode from 0 would have it by then:
  // at the timestamps, unless the file's first chunk was only a little off 0 (it then moved
  // everything after it by that much)
  const whole = lo <= 0;
  const first = whole ? 0 : await m.audio.getFirstTimestamp();
  let sr = 0, from = 0, to = 0;
  let cursor = 0, end = 0;
  for await (const w of sink.buffers(whole ? undefined : lo, Number.isFinite(hi) ? hi : undefined)) {
    const b = w.buffer;
    if (!sr) {
      // sized from the first decoded chunk (its rate can differ from the file header)
      sr = b.sampleRate;
      const len = Math.max(1, Math.ceil((m.duration + 0.5) * sr));
      from = whole ? 0 : Math.min(len, Math.floor(lo * sr));
      to = Math.min(len, Math.ceil(hi * sr));
      if (!whole) {
        const f = Math.round(first * sr);
        cursor = Math.round(w.timestamp * sr) - (Math.abs(f) > sr * 0.01 ? 0 : f);
      }
      begin(sr, Math.min(2, b.numberOfChannels), from, to);
    }
    const want = Math.round(w.timestamp * sr);
    if (Math.abs(want - cursor) > sr * 0.01) cursor = want;
    const skip = Math.max(0, from - cursor);
    const at = Math.max(from, cursor);
    const n = Math.min(b.length - skip, to - at);
    cursor += b.length;
    if (n <= 0) {
      if (at >= to) break;
      continue;
    }
    put(b, skip, at, n);
    end = Math.max(end, at + n);
  }
  return end;
}

/** Decode part of a file's sound (lo…hi seconds) into one buffer. */
async function decodeRange(m: Media, lo: number, hi: number): Promise<Piece | null> {
  let buf = null as AudioBuffer | null;
  let data: Float32Array[] = [];
  let from = 0;
  const end = await walk(m, lo, hi, (sr, ch, a, b) => {
    // written straight into the buffer the mix plays (no second copy of it)
    from = a;
    buf = new AudioBuffer({ numberOfChannels: ch, length: Math.max(1, b - a), sampleRate: sr });
    data = Array.from({ length: ch }, (_, c) => buf!.getChannelData(c));
  }, (b, skip, at, n) => {
    for (let c = 0; c < data.length; c++) {
      const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
      data[c].set(src.subarray(skip, skip + n), at - from);
    }
  });
  if (!buf || end <= from) return null;
  return { at: from / buf.sampleRate, len: (end - from) / buf.sampleRate, buf };
}
