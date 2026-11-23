// Playback works like a real player: a producer decodes frames ahead (Mediabunny / the
// phone's hardware decoder) and copies each straight into a GPU texture, so the decoder is
// never kept waiting; one display loop shows each frame on the screen refresh it's due,
// against a smooth clock read from the audio output. The sound is one premixed track (see
// audio.ts), so there's nothing to schedule while playing. Paused, seeking fetches the exact
// frame (latest request wins).
//
// Each run of clips decodes in its own lane. The next lane starts a little before its clip is
// due (so its first frames are decoded and on the GPU by the cut), and across a transition the
// two lanes run side by side: the display loop hands both clips' frames over together.
import { CanvasSink, EncodedPacketSink, type VideoSample, type VideoSampleSink } from 'mediabunny';
import type { Media, MediaLib } from './media';
import type { AudioEngine } from './audio';
import type { GpuFrame } from './compose';
import { clipAt, clipLen, layout, localAt, mixAt, srcAt, type VClip, type VideoProject } from './project';

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
  /** the bitmap is already rotated upright (key frame cache) */
  upright?: boolean;
  /** shown while a finger is moving (the exact frame follows): draw it the quick way */
  fast?: boolean;
  /** across a transition: the other clip's frame at the same moment */
  other?: Frame;
  /** just this clip, even inside a transition (the edge being trimmed) */
  solo?: boolean;
}

/** a decoded frame waiting for its moment */
interface Queued {
  clip: VClip;
  media: Media;
  tl: number;
  pre: GpuFrame | null;
}
/** frames decoded ahead per lane (a few: hardware decoders only have so many buffers) */
const QMAX = 4;
/** a lane starts decoding this long before its first clip is due */
const LEAD = 1;

/** Clips that play one after another through one decoder (the halves of a split…). */
interface Run {
  parts: { clip: VClip; start: number }[];
  /** source time to start decoding at */
  from: number;
  /** timeline time it starts and ends */
  start: number;
  end: number;
}

/** A run being played: its decoder's frames waiting for their moment, and the one on screen. */
interface Lane {
  run: Run;
  /** which texture ring its frames go into (neighbouring lanes never share one) */
  ring: number;
  queue: Queued[];
  cur: Queued | null;
  /** nothing more will be decoded */
  done: boolean;
  space: (() => void) | null;
}

