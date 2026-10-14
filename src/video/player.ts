// Playback: frames are decoded ahead with Mediabunny and shown when the audio clock reaches
// them; audio for every clip (and the music) is scheduled on a Web Audio graph, so picture
// and sound share one clock. Paused, seeking fetches the exact frame (latest request wins).
import type { VideoSample, VideoSampleSink, AudioBufferSink } from 'mediabunny';
import type { Media, MediaLib } from './media';
import { clipAt, clipLen, layout, type VClip, type VideoProject } from './project';

export interface Frame {
  clip: VClip;
  media: Media;
  /** null for stills */
  sample: VideoSample | null;
}

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Player {
  playing = false;
  private T = 0;
  private token = 0;
  ctx: AudioContext | null = null;
  private ctxStart = 0;
  private startT = 0;
  private nodes: AudioScheduledSourceNode[] = [];
  private vSinks = new Map<string, VideoSampleSink>();
  private aSinks = new Map<string, AudioBufferSink>();
  private seekBusy = false;
  private seekWant: number | null = null;
  private master: GainNode | null = null;

  /** a frame to show (the receiver closes the sample) */
  onFrame: (f: Frame) => void = () => {};
  onTime: (T: number) => void = () => {};
  onEnd: () => void = () => {};

  constructor(private lib: MediaLib, private project: () => VideoProject) {}

  get time() {
    if (!this.playing || !this.ctx) return this.T;
    // what you hear lags the audio clock by the output latency (a lot on Bluetooth): the
    // picture follows what you hear
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return Math.max(this.startT, this.startT + (this.ctx.currentTime - lat - this.ctxStart));
  }

  private vSink(m: Media) {
    let s = this.vSinks.get(m.id);
    if (!s && m.video) this.vSinks.set(m.id, (s = this.lib.videoSink(m)!));
    return s ?? null;
  }
  private aSink(m: Media) {
    let s = this.aSinks.get(m.id);
    if (!s && m.audio) this.aSinks.set(m.id, (s = this.lib.audioSink(m)!));
    return s ?? null;
  }

  // ---- paused: show the frame at T

  seek(T: number) {
    if (this.playing) this.pause();
    this.T = Math.max(0, T);
    this.peek(this.T);
  }

  /** Show the frame at T without moving the playhead (e.g. the edge being trimmed). */
  peek(T: number) {
    this.seekWant = Math.max(0, T);
    if (!this.seekBusy) void this.seekLoop();
  }

  private async seekLoop() {
    this.seekBusy = true;
    try {
      while (this.seekWant !== null) {
        const T = this.seekWant;
        this.seekWant = null;
        const p = this.project();
        const at = clipAt(p, T);
        if (!at) continue;
        const clip = p.clips[at.i];
        const m = this.lib.get(clip.src);
        if (!m) continue;
        if (m.kind === 'image') {
          this.onFrame({ clip, media: m, sample: null });
          continue;
        }
        const sink = this.vSink(m);
        if (!sink) continue;
        const s = (await sink.getSample(at.src)) ?? (await sink.getSample(m.duration * 0.999));
        if (!s) continue;
        // a newer request came in while decoding: still show this one (it's close), then go on
        this.onFrame({ clip, media: m, sample: s });
      }
    } catch (e) {
      console.warn('seek failed', e);
    } finally {
      this.seekBusy = false;
    }
  }

  // ---- playback

  async play() {
    const p = this.project();
    const { total } = layout(p);
    if (!p.clips.length) return;
    if (this.T >= total - 0.05) this.T = 0;
    this.ctx ??= new AudioContext({ latencyHint: 'playback' });
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.master ??= this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.playing = true;
    const token = ++this.token;
    this.startT = this.T;
    // a small lead so the first frame and sound are ready together
    this.ctxStart = this.ctx.currentTime + 0.12;
    void this.videoLoop(token);
    void this.audioLoop(token);
    void this.musicLoop(token);
    void this.clockLoop(token);
  }

  pause() {
    if (!this.playing) return;
    this.T = this.time;
    this.playing = false;
    this.token++;
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* not started */
      }
    }
    this.nodes = [];
  }

  private alive(token: number) {
    return this.playing && token === this.token;
  }

  private async clockLoop(token: number) {
    while (this.alive(token)) {
      const t = this.time;
      const total = layout(this.project()).total;
      if (t >= total) {
        this.pause();
        this.T = total;
        this.onTime(total);
        this.onEnd();
        return;
      }
      this.onTime(t);
      await raf();
    }
  }

  /** Clips from the one under T onward: their timeline start and where in the source to begin. */
  private plan(T: number) {
    const p = this.project();
    const { starts } = layout(p);
    const at = clipAt(p, T);
    if (!at) return [];
    return p.clips.slice(at.i).map((c, k) => ({ clip: c, start: starts[at.i + k], from: k === 0 ? at.src : c.in }));
  }

  private async videoLoop(token: number) {
    const plan = this.plan(this.startT);
    // decoding of the next clip starts a little before the current one ends
    let pending: { it: AsyncGenerator<VideoSample, void, unknown>; first: Promise<IteratorResult<VideoSample, void>> } | null = null;
    const open = (k: number) => {
      const c = plan[k];
      const m = c && this.lib.get(c.clip.src);
      const sink = m && m.kind === 'video' ? this.vSink(m) : null;
      if (!sink) return null;
      const it = sink.samples(c.from, c.clip.out);
      return { it, first: it.next() };
    };
    try {
      for (let k = 0; k < plan.length && this.alive(token); k++) {
        const { clip, start } = plan[k];
        const m = this.lib.get(clip.src);
        if (!m) continue;
        const end = start + clipLen(clip);
        if (m.kind === 'image') {
          this.onFrame({ clip, media: m, sample: null });
          while (this.alive(token) && this.time < end) {
            if (!pending && end - this.time < 1) pending = open(k + 1);
            await raf();
          }
          continue;
        }
        const cur = pending ?? open(k);
        pending = null;
        if (!cur) continue;
        let r = await cur.first;
        while (!r.done && this.alive(token)) {
          const s = r.value;
          const tl = start + (s.timestamp - clip.in) / clip.speed;
          const tlEnd = tl + (s.duration || 1 / 30) / clip.speed;
          // wait for its moment
          while (this.alive(token) && this.time < tl - 0.004) {
            if (!pending && end - this.time < 1.2) pending = open(k + 1);
            await raf();
          }
          if (!this.alive(token)) {
            s.close();
            break;
          }
          // running late: skip frames whose time has fully passed (but never all of them)
          if (this.time > tlEnd && tlEnd < end - 0.001) s.close();
          else this.onFrame({ clip, media: m, sample: s });
          if (!pending && end - this.time < 1.2) pending = open(k + 1);
          r = await cur.it.next();
        }
        if (!this.alive(token)) {
          await cur.it.return();
          break;
        }
        // let the clip's last frame stay up until the clip ends
        while (this.alive(token) && this.time < end - 0.004) await raf();
      }
    } catch (e) {
      console.warn('playback (video) failed', e);
    } finally {
      if (pending) {
        void pending.first.then((r) => r.value && r.value.close()).catch(() => {});
        void pending.it.return();
      }
    }
  }

  private schedule(buf: AudioBuffer, when: number, offset: number, dur: number, rate: number, gain: number, fade?: { in: number; out: number; at: number; len: number }) {
    const ctx = this.ctx!;
    if (dur <= 0) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    if (fade) {
      // music fades: in over the first second of the video, out over the last
      const vAt = (t: number) => gain * Math.min(1, fade.in > 0 ? t / fade.in : 1, fade.out > 0 ? (fade.len - t) / fade.out : 1);
      g.gain.setValueAtTime(Math.max(0, vAt(fade.at)), when);
      g.gain.linearRampToValueAtTime(Math.max(0, vAt(fade.at + dur * rate)), when + dur);
    }
    src.connect(g).connect(this.master!);
    const now = ctx.currentTime;
    if (when < now) {
      const late = now - when;
      offset += late * rate;
      dur -= late;
      when = now;
      if (dur <= 0) return;
    }
    src.start(when, offset, dur * rate);
    this.nodes.push(src);
    src.onended = () => {
      const i = this.nodes.indexOf(src);
      if (i >= 0) this.nodes.splice(i, 1);
    };
  }

  /** ctx time for timeline time t */
  private at(t: number) {
    return this.ctxStart + (t - this.startT);
  }

  private async audioLoop(token: number) {
    try {
      for (const { clip, start, from } of this.plan(this.startT)) {
        if (!this.alive(token)) return;
        const m = this.lib.get(clip.src);
        const sink = m ? this.aSink(m) : null;
        if (!sink || clip.vol <= 0) continue;
        for await (const b of sink.buffers(Math.max(0, from - 0.2), clip.out)) {
          if (!this.alive(token)) return;
          // the part of this buffer inside [from, out]
          const s0 = Math.max(b.timestamp, from), s1 = Math.min(b.timestamp + b.duration, clip.out);
          if (s1 > s0) {
            const tl = start + (s0 - clip.in) / clip.speed;
            this.schedule(b.buffer, this.at(tl), s0 - b.timestamp, (s1 - s0) / clip.speed, clip.speed, clip.vol);
          }
          // stay about two seconds ahead
          while (this.alive(token) && this.at(start + (s1 - clip.in) / clip.speed) - this.ctx!.currentTime > 2) await sleep(150);
        }
      }
    } catch (e) {
      console.warn('playback (audio) failed', e);
    }
  }

  private async musicLoop(token: number) {
    const p = this.project();
    const mu = p.music;
    const m = mu && this.lib.get(mu.src);
    const sink = m ? this.aSink(m) : null;
    if (!mu || !m || !sink || mu.vol <= 0) return;
    const total = layout(p).total;
    const from = mu.in + this.startT, to = Math.min(m.duration, mu.in + total);
    if (from >= to) return;
    try {
      for await (const b of sink.buffers(Math.max(0, from - 0.2), to)) {
        if (!this.alive(token)) return;
        const s0 = Math.max(b.timestamp, from), s1 = Math.min(b.timestamp + b.duration, to);
        if (s1 > s0) {
          const tl = s0 - mu.in;
          this.schedule(b.buffer, this.at(tl), s0 - b.timestamp, s1 - s0, 1, mu.vol, mu.fade ? { in: 1, out: 1.5, at: tl, len: total } : undefined);
        }
        while (this.alive(token) && this.at(s1 - mu.in) - this.ctx!.currentTime > 2) await sleep(150);
      }
    } catch (e) {
      console.warn('playback (music) failed', e);
    }
  }

  /** Forget decoders for media no longer used. */
  dispose() {
    this.pause();
    this.vSinks.clear();
    this.aSinks.clear();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
