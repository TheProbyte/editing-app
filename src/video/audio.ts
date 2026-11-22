// Sound for the video editor. Each file's audio is decoded once into one continuous buffer,
// and the whole timeline (clips at their speed and volume, the music with its fades) is
// mixed offline into a single track. Playback then plays that one track (nothing to schedule
// while playing, so nothing can drop out), and export uses the very same mix.
import { AudioBufferSink } from 'mediabunny';
import type { Media, MediaLib } from './media';
import { clipLen, layout, speedAt, srcAt, type VideoProject } from './project';

export const MIX_RATE = 48000;
/** a short ramp at every cut, so clips don't click against each other */
const EDGE = 0.004;

export class AudioEngine {
  private full = new Map<string, Promise<AudioBuffer | null>>();
  private mixKey = '';
  private mixP: Promise<AudioBuffer | null> | null = null;
  private mixBuf: AudioBuffer | null = null;

  constructor(private lib: MediaLib) {}

  /** The whole audio track of a file as one buffer (decoded once). */
  decoded(m: Media): Promise<AudioBuffer | null> {
    let p = this.full.get(m.id);
    if (!p) {
      p = decodeAll(m).catch((e) => {
        console.warn('audio decode failed', e);
        return null;
      });
      this.full.set(m.id, p);
    }
    return p;
  }

