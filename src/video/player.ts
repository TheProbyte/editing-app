// Playback: frames are decoded ahead with Mediabunny and shown when the audio clock reaches
// them; audio for every clip (and the music) is scheduled on a Web Audio graph, so picture
// and sound share one clock. Paused, seeking fetches the exact frame (latest request wins).
import { EncodedPacketSink, type VideoSample, type VideoSampleSink, type AudioBufferSink } from 'mediabunny';
import type { Media, MediaLib } from './media';
import { clipAt, clipLen, layout, type VClip, type VideoProject } from './project';

export interface Frame {
  clip: VClip;
  media: Media;
  /** null for stills */
  sample: VideoSample | null;
  /** a cached preview-size copy instead of a sample (reverse scrubbing); not to be closed */
  bitmap?: ImageBitmap;
  /** its source time */
  ts?: number;
}

/** Frames kept for scrubbing backwards (each a preview-size bitmap). */
const REV_MAX = 150;
const REV_LONG = 640;

type Opened = { it: AsyncGenerator<VideoSample, void, unknown>; first: Promise<IteratorResult<VideoSample, void>> };

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Player {
  playing = false;
  private T = 0;
  /** frames dropped / shown since playback started (for dynamic resolution) */
  drops = 0;
  shown = 0;
  private token = 0;
  ctx: AudioContext | null = null;
  private ctxStart = 0;
  private startT = 0;
  private nodes: AudioScheduledSourceNode[] = [];
  private vSinks = new Map<string, VideoSampleSink>();
  private aSinks = new Map<string, AudioBufferSink>();
  private seekBusy = false;
  private seekWant: { T: number; fast: boolean } | null = null;
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

  /**
   * Show the frame at T and move the playhead there. `fast` (while a finger is moving) may
   * show the nearest whole frame the file stores instead, which decodes in one step; the
   * exact frame follows as soon as the finger settles.
   */
  seek(T: number, fast = false) {
    if (this.playing) this.pause();
    this.T = Math.max(0, T);
    this.peek(this.T, fast);
  }

  /** Show the frame at T without moving the playhead (e.g. the edge being trimmed). */
  peek(T: number, fast = false) {
    this.seekWant = { T: Math.max(0, T), fast };
    clearTimeout(this.settle);
    // the exact frame once requests stop coming
    if (fast) this.settle = window.setTimeout(() => this.peek(T, false), 110);
    if (!this.seekBusy) void this.seekLoop();
  }
  private settle = 0;

  /**
   * One open decoder for scrubbing: moving forward a little just decodes on from where it is
   * (cheap); anything else restarts it at the stored whole frame ("key frame") before T.
   */
  private scrub: { media: string; it: AsyncGenerator<VideoSample, void, unknown>; ts: number; peek: VideoSample | null } | null = null;
  private keySinks = new Map<string, EncodedPacketSink>();
  private shownKey = { media: '', ts: -1 };

  private closeScrub() {
    const sc = this.scrub;
    if (!sc) return;
    this.scrub = null;
    sc.peek?.close();
    void sc.it.return().catch(() => {});
  }

  private async keyTime(m: Media, t: number) {
    let ks = this.keySinks.get(m.id);
    if (!ks) this.keySinks.set(m.id, (ks = new EncodedPacketSink(m.video!)));
    const pk = await ks.getKeyPacket(t, { metadataOnly: true });
    return pk ? pk.timestamp : 0;
  }

  /** The sample at source time t (exact), or the key frame before it (fast). Null: nothing new. */
  private async frameAt(m: Media, sink: VideoSampleSink, t: number, fast: boolean): Promise<VideoSample | null> {
    let sc = this.scrub?.media === m.id ? this.scrub : null;
    const ahead = sc ? t - sc.ts : -1;
    if (!sc || ahead < -1e-4 || ahead > (fast ? 0.6 : 1.5)) {
      // restart at the key frame before t
      const kt = await this.keyTime(m, t);
      // close to the key frame, decoding the few frames up to t is cheap: be exact
      const far = t - kt > 0.35;
      if (fast && far && this.shownKey.media === m.id && Math.abs(this.shownKey.ts - kt) < 1e-4) return null;
      this.closeScrub();
      const it = sink.samples(kt);
      const r = await it.next();
      if (r.done) {
        void it.return();
        return null;
      }
      sc = this.scrub = { media: m.id, it, ts: r.value.timestamp, peek: r.value };
      if (fast && far) {
        this.shownKey = { media: m.id, ts: kt };
        sc.peek = null;
        return r.value;
      }
    }
    // decode on to the frame covering t
    let cur: VideoSample | null = sc.peek;
    sc.peek = null;
    for (;;) {
      if (cur && cur.timestamp + (cur.duration || 1 / 60) > t + 1e-4) break;
      const r = await sc.it.next();
      if (r.done) break;
      if (r.value.timestamp > t + 1e-4) {
        // already past t: keep it for later, show what we have
        sc.peek = r.value;
        break;
      }
      cur?.close();
      cur = r.value;
    }
    if (!cur) return null;
    // `cur` goes to the screen (and is closed there); remember where we are
    sc.ts = cur.timestamp;
    this.shownKey = { media: '', ts: -1 };
    return cur;
  }

  // ---- reverse scrubbing: video only decodes forwards, so going back a second at a time is
  // done by decoding that whole second once into small bitmaps and showing those

  private filling: Promise<unknown> | null = null;
  private rev = new Map<string, { ts: number; end: number; bmp: ImageBitmap }[]>();
  private revCount = 0;
  private lastT = { media: '', t: -1 };

  private backward(m: Media, t: number) {
    return this.lastT.media === m.id && t < this.lastT.t - 1e-4;
  }

  private cached(m: Media, t: number) {
    const L = this.rev.get(m.id);
    if (!L) return null;
    for (const f of L) if (t >= f.ts - 1e-4 && t < f.end) return f;
    return null;
  }

  private async fillBack(m: Media, sink: VideoSampleSink, t: number) {
    const kt = await this.keyTime(m, t);
    const L = this.rev.get(m.id) ?? [];
    this.rev.set(m.id, L);
    // the key frame up to t (scrubbing backwards, what's after t has been passed already),
    // stopping early at frames that are cached
    const next = L.filter((f) => f.ts > kt).reduce((a, f) => Math.min(a, f.ts), t + 0.05);
    if (next <= kt) return null;
    const k = Math.min(1, REV_LONG / Math.max(m.video?.codedWidth ?? 1920, m.video?.codedHeight ?? 1080));
    for await (const s of sink.samples(kt, next)) {
      const vf = s.toVideoFrame();
      try {
        const bmp = await createImageBitmap(vf, { resizeWidth: Math.max(2, Math.round(vf.displayWidth * k)), resizeHeight: Math.max(2, Math.round(vf.displayHeight * k)), resizeQuality: 'medium' });
        L.push({ ts: s.timestamp, end: s.timestamp + (s.duration || 1 / 30), bmp });
        this.revCount++;
      } finally {
        vf.close();
        s.close();
      }
      if (this.playing) break;
    }
    L.sort((a, b) => a.ts - b.ts);
    // bounded: drop the frames furthest from where we are
    while (this.revCount > REV_MAX) {
      let worst: { list: typeof L; i: number; d: number } | null = null;
      for (const list of this.rev.values()) list.forEach((f, i) => {
        const d = Math.abs(f.ts - t) + (list === L ? 0 : 1e6);
        if (!worst || d > worst.d) worst = { list, i, d };
      });
      if (!worst) break;
      const w = worst as { list: typeof L; i: number };
      w.list[w.i].bmp.close();
      w.list.splice(w.i, 1);
      this.revCount--;
    }
    return this.cached(m, t);
  }

  private clearRev() {
    for (const L of this.rev.values()) for (const f of L) f.bmp.close();
    this.rev.clear();
    this.revCount = 0;
  }

  private async seekLoop() {
    this.seekBusy = true;
    try {
      while (this.seekWant !== null) {
        const { T, fast } = this.seekWant;
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
        const t = Math.min(at.src, m.duration - 1e-3);
        // scrubbing backwards: from the cache when it has the frame; otherwise the quick
        // frame now, and the second before t goes into the cache in the background
        if (fast && this.backward(m, t)) {
          const b = this.cached(m, t);
          if (b) {
            this.onFrame({ clip, media: m, sample: null, bitmap: b.bmp, ts: b.ts });
            this.lastT = { media: m.id, t };
            continue;
          }
          if (!this.filling) this.filling = this.fillBack(m, sink, t).catch(() => {}).finally(() => (this.filling = null));
        }
        const s = await this.frameAt(m, sink, t, fast);
        if (s) this.onFrame({ clip, media: m, sample: s });
        this.lastT = { media: m.id, t };
      }
    } catch (e) {
      console.warn('seek failed', e);
      this.closeScrub();
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
    // the scrub decoder isn't needed while playing (phones have only a few decoders)
    this.closeScrub();
    clearTimeout(this.settle);
    this.seekWant = null;
    this.playing = true;
    this.drops = 0;
    this.shown = 0;
    const token = ++this.token;
    this.startT = this.T;
    this.ctxStart = this.ctx.currentTime + 3600; // the clock holds at startT until it really starts
    // decode the first frame before the clock starts, so playback begins without a stutter
    const plan = this.plan(this.startT);
    let first: Opened | null = null;
    const m0 = plan[0] && this.lib.get(plan[0].clip.src);
    const sink0 = m0 && m0.kind === 'video' ? this.vSink(m0) : null;
    if (sink0) {
      const it = sink0.samples(plan[0].from, plan[0].clip.out);
      const r = await Promise.race([it.next(), sleep(1500).then(() => null)]);
      first = { it, first: r ? Promise.resolve(r) : it.next() };
      if (!this.alive(token)) {
        void first.first.then((x) => x.value && x.value.close()).catch(() => {});
        void it.return();
        return;
      }
    }
    // a small lead so the first frame and sound are ready together
    this.ctxStart = this.ctx.currentTime + 0.06;
    void this.videoLoop(token, plan, first);
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

  private async videoLoop(token: number, plan: ReturnType<Player['plan']>, primed: Opened | null) {
    // decoding of the next clip starts a little before the current one ends
    let pending: Opened | null = primed;
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
          if (this.time > tlEnd && tlEnd < end - 0.001) {
            s.close();
            this.drops++;
          } else {
            this.shown++;
            this.onFrame({ clip, media: m, sample: s });
          }
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
    this.closeScrub();
    this.clearRev();
    this.keySinks.clear();
    this.vSinks.clear();
    this.aSinks.clear();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
