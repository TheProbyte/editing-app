// Playback works like a real player: a producer decodes frames ahead (Mediabunny / the
// phone's hardware decoder) and copies each straight into a GPU texture, so the decoder is
// never kept waiting; one display loop shows each frame on the screen refresh it's due,
// against a smooth clock read from the audio output. The sound is one premixed track (see
// audio.ts), so there's nothing to schedule while playing. Paused, seeking fetches the exact
// frame (latest request wins).
import { EncodedPacketSink, type VideoSample, type VideoSampleSink } from 'mediabunny';
import type { Media, MediaLib } from './media';
import type { AudioEngine } from './audio';
import type { GpuFrame } from './compose';
import { clipAt, layout, type VClip, type VideoProject } from './project';

export interface Frame {
  clip: VClip;
  media: Media;
  /** null for stills */
  sample: VideoSample | null;
  /** a cached preview-size copy instead of a sample (reverse scrubbing); not to be closed */
  bitmap?: ImageBitmap;
  /** its source time */
  ts?: number;
  /** already copied to the GPU (playback) */
  pre?: GpuFrame;
  /** timeline time it's shown for */
  t?: number;
}

/** a decoded frame waiting for its moment */
interface Queued {
  clip: VClip;
  media: Media;
  tl: number;
  pre: GpuFrame | null;
}
/** frames decoded ahead (a few: hardware decoders only have so many buffers) */
const QMAX = 4;