  /** Let go of every decoded track and the mix. */
  dispose() {
    this.full.clear();
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

  /** The waveform of a file's sound (null until it's decoded; then onPeaks fires). */
  peaks(m: Media): Float32Array | null {
    if (!m.audio) return null;
    if (this.peakMap.has(m.id)) return this.peakMap.get(m.id)!;
    this.peakMap.set(m.id, null);
    void this.decoded(m).then((buf) => {
      if (!buf) return;
      const bin = Math.max(1, Math.round(buf.sampleRate / AudioEngine.PEAK_RATE));
      const n = Math.ceil(buf.length / bin);
      const out = new Float32Array(n);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < n; i++) {
          let mx = out[i];
          const e = Math.min(d.length, (i + 1) * bin);
          for (let j = i * bin; j < e; j += 4) {
            const a = Math.abs(d[j]);
            if (a > mx) mx = a;
          }
          out[i] = mx;
        }
      }
      // scaled so a loud part reaches the top (a few clipped peaks don't flatten the rest)
      const sorted = Float32Array.from(out).sort();
      const top = Math.max(1e-4, sorted[Math.floor(sorted.length * 0.98)] || 0);
      for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.sqrt(out[i] / top));
      this.peakMap.set(m.id, out);
      this.onPeaks();
    });
    return null;
  }

  /** Start decoding a file's sound in the background (on import). */
  warm(m: Media) {
    if (m.audio) void this.decoded(m);
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
    for (const id of [...this.full.keys()]) if (!ids.has(id)) this.full.delete(id);
    for (const id of [...this.peakMap.keys()]) if (!ids.has(id)) this.peakMap.delete(id);
  }

  /** The mix if it's ready for this exact project, else null. */
  ready(p: VideoProject) {
    return this.key(p) === this.mixKey ? this.mixBuf : null;
  }

  private async render(p: VideoProject): Promise<AudioBuffer | null> {
    const { starts, total } = layout(p);
    const hasSound = p.clips.some((c) => c.vol > 0 && this.lib.get(c.src)?.audio) || (p.music && p.music.vol > 0);
    if (total <= 0 || !hasSound) return null;
    const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * MIX_RATE)), MIX_RATE);
    const out = ctx.destination;
    for (let i = 0; i < p.clips.length; i++) {
      const c = p.clips[i];
      const m = this.lib.get(c.src);
      if (!m?.audio || c.vol <= 0) continue;
      const buf = await this.decoded(m);
      if (!buf) continue;
      const t0 = starts[i], len = clipLen(c);
      const g = ctx.createGain();
      // a few ms of fade at each end: cuts don't click
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(c.vol, t0 + Math.min(EDGE, len / 4));
      g.gain.setValueAtTime(c.vol, Math.max(t0, t0 + len - Math.min(EDGE, len / 4)));
      g.gain.linearRampToValueAtTime(0, t0 + len);
      g.connect(out);
      const s = ctx.createBufferSource();
      s.buffer = buf;
      if (c.ramp) {
        // a speed ramp: the playback rate follows the curve (sampled along the timeline)
        const n = Math.max(2, Math.ceil(len * 120));
        const curve = new Float32Array(n);
        for (let k = 0; k < n; k++) curve[k] = speedAt(c, srcAt(c, (k / (n - 1)) * len));
        s.playbackRate.setValueCurveAtTime(curve, t0, len);
      } else s.playbackRate.value = c.speed;
      s.connect(g);
      s.start(t0, Math.min(c.in, buf.duration), Math.max(0, Math.min(c.out, buf.duration) - c.in));
    }
    const mu = p.music;
    const mm = mu && this.lib.get(mu.src);
    if (mu && mm?.audio && mu.vol > 0) {
      const buf = await this.decoded(mm);
      if (buf) {
        const g = ctx.createGain();
        if (mu.fade) {
          // fades at the start and at the end of the music (the video's end, or the song's
          // if it's shorter)
          const end = Math.max(0.05, Math.min(total, buf.duration - mu.in));
          const fi = Math.min(1, end / 3), fo = Math.max(fi, end - 1.5);
          g.gain.setValueAtTime(0, 0);
          g.gain.linearRampToValueAtTime(mu.vol, fi);
          g.gain.setValueAtTime(mu.vol, fo);
          g.gain.linearRampToValueAtTime(0, end);
        } else g.gain.value = mu.vol;
        g.connect(out);
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.connect(g);
        s.start(0, Math.min(mu.in, buf.duration), Math.max(0, Math.min(total, buf.duration - mu.in)));
      }
    }
    const mixed = await ctx.startRendering();
    limit(mixed);
    return mixed;
  }

  forget(id: string) {
    this.full.delete(id);
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
 * Decode a whole track into one buffer. Decoded chunks are laid end to end; their timestamps
 * only move the write position for real gaps (more than 10 ms off), so rounding in the file's
 * timestamps can't open hairline gaps between chunks.
 */
async function decodeAll(m: Media): Promise<AudioBuffer | null> {
  if (!m.audio) return null;
  const sink = new AudioBufferSink(m.audio);
  let sr = 0, ch = 0, len = 0;
  let data: Float32Array[] = [];
  let cursor = 0, end = 0;
  for await (const w of sink.buffers()) {
    const b = w.buffer;
    if (!sr) {
      // sized from the first decoded chunk (its rate can differ from the file header)
      sr = b.sampleRate;
      ch = Math.min(2, b.numberOfChannels);
      len = Math.max(1, Math.ceil((m.duration + 0.5) * sr));
      data = Array.from({ length: ch }, () => new Float32Array(len));
    }
    // index 0 = time 0 of the file, so the mix lines up with the picture; anything before
    // 0 (codec priming) is dropped
    const want = Math.round(w.timestamp * sr);
    if (Math.abs(want - cursor) > sr * 0.01) cursor = want;
    const skip = Math.max(0, -cursor);
    const at = Math.max(0, cursor);
    const n = Math.min(b.length - skip, len - at);
    cursor += b.length;
    if (n <= 0) {
      if (at >= len) break;
      continue;
    }
    for (let c = 0; c < ch; c++) {
      const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
      data[c].set(src.subarray(skip, skip + n), at);
    }
    end = Math.max(end, at + n);
  }
  if (!end) return null;
  const out = new AudioBuffer({ numberOfChannels: ch, length: end, sampleRate: sr });
  for (let c = 0; c < ch; c++) out.copyToChannel(data[c].subarray(0, end), c);
  return out;
}