/** Memory for frames kept for scrubbing backwards (small bitmaps), and the fewest kept. */
const REV_BYTES = 240e6;
const REV_MIN = 60;
/** cached key frames in all (each a small picture, KEY_LONG px on the long side) */
const KEYS_MAX = 240;
/** … and at most this many per file */
const KEYS_PER = 80;
const KEY_LONG = 480;
const REV_LONG = 960;


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
  private lanes: Lane[] = [];
  private runs: Run[] = [];
  private nextRun = 0;
  private imgT = 0;
  private lastTime = 0;
  /** true when stills need redrawing while playing (moving grain, flicker…) */
  stillMoves: () => boolean = () => false;
  /** copies a decoded frame to the GPU, into a lane's ring (set by the video editor) */
  upload: (vf: VideoFrame, ring: number) => GpuFrame = () => {
    throw new Error('no uploader');
  };
  private seekBusy = false;
  private seekWant: { T: number; fast: boolean; solo?: string } | null = null;
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

  /** How far the sound being made runs ahead of the sound being heard (the output's delay), seconds. */
  outputDelay() {
    if (!this.ctx) return 0;
    return Math.max(0, Math.min(0.5, this.ctx.currentTime - this.audioNow()));
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

  /** Let go of what scrubbing keeps ready (before an export, which needs the memory and the decoders). */
  freeScrub() {
    clearTimeout(this.settle);
    this.seekWant = null;
    this.closeScrub();
    this.closeOther();
    this.clearRev();
    this.scrubClip = '';
  }

  /** Move the playhead without showing its frame (paused only). */
  setTime(T: number) {
    if (!this.playing) this.T = Math.max(0, T);
  }

  /**
   * Show the frame at T without moving the playhead (e.g. the edge being trimmed: `solo`, that
   * clip's own frame even where a transition shows two).
   */
  peek(T: number, fast = false, solo?: string) {
    // how fast the finger is going, in timeline seconds per second
    const now = performance.now(), dt = now - this.lastReq.at;
    if (fast && dt > 0) {
      const v = Math.abs(T - this.lastReq.T) / (dt / 1000);
      this.speed = dt > 250 ? v : this.speed * 0.6 + v * 0.4;
    } else if (!fast) this.speed = 0;
    // the drag's direction, over the last eighth of a second (steadier than one step)
    this.hist.push([now, T]);
    while (this.hist.length > 2 && now - this.hist[1][0] > 120) this.hist.shift();
    const d = T - this.hist[0][1];
    this.dragDir = fast && Math.abs(d) > 0.06 ? Math.sign(d) : 0;
    this.lastReq = { T, at: now };
    this.seekWant = { T: Math.max(0, T), fast, solo };
    clearTimeout(this.settle);
    // the exact frame once requests stop coming
    if (fast) this.settle = window.setTimeout(() => this.peek(T, false, solo), 110);
    if (!this.seekBusy) void this.seekLoop();
  }
  private settle = 0;
  /** the clip the scrub tracking below belongs to */
  private scrubClip = '';
  private speed = 0;
  private hist: [number, number][] = [];
  /** which way the finger is going: 1, -1, or 0 (still / unclear) */
  private dragDir = 0;

  /** While dragging, a frame that would step back against the drag (from a wobble): skip it. */
  private against(m: Media, ts: number) {
    if (!this.dragDir || this.shownTs.media !== m.id) return false;
    return (ts - this.shownTs.ts) * this.dragDir < -0.05;
  }
  /** how many frames a second scrub decoding keeps up with (learnt while dragging) */
  private decCap = 180;
  private probeAt = 0;
  private lastReq = { T: 0, at: 0 };

  // ---- key frame cache: every whole frame the file stores (about one a second), decoded once
  // in the background into small pictures. A fast drag shows these instantly, with no decoding
  // at all; the decoder takes over as the finger slows, and the exact frame lands when it stops.

  private keys = new Map<string, { ts: number; bmp: ImageBitmap }[]>();
  private keyBusy = new Set<string>();
  private keyTotal = 0;
  /** when each file's key frames were last used (the longest unused make room for others) */
  private keyUsed = new Map<string, number>();
  private disposed = false;

  async buildKeys(m: Media) {
    if (!m.video || this.disposed || this.keys.has(m.id) || this.keyBusy.has(m.id)) return;
    this.keyBusy.add(m.id);
    try {
      let ks = this.keySinks.get(m.id);
      if (!ks) this.keySinks.set(m.id, (ks = new EncodedPacketSink(m.video)));
      const ts: number[] = [];
      let pk = await ks.getKeyPacket(0, { metadataOnly: true });
      while (pk && ts.length < 20000) {
        ts.push(pk.timestamp);
        pk = await ks.getNextKeyPacket(pk, { metadataOnly: true });
      }
      if (this.disposed) return;
      // every file gets its share: a long one keeps an even spread of its key frames, and
      // when the cache is full the file that's gone unused the longest makes room
      const step = Math.max(1, Math.ceil(ts.length / KEYS_PER));
      const pick = ts.filter((_, i) => i % step === 0);
      while (this.keyTotal + pick.length > KEYS_MAX) {
        let old: string | null = null;
        for (const id of this.keys.keys()) {
          if (id === m.id || this.keyBusy.has(id)) continue;
          if (old === null || (this.keyUsed.get(id) ?? 0) < (this.keyUsed.get(old) ?? 0)) old = id;
        }
        if (old === null) break;
        for (const k of this.keys.get(old)!) k.bmp.close();
        this.keyTotal -= this.keys.get(old)!.length;
        this.keys.delete(old);
      }
      this.keyUsed.set(m.id, performance.now());
      const sink = new CanvasSink(m.video, { width: m.w >= m.h ? KEY_LONG : undefined, height: m.w < m.h ? KEY_LONG : undefined, fit: 'contain' });
      const out: { ts: number; bmp: ImageBitmap }[] = [];
      this.keys.set(m.id, out);
      let i = 0;
      for await (const w of sink.canvasesAtTimestamps(pick)) {
        const t = pick[i++];
        if (!w) continue;
        // (the sink's picture is already turned upright, unlike raw frames: see Frame.upright)
        const bmp = await createImageBitmap(w.canvas);
        if (this.disposed || this.keys.get(m.id) !== out) {
          // closed (or made room for another file) meanwhile
          bmp.close();
          break;
        }
        out.push({ ts: w.timestamp ?? t, bmp });
        this.keyTotal++;
        if (this.playing) await new Promise((r) => setTimeout(r, 50)); // stay out of playback's way
      }
    } catch (e) {
      console.warn('key frame cache failed', e);
    } finally {
      this.keyBusy.delete(m.id);
    }
  }

  /**
   * The cached key frame to show for a fast drag to t: between the screen and the finger (never
   * past the finger, so nothing has to come back), and nearest the finger. Going forward it must
   * also be ahead of the scrub decoder, otherwise decoding on is as quick and shows more frames.
   * `wide` (a very fast drag, faster than any decoder): the nearest one either side of the
   * finger, up to half a second past it.
   */
  private keyNear(m: Media, t: number, dir: number, shown: number | null, wide: boolean) {
    const K = this.keys.get(m.id);
    if (!K) {
      // (made room for other files earlier: get them back now that this one is being scrubbed)
      void this.buildKeys(m);
      return null;
    }
    if (!K.length) return null;
    this.keyUsed.set(m.id, performance.now());
    const sc = this.scrub?.media === m.id ? this.scrub : null;
    let best: (typeof K)[number] | null = null;
    for (const k of K) {
      if (wide) {
        if (Math.abs(k.ts - t) > 0.5 || (shown !== null && (dir > 0 ? k.ts <= shown + 1e-4 : k.ts >= shown - 1e-4))) continue;
        if (!best || Math.abs(k.ts - t) < Math.abs(best.ts - t)) best = k;
      } else if (dir > 0) {
        if (k.ts > t + 1e-4 || (shown !== null && k.ts <= shown + 1e-4) || (sc && k.ts <= sc.ts + 1e-4)) continue;
        if (!best || k.ts > best.ts) best = k;
      } else {
        if (k.ts < t - 0.04 || (shown !== null && k.ts >= shown - 1e-4)) continue;
        if (!best || k.ts < best.ts) best = k;
      }
    }
    return best;
  }

  /**
   * One open decoder for scrubbing: moving forward a little just decodes on from where it is
   * (cheap); anything else restarts it at the stored whole frame ("key frame") before T.
   */
  private scrub: { media: string; it: AsyncGenerator<VideoSample, void, unknown>; ts: number; peek: VideoSample | null } | null = null;
  private keySinks = new Map<string, EncodedPacketSink>();

  private closeScrub() {
    const sc = this.scrub;
    if (!sc) return;
    this.scrub = null;
    sc.peek?.close();
    void sc.it.return().catch(() => {});
  }

  // ---- paused inside a transition, the other clip's frame comes from a second decoder of its
  // own (kept going forwards like the first one), or from the key frame cache while dragging

  private other: { media: string; it: AsyncGenerator<VideoSample, void, unknown>; ts: number; peek: VideoSample | null } | null = null;

  private closeOther() {
    const o = this.other;
    if (!o) return;
    this.other = null;
    o.peek?.close();
    void o.it.return().catch(() => {});
  }

  /** The other clip's frame for a transition at timeline time T (the receiver closes its sample). */
  private async otherFrame(clip: VClip, start: number, T: number, fast: boolean): Promise<Frame | null> {
    const m = this.lib.get(clip.src);
    if (!m) return null;
    if (m.kind === 'image') return { clip, media: m, sample: null, t: T };
    const sink = this.vSink(m);
    if (!sink) return null;
    const t = Math.min(clip.out - 1e-4, Math.max(clip.in, srcAt(clip, T - start)), m.duration - 1e-3);
    if (fast && this.speed > 1.5) {
      // dragging quickly: the nearest cached key frame will do
      let best: { ts: number; bmp: ImageBitmap } | null = null;
      for (const k of this.keys.get(m.id) ?? []) if (!best || Math.abs(k.ts - t) < Math.abs(best.ts - t)) best = k;
      if (best && Math.abs(best.ts - t) < 1.2) return { clip, media: m, sample: null, bitmap: best.bmp, ts: best.ts, t: T, upright: true };
    }
    let o = this.other?.media === m.id ? this.other : null;
    if (!o || t < o.ts - 1e-4 || t - o.ts > 1.5) {
      this.closeOther();
      const it = sink.samples(await this.keyTime(m, t));
      const r = await it.next();
      if (r.done) {
        void it.return();
        return null;
      }
      o = this.other = { media: m.id, it, ts: r.value.timestamp, peek: r.value };
    }
    let cur = o.peek;
    o.peek = null;
    for (;;) {
      if (cur && cur.timestamp + (cur.duration || 1 / 60) > t + 1e-4) break;
      const r = await o.it.next();
      if (r.done) break;
      if (r.value.timestamp > t + 1e-4) {
        o.peek = r.value;
        break;
      }
      cur?.close();
      cur = r.value;
    }
    if (!cur) return null;
    o.ts = cur.timestamp;
    return { clip, media: m, sample: cur, t: T };
  }

  private async keyTime(m: Media, t: number) {
    let ks = this.keySinks.get(m.id);
    if (!ks) this.keySinks.set(m.id, (ks = new EncodedPacketSink(m.video!)));
    const pk = await ks.getKeyPacket(t, { metadataOnly: true });
    return pk ? pk.timestamp : 0;
  }

  /** The last frame put on screen while scrubbing (source time). */
  private shownTs = { media: '', ts: -1, end: -1 };

  /**
   * The frame for source time t. Exact (finger settled): decodes all the way to t. While the
   * finger moves (fast) the rule is that the picture never jumps backwards past what's on
   * screen: small wobbles back keep the current frame, moving forward decodes on a few frames
   * per step (so it catches up smoothly), and only a big jump forward restarts at the key
   * frame before t, which is then ahead of the screen. Null: keep what's showing.
   */
  private async frameAt(m: Media, sink: VideoSampleSink, t: number, fast: boolean): Promise<VideoSample | null> {
    let sc = this.scrub?.media === m.id ? this.scrub : null;
    const shown = this.shownTs.media === m.id ? this.shownTs.ts : null;
    const ahead = sc ? t - sc.ts : -1;
    let budget = Infinity;
    if (fast) {
      if (shown !== null && t < shown) return null; // a wobble back, or reverse (handled by the cache)
      if (sc && ahead >= -1e-4 && ahead <= 1.2) {
        budget = 8; // decode on, a few frames per step
      } else {
        const kt = await this.keyTime(m, t);
        if (sc && ahead >= -1e-4 && kt <= sc.ts + 1e-4) budget = 8; // the decoder is already past t's key frame: decode on
        else {
          // restart at t's key frame; show it straight away only if it's ahead of the screen
          this.closeScrub();
          const it = sink.samples(kt);
          const r = await it.next();
          if (r.done) {
            void it.return();
            return null;
          }
          sc = this.scrub = { media: m.id, it, ts: r.value.timestamp, peek: r.value };
          if (shown === null || kt > shown + 1e-4) {
            sc.peek = null;
            return r.value;
          }
          budget = 8;
        }
      }
    } else if (!sc || ahead < -1e-4 || ahead > 1.5) {
      // exact: restart at the key frame before t, then decode up to t
      const kt = await this.keyTime(m, t);
      this.closeScrub();
      const it = sink.samples(kt);
      const r = await it.next();
      if (r.done) {
        void it.return();
        return null;
      }
      sc = this.scrub = { media: m.id, it, ts: r.value.timestamp, peek: r.value };
    }
    // decode on to the frame covering t (or as far as the budget goes)
    let cur: VideoSample | null = sc!.peek;
    sc!.peek = null;
    let n = 0, dec = 0;
    // frames decoded on the way are kept for scrubbing back over them (paused on a frame, or
    // dragging slowly, going back is the likely next move); not on fast drags, where it costs
    const keep = !this.playing && (!fast || this.speed < 3);
    for (;;) {
      if (cur && cur.timestamp + (cur.duration || 1 / 60) > t + 1e-4) break;
      if (n++ >= budget) break;
      // the finger moved again while this went to the exact frame: let the new request in
      if (!fast && this.seekWant?.fast) {
        sc!.ts = cur?.timestamp ?? sc!.ts;
        cur?.close();
        return null;
      }
      const r = await sc!.it.next();
      if (r.done) break;
      if (r.value.timestamp > t + 1e-4) {
        // already past t: keep it for later, show what we have
        sc!.peek = r.value;
        break;
      }
      if (keep && t - r.value.timestamp < 1.5) void this.revKeep(m, r.value, t);
      cur?.close();
      cur = r.value;
      dec++;
    }
    // does the decoder keep up with the finger? (decides how the fastest drags are shown)
    if (fast && dec && cur && this.speed > 2) {
      const gap = t - cur.timestamp, need = this.speed * m.fps;
      if (gap > 0.3) this.decCap = Math.min(this.decCap, need * 0.9);
      else if (gap < 0.1 && need > this.decCap * 0.85) this.decCap = Math.min(2000, Math.max(this.decCap, need * 1.15));
    }
    if (!cur) return null;
    sc!.ts = cur.timestamp;
    // still behind what's on screen (catching up from a key frame): keep it, show nothing yet
    if (fast && shown !== null && cur.timestamp < shown - 1e-4) {
      if (sc!.peek) cur.close();
      else sc!.peek = cur;
      return null;
    }
    // `cur` goes to the screen (and is closed there)
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

  /** A cached frame within a few frames after t (and before what's on screen). */
  private near(m: Media, t: number, before: number) {
    const L = this.rev.get(m.id);
    if (!L) return null;
    let best: (typeof L)[number] | null = null;
    for (const f of L) if (f.ts >= t && f.ts <= t + 0.15 && f.ts < before - 1e-4 && (!best || f.ts < best.ts)) best = f;
    return best;
  }

  /**
   * Keep a small copy of a decoded frame for scrubbing back over it. Takes its own copy of the
   * picture straight away, so the sample can be closed as soon as this returns.
   */
  private revKeep(m: Media, s: VideoSample, around: number): Promise<void> {
    let L = this.rev.get(m.id);
    if (!L) this.rev.set(m.id, (L = []));
    const list = L, ts = s.timestamp;
    const has = () => list.some((f) => Math.abs(f.ts - ts) < 1e-4);
    if (has()) return Promise.resolve();
    const vf = s.toVideoFrame();
    const k = Math.min(1, REV_LONG / Math.max(vf.displayWidth, vf.displayHeight));
    return createImageBitmap(vf, { resizeWidth: Math.max(2, Math.round(vf.displayWidth * k)), resizeHeight: Math.max(2, Math.round(vf.displayHeight * k)), resizeQuality: 'medium' })
      .then((bmp) => {
        // cleared meanwhile (an edit), or kept twice: drop it
        if (this.rev.get(m.id) !== list || has()) return bmp.close();
        list.push({ ts, end: ts + (s.duration || 1 / 30), bmp });
        this.revCount++;
        this.revBytes = bmp.width * bmp.height * 4;
        this.revTrim(m, around);
      })
      .catch(() => {})
      .finally(() => vf.close());
  }

  /** bytes of one cached frame (the cache holds as many as fit REV_BYTES) */
  private revBytes = 960 * 540 * 4;

  /** Bounded: drop the frames furthest from where we are (other clips' first). */
  private revTrim(m: Media, t: number) {
    const max = Math.max(REV_MIN, Math.floor(REV_BYTES / this.revBytes));
    while (this.revCount > max) {
      let worst: { list: { bmp: ImageBitmap }[]; i: number; d: number } | null = null;
      for (const [id, list] of this.rev) list.forEach((f, i) => {
        const d = Math.abs(f.ts - t) + (id === m.id ? 0 : 1e6);
        if (!worst || d > worst.d) worst = { list, i, d };
      });
      if (!worst) break;
      const w = worst as { list: { bmp: ImageBitmap }[]; i: number };
      w.list[w.i].bmp.close();
      w.list.splice(w.i, 1);
      this.revCount--;
    }
  }

  /** Decode the key frame up to t into the cache (what's after t has been passed already). */
  private async fillBack(m: Media, sink: VideoSampleSink, t: number) {
    const kt = await this.keyTime(m, t);
    const L = this.rev.get(m.id) ?? [];
    this.rev.set(m.id, L);
    // stopping early at frames that are cached
    const next = L.filter((f) => f.ts > kt).reduce((a, f) => Math.min(a, f.ts), t + 0.05);
    if (next <= kt) return this.cached(m, t);
    for await (const s of sink.samples(kt, next)) {
      try {
        await this.revKeep(m, s, t);
      } finally {
        s.close();
      }
      if (this.playing) break;
    }
    return this.cached(m, t);
  }

  /**
   * Going back over cached frames: get the second before them decoding now, so it's ready
   * by the time the finger gets there (instead of starting when it arrives, and stalling).
   */
  private prefetchBack(m: Media, sink: VideoSampleSink, t: number) {
    if (this.filling || this.playing) return;
    this.filling = (async () => {
      const kt = await this.keyTime(m, t);
      if (kt <= 0.02) return;
      if (!this.cached(m, kt - 0.01)) return void (await this.fillBack(m, sink, kt - 0.01));
      // going back briskly: the second before that one too, if the cache has room for it
      if (this.speed < 1.2) return;
      const k1 = await this.keyTime(m, kt - 0.01);
      const room = Math.max(REV_MIN, Math.floor(REV_BYTES / this.revBytes));
      if (k1 > 0.02 && !this.cached(m, k1 - 0.01) && (t - k1 + 1) * (m.fps || 30) < room * 0.9) await this.fillBack(m, sink, k1 - 0.01);
    })()
      .catch(() => {})
      .finally(() => (this.filling = null));
  }

  private clearRev() {
    for (const L of this.rev.values()) for (const f of L) f.bmp.close();
    this.rev.clear();
    this.revCount = 0;
  }

  private async seekLoop() {
    this.seekBusy = true;
    try {
      while (this.seekWant !== null && !this.disposed) {
        const { T, fast, solo } = this.seekWant;
        this.seekWant = null;
        const p = this.project();
        const L = layout(p);
        let at = clipAt(p, T, L);
        const si = solo ? p.clips.findIndex((c) => c.id === solo) : -1;
        if (si >= 0) {
          const c = p.clips[si];
          at = { i: si, start: L.starts[si], src: Math.min(c.out - 1e-4, Math.max(c.in, srcAt(c, T - L.starts[si]))) };
        }
        if (!at) continue;
        const clip = p.clips[at.i];
        const m = this.lib.get(clip.src);
        if (!m) continue;
        // inside a transition: the other clip's frame goes along with this one's
        const mix = si >= 0 ? null : mixAt(p, T, L);
        const oi = mix ? (mix.a === at.i ? mix.b : mix.a) : -1;
        const show = async (f: Frame) => {
          if (oi >= 0) {
            const o = await this.otherFrame(p.clips[oi], L.starts[oi], T, fast).catch(() => null);
            if (o) f.other = o;
          } else if (si >= 0) f.solo = true;
          this.onFrame(f);
        };
        if (m.kind === 'image') {
          this.scrubClip = clip.id;
          await show({ clip, media: m, sample: null, t: T });
          continue;
        }
        const sink = this.vSink(m);
        if (!sink) continue;
        const t = Math.min(at.src, m.duration - 1e-3);
        if (clip.id !== this.scrubClip) {
          // onto another clip: what was on screen says nothing about this one (it can be the
          // same file at an earlier moment, a copy or a moved half). Coming in backwards, it
          // carries on as a reverse drag from just past this point
          this.scrubClip = clip.id;
          const back = fast && this.dragDir < 0;
          this.shownTs = { media: back ? m.id : '', ts: Infinity, end: Infinity };
          this.lastT = { media: back ? m.id : '', t: t + 1e-3 };
        } else if (this.shownTs.ts === Infinity && this.dragDir > 0) {
          // came in backwards, turned round before anything showed: an ordinary forward drag
          this.shownTs = { media: '', ts: -1, end: -1 };
        }
        // a fast drag: the cached key frame nearest the finger, no decoding at all
        if (fast && this.speed > 2.5) {
          const dir = this.dragDir || (this.lastT.media === m.id ? Math.sign(t - this.lastT.t) : 1);
          const shown = this.shownTs.media === m.id ? this.shownTs.ts : null;
          // faster than the decoder can go through frames
          const wide = this.speed * m.fps > this.decCap;
          const k = dir ? this.keyNear(m, t, dir, shown, wide) : null;
          if (k) {
            // the decoder is behind it: start it again from this key frame (t's own, going forward)
            if (dir > 0) this.closeScrub();
            await show({ clip, media: m, sample: null, bitmap: k.bmp, ts: k.ts, t: T, upright: true, fast: true });
            this.shownTs = { media: m.id, ts: k.ts, end: k.ts + 1 / (m.fps || 30) };
            this.lastT = { media: m.id, t };
            continue;
          }
          if (dir === 0) continue;
          // too fast to decode: wait for the next key frame (the exact frame comes when it stops),
          // trying the decoder now and then in case it can keep up after all
          if (wide && this.keys.get(m.id)?.length) {
            const now = performance.now();
            if (now - this.probeAt < 150) continue;
            this.probeAt = now;
          }
        }
        // still on the frame that's showing (slow drags, wobbles): nothing to do (unless a
        // transition moves on meanwhile)
        const sh = this.shownTs;
        if (fast && oi < 0 && sh.media === m.id && t >= sh.ts - 1e-4 && t < sh.end - 1e-4) {
          this.lastT = { media: m.id, t };
          continue;
        }
        // scrubbing backwards (or wobbling forward a little on the way back): from the cache
        // when it has the frame; otherwise the quick frame now, and the second before t goes
        // into the cache in the background
        if (fast && (this.backward(m, t) || (this.dragDir < 0 && this.cached(m, t)))) {
          // the exact frame from the cache, else the nearest cached one just ahead of the finger
          const b = this.cached(m, t) ?? this.near(m, t, this.shownTs.media === m.id ? this.shownTs.ts : Infinity);
          if (b && this.against(m, b.ts)) {
            this.lastT = { media: m.id, t };
            continue;
          }
          if (b) {
            await show({ clip, media: m, sample: null, bitmap: b.bmp, ts: b.ts, t: T, fast: true });
            this.shownTs = { media: m.id, ts: b.ts, end: b.end };
            this.lastT = { media: m.id, t };
            this.prefetchBack(m, sink, t);
            continue;
          }
          if (!this.filling) this.filling = this.fillBack(m, sink, t).catch(() => {}).finally(() => (this.filling = null));
        }
        let s = await this.frameAt(m, sink, t, fast);
        if (s && fast && this.against(m, s.timestamp)) {
          s.close();
          s = null;
        }
        if (s) {
          this.shownTs = { media: m.id, ts: s.timestamp, end: s.timestamp + (s.duration || 1 / (m.fps || 30)) };
          await show({ clip, media: m, sample: s, t: T, fast });
          // stopped on a frame: have the second before it ready in case the finger goes back
          if (!fast && !this.seekWant) this.prefetchBack(m, sink, t);
        }
        this.lastT = { media: m.id, t };
      }
    } catch (e) {
      console.warn('seek failed', e);
      this.closeScrub();
      this.closeOther();
    } finally {
      this.seekBusy = false;
    }
  }

  // ---- playback

  /** The sound output (made on first use; resumed, as it rests after a pause). */
  async audioCtx() {
    this.ctx ??= new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });
    if (this.ctx.state !== 'running') await this.ctx.resume();
    clearTimeout(this.idle);
    return this.ctx;
  }

  /** How the clock started: timeline time `startT` was heard at context time `ctxStart` (playing only). */
  clock() {
    return this.playing ? { startT: this.startT, ctxStart: this.ctxStart } : null;
  }

  async play() {
    const p = this.project();
    const { total } = layout(p);
    if (!p.clips.length) return;
    if (this.T >= total - 0.05) this.T = 0;
    await this.audioCtx();
    const ctx = this.ctx!;
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
    }
    // the scrub decoders aren't needed while playing (phones have only a few decoders)
    this.closeScrub();
    this.closeOther();
    clearTimeout(this.settle);
    clearTimeout(this.idle);
    this.seekWant = null;
    // what the last scrub left on screen says nothing about where playback ends up
    this.scrubClip = '';
    this.shownTs = { media: '', ts: -1, end: -1 };
    this.lastT = { media: '', t: -1 };
    this.hist = [];
    this.playing = true;
    this.drops = 0;
    this.shown = 0;
    const token = ++this.token;
    this.startT = this.T;
    this.lastTime = this.T;
    this.ctxStart = ctx.currentTime + 3600; // the clock holds at startT until it really starts
    this.lanes = [];
    this.runs = this.plan(this.startT);
    this.nextRun = 0;
    this.shownKey = '';
    // the soundtrack (normally mixed already, in the background after each edit) and the
    // first frame, both ready before the clock starts
    const mixP = this.audio.mix(p);
    this.feed(token);
    const firstFrame = new Promise<void>((r) => {
      const t0 = performance.now();
      const wait = () => (this.lanes.some((l) => l.queue.length) || !this.alive(token) || performance.now() - t0 > 1500 ? r() : setTimeout(wait, 4));
      wait();
    });
    const [mix] = await Promise.all([mixP.catch(() => null), firstFrame]);
    if (!this.alive(token)) return;
    this.ctxStart = ctx.currentTime + 0.05;
    if (mix && this.startT < mix.duration) {
      const src = ctx.createBufferSource();
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
    for (const l of this.lanes) {
      l.queue = [];
      l.space?.();
    }
    this.lanes = [];
    // the sound output rests after a few quiet seconds (it wakes on the next play)
    clearTimeout(this.idle);
    this.idle = window.setTimeout(() => !this.playing && void this.ctx?.suspend().catch(() => {}), 4000);
  }
  private idle = 0;
  /** how long one screen refresh takes, in seconds (measured while playing) */
  private refresh = 1 / 60;

  private alive(token: number) {
    return this.playing && token === this.token;
  }

  /**
   * The runs to play from T on: from the first clip still playing at T (inside a transition,
   * the outgoing one: the incoming one's lane starts straight away). Each starts decoding where
   * T falls in it, or at its beginning.
   */
  private plan(T: number): Run[] {
    const p = this.project();
    const L = layout(p);
    let i0 = p.clips.findIndex((c, i) => T < L.starts[i] + clipLen(c));
    if (i0 < 0) i0 = p.clips.length - 1;
    if (i0 < 0) return [];
    const runs: Run[] = [];
    for (let i = i0; i < p.clips.length; i++) {
      const c = p.clips[i], start = L.starts[i], end = start + clipLen(c);
      const last = runs[runs.length - 1], prev = last?.parts[last.parts.length - 1].clip;
      // clips that carry straight on in the same file (the halves of a split) play as one run,
      // through one decoder: no restart at the cut (unless a transition overlaps them there)
      if (prev && !L.ov[i] && prev.kind === 'video' && c.kind === 'video' && prev.src === c.src && Math.abs(c.in - prev.out) < 1e-3) {
        last.parts.push({ clip: c, start });
        last.end = end;
      } else {
        const from = T > start ? Math.min(c.out, Math.max(c.in, srcAt(c, T - start))) : c.in;
        runs.push({ parts: [{ clip: c, start }], from, start, end });
      }
    }
    return runs;
  }

  /**
   * Start lanes as they're needed: at most two at once (two decoders), the next one as soon as
   * the one before it has decoded everything, or a moment before its clip is due.
   */
  private feed(token: number) {
    while (this.alive(token) && this.nextRun < this.runs.length && this.lanes.length < 2) {
      const r = this.runs[this.nextRun];
      const prev = this.lanes[this.lanes.length - 1];
      if (prev && !prev.done && this.time < r.start - LEAD) break;
      const lane: Lane = { run: r, ring: this.nextRun & 1, queue: [], cur: null, done: false, space: null };
      this.lanes.push(lane);
      this.nextRun++;
      void this.produce(token, lane);
    }
  }

  /** Decode a run ahead, copying frames to the GPU as they come. */
  private async produce(token: number, lane: Lane) {
    const room = async () => {
      while (this.alive(token) && lane.queue.length >= QMAX) await new Promise<void>((r) => (lane.space = r));
    };
    const { parts, from } = lane.run;
    try {
      const m = this.lib.get(parts[0].clip.src);
      if (!m) return;
      if (m.kind === 'image') {
        lane.queue.push({ clip: parts[0].clip, media: m, tl: parts[0].start, pre: null });
        return;
      }
      const sink = this.vSink(m);
      if (!sink) return;
      let it = sink.samples(from, parts[parts.length - 1].clip.out);
      let lastTl = -Infinity, pi = 0, first = true;
      try {
        for (;;) {
          const r = await it.next();
          if (r.done) break;
          const s = r.value;
          if (!this.alive(token)) {
            s.close();
            return;
          }
          // which clip of the run this frame belongs to
          while (pi < parts.length - 1 && s.timestamp >= parts[pi].clip.out - 1e-4) pi++;
          const { clip, start } = parts[pi];
          const tl = Math.max(start, start + localAt(clip, s.timestamp));
          // sped up: frames that would land on the same screen refresh are never seen, don't upload them
          if (tl - lastTl < this.refresh * 0.9 && tl < start + clipLen(clip) - 0.05) {
            s.close();
            continue;
          }
          // decoding has fallen behind the sound: late frames are dropped unshown (uploading
          // them is what costs), and far behind, decoding jumps ahead to where the sound is
          const late = this.time - tl;
          if (!first && late > 0.08) {
            s.close();
            this.drops++;
            if (late > 0.75) {
              const to = this.time + 0.25;
              const q = parts.findIndex((x) => to < x.start + clipLen(x.clip));
              if (q < 0) break;
              pi = q;
              void it.return().catch(() => {});
              it = sink.samples(srcAt(parts[q].clip, Math.max(0, to - parts[q].start)), parts[parts.length - 1].clip.out);
            }
            continue;
          }
          first = false;
          lastTl = tl;
          const vf = s.toVideoFrame();
          let pre: GpuFrame;
          try {
            pre = this.upload(vf, lane.ring);
          } finally {
            vf.close();
            s.close();
          }
          lane.queue.push({ clip, media: m, tl, pre });
          await room();
        }
      } finally {
        void it.return().catch(() => {});
      }
    } catch (e) {
      console.warn('playback decode failed', e);
    } finally {
      lane.done = true;
      // the next lane can start now
      this.feed(token);
    }
  }

  /** what was handed over last (to tell when there's something new to show) */
  private shownKey = '';

  /** One loop, once per screen refresh: show the frame that's due, move the playhead. */
  private present(token: number) {
    let prev = 0;
    const ids = new WeakMap<Queued, number>();
    let nid = 0;
    const id = (q: Queued | null) => {
      if (!q) return 0;
      let n = ids.get(q);
      if (!n) ids.set(q, (n = ++nid));
      return n;
    };
    const step = (now: number) => {
      if (!this.alive(token)) return;
      if (prev && now - prev > 3 && now - prev < 40) this.refresh += ((now - prev) / 1000 - this.refresh) * 0.1;
      prev = now;
      const t = this.time;
      const p = this.project();
      const L = layout(p);
      if (t >= L.total) {
        this.pause();
        this.T = L.total;
        this.onTime(L.total);
        this.onEnd();
        return;
      }
      // each lane: the latest of its frames that's due
      for (const lane of this.lanes) {
        let due: Queued | null = null;
        while (lane.queue.length && lane.queue[0].tl <= t + 0.002) {
          const q = lane.queue.shift()!;
          if (due) this.drops++; // a later frame is due too: this one never got its moment
          due = q;
        }
        if (due) {
          this.shown++;
          lane.cur = due;
          lane.space?.();
        }
      }
      // lanes whose clips are over (and the next ones, now there's room)
      const before = this.lanes.length;
      this.lanes = this.lanes.filter((l) => !(l.done && !l.queue.length && t >= l.run.end));
      if (this.lanes.length !== before || this.nextRun < this.runs.length) this.feed(token);
      // the frame of a clip at T: from the lane playing it
      const laneOf = (i: number) => this.lanes.find((l) => l.run.parts.some((x) => x.clip === p.clips[i])) ?? null;
      const at = clipAt(p, t, L);
      const mix = mixAt(p, t, L);
      let main: Queued | null = null, other: Queued | null = null;
      if (at) {
        main = laneOf(at.i)?.cur ?? null;
        if (mix) other = laneOf(mix.a === at.i ? mix.b : mix.a)?.cur ?? null;
        // (the incoming clip's lane hasn't got a frame yet: keep showing what there is)
        if (!main) [main, other] = [other, null];
      }
      main ??= this.lanes[0]?.cur ?? null;
      const key = `${id(main)}:${id(other)}`;
      const still = main && main.media.kind === 'image' && ((main.clip.kf?.length ?? 0) > 1 || this.stillMoves()) && t - this.imgT >= 1 / 60;
      if (main && (key !== this.shownKey || (mix && other) || still)) {
        // (a transition moves on every refresh, like a photo with keyframes or moving grain)
        this.shownKey = key;
        this.imgT = t;
        const fr = (q: Queued): Frame => ({ clip: q.clip, media: q.media, sample: null, pre: q.pre ?? undefined, t: q.media.kind === 'image' ? t : q.tl });
        const f = fr(main);
        if (other) f.other = fr(other);
        // the timeline time the picture is for: the frame's own, or now for a transition / still
        if (mix && other) f.t = t;
        this.onFrame(f);
      }
      this.onTime(t);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Forget decoders for media no longer used. */
  dispose() {
    this.disposed = true;
    this.pause();
    clearTimeout(this.idle);
    clearTimeout(this.settle);
    this.seekWant = null;
    this.closeScrub();
    this.closeOther();
    this.clearRev();
    for (const K of this.keys.values()) for (const k of K) k.bmp.close();
    this.keys.clear();
    this.keySinks.clear();
    this.vSinks.clear();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