/** Frames kept for scrubbing backwards (each a preview-size bitmap). */
const REV_MAX = 150;
const REV_LONG = 640;


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
  private queue: Queued[] = [];
  private cur: Queued | null = null;
  private imgT = 0;
  private space: (() => void) | null = null;
  private lastTime = 0;
  /** copies a decoded frame to the GPU (set by the video editor) */
  upload: (vf: VideoFrame) => GpuFrame = () => {
    throw new Error('no uploader');
  };
  private seekBusy = false;
  private seekWant: { T: number; fast: boolean } | null = null;
  private master: GainNode | null = null;

  /** a frame to show (the receiver closes the sample) */
  onFrame: (f: Frame) => void = () => {};
  onTime: (T: number) => void = () => {};
  onEnd: () => void = () => {};

  constructor(private lib: MediaLib, private project: () => VideoProject, private audio: AudioEngine) {}

  /**
   * The playhead. Playing, it's the moment you're hearing: the audio output's own timestamp
   * (which includes the output delay, a lot on Bluetooth), carried forward smoothly with the
   * high-resolution timer between its updates (the plain audio clock moves in 20–40 ms steps
   * on phones, which would make the picture judder). Never goes backwards.
   */
  get time() {
    if (!this.playing || !this.ctx) return this.T;
    const t = Math.max(this.startT, this.startT + (this.audioNow() - this.ctxStart));
    if (t > this.lastTime) this.lastTime = t;
    return this.lastTime;
  }

  private audioNow() {
    const ctx = this.ctx!;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime && ts.performanceTime) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
  }

  private vSink(m: Media) {
    let s = this.vSinks.get(m.id);
    if (!s && m.video) this.vSinks.set(m.id, (s = this.lib.videoSink(m)!));
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
          this.onFrame({ clip, media: m, sample: null, t: T });
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
            this.onFrame({ clip, media: m, sample: null, bitmap: b.bmp, ts: b.ts, t: T });
            this.lastT = { media: m.id, t };
            continue;
          }
          if (!this.filling) this.filling = this.fillBack(m, sink, t).catch(() => {}).finally(() => (this.filling = null));
        }
        const s = await this.frameAt(m, sink, t, fast);
        if (s) this.onFrame({ clip, media: m, sample: s, t: T });
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
    this.ctx ??= new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (!this.master) {
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    // the scrub decoder isn't needed while playing (phones have only a few decoders)
    this.closeScrub();
    clearTimeout(this.settle);
    this.seekWant = null;
    this.playing = true;
    this.drops = 0;
    this.shown = 0;
    const token = ++this.token;
    this.startT = this.T;
    this.lastTime = this.T;
    this.ctxStart = this.ctx.currentTime + 3600; // the clock holds at startT until it really starts
    this.queue = [];
    this.cur = null;
    // the soundtrack (normally mixed already, in the background after each edit) and the
    // first frame, both ready before the clock starts
    const mixP = this.audio.mix(p);
    void this.produce(token, this.plan(this.startT));
    const firstFrame = new Promise<void>((r) => {
      const t0 = performance.now();
      const wait = () => (this.queue.length || !this.alive(token) || performance.now() - t0 > 1500 ? r() : setTimeout(wait, 4));
      wait();
    });
    const [mix] = await Promise.all([mixP.catch(() => null), firstFrame]);
    if (!this.alive(token)) return;
    this.ctxStart = this.ctx.currentTime + 0.05;
    if (mix && this.startT < mix.duration) {
      const src = this.ctx.createBufferSource();
      src.buffer = mix;
      src.connect(this.master);
      src.start(this.ctxStart, this.startT);
      this.nodes.push(src);
    }
    this.present(token);
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
    this.queue = [];
    this.space?.();
  }

  private alive(token: number) {
    return this.playing && token === this.token;
  }

  /** Clips from the one under T onward: their timeline start and where in the source to begin. */
  private plan(T: number) {
    const p = this.project();
    const { starts } = layout(p);
    const at = clipAt(p, T);
    if (!at) return [];
    return p.clips.slice(at.i).map((c, k) => ({ clip: c, start: starts[at.i + k], from: k === 0 ? at.src : c.in }));
  }

  /** Decode ahead, clip after clip, copying frames to the GPU as they come. */
  private async produce(token: number, plan: ReturnType<Player['plan']>) {
    const room = async () => {
      while (this.alive(token) && this.queue.length >= QMAX) await new Promise<void>((r) => (this.space = r));
    };
    for (const { clip, start, from } of plan) {
      if (!this.alive(token)) return;
      const m = this.lib.get(clip.src);
      if (!m) continue;
      if (m.kind === 'image') {
        await room();
        if (!this.alive(token)) return;
        this.queue.push({ clip, media: m, tl: start, pre: null });
        continue;
      }
      const sink = this.vSink(m);
      if (!sink) continue;
      const it = sink.samples(from, clip.out);
      try {
        for (;;) {
          const r = await it.next();
          if (r.done) break;
          const s = r.value;
          if (!this.alive(token)) {
            s.close();
            return;
          }
          const tl = Math.max(start, start + (s.timestamp - clip.in) / clip.speed);
          const vf = s.toVideoFrame();
          let pre: GpuFrame;
          try {
            pre = this.upload(vf);
          } finally {
            vf.close();
            s.close();
          }
          this.queue.push({ clip, media: m, tl, pre });
          await room();
        }
      } catch (e) {
        console.warn('playback decode failed', e);
      } finally {
        void it.return().catch(() => {});
      }
    }
  }

  /** One loop, once per screen refresh: show the frame that's due, move the playhead. */
  private present(token: number) {
    const step = () => {
      if (!this.alive(token)) return;
      const t = this.time;
      const total = layout(this.project()).total;
      if (t >= total) {
        this.pause();
        this.T = total;
        this.onTime(total);
        this.onEnd();
        return;
      }
      let due: Queued | null = null;
      while (this.queue.length && this.queue[0].tl <= t + 0.002) {
        const q = this.queue.shift()!;
        if (due) this.drops++; // a later frame is due too: this one never got its moment
        due = q;
      }
      if (due) {
        this.shown++;
        this.cur = due;
        this.onFrame({ clip: due.clip, media: due.media, sample: null, pre: due.pre ?? undefined, t: due.tl });
        this.space?.();
      } else if (this.cur && this.cur.media.kind === 'image' && (this.cur.clip.kf?.length ?? 0) > 1 && t - this.imgT >= 1 / 60) {
        // a photo with keyframes moves on its own (it has no frames): 60 updates a second
        this.imgT = t;
        this.onFrame({ clip: this.cur.clip, media: this.cur.media, sample: null, t });
      }
      this.onTime(t);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Forget decoders for media no longer used. */
  dispose() {
    this.pause();
    this.closeScrub();
    this.clearRev();
    this.keySinks.clear();
    this.vSinks.clear();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
