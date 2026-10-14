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
    const job = this.render(snap).then((b) => {
      if (this.mixKey === key) this.mixBuf = b;
      return b;
    });
    this.mixP = job;
    return job;
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
      g.connect(ctx.destination);
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
          g.gain.setValueAtTime(0, 0);
          g.gain.linearRampToValueAtTime(mu.vol, Math.min(1, total / 3));
          g.gain.setValueAtTime(mu.vol, Math.max(0, total - 1.5));
          g.gain.linearRampToValueAtTime(0, total);
        } else g.gain.value = mu.vol;
        g.connect(ctx.destination);
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.connect(g);
        s.start(0, Math.min(mu.in, buf.duration), Math.max(0, Math.min(total, buf.duration - mu.in)));
      }
    }
    return ctx.startRendering();
  }

  forget(id: string) {
    this.full.delete(id);
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
