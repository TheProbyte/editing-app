// The timeline: clips as strips of thumbnails under a fixed playhead in the middle. Drag to
// scrub (with a flick that coasts), pinch to zoom, tap a clip to select it, drag its yellow
// handles to trim, hold a clip to pick it up and move it. A small marker on each cut opens its
// transition. Text titles, the music and the voiceover sit in thin lanes underneath.
//
// Each clip is drawn from its cut to the next; where a transition overlaps two clips, the cut
// is its middle, and the stretch the two share is shaded.
import { tick } from '../ui/haptics';
import type { MediaLib } from './media';
import {
  anchorAt, clipLen, cutTime, layout, localAt, MIN_CLIP, fmtTime, speedAt, srcAt, transInto, voiceLen,
  type Layout, type VClip, type VideoProject,
} from './project';

/** selected: a clip, a title, the music, a voiceover clip, or a cut (by the clip before it) */
export type Sel = { kind: 'clip' | 'text' | 'music' | 'voice' | 'cut'; id: string } | null;

export interface TimelineHost {
  project(): VideoProject;
  /** playhead time */
  time(): number;
  /** move the playhead (scrubbing; pauses playback) */
  scrub(T: number): void;
  /** show the frame at T without moving the playhead (trimming: just that clip's frame) */
  peek(T: number, clip?: string): void;
  /** move the playhead without showing its frame (the view following a trim) */
  setTime(T: number): void;
  /** the project changed in place: re-render / remember it */
  changed(commit: boolean): void;
  select(s: Sel): void;
  selection(): Sel;
  /** a media file's waveform (loudest level per 1/100 s, 0…1), or null */
  peaks(src: string): Float32Array | null;
  /** a voiceover being recorded: from where, to where it's got */
  recording(): { t0: number; t1: number } | null;
}

const PEAK_RATE = 100;
/** The loudest level of a waveform between two source times. */
function peakIn(P: Float32Array, s0: number, s1: number) {
  let i = Math.max(0, Math.floor(Math.min(s0, s1) * PEAK_RATE)), e = Math.min(P.length, Math.ceil(Math.max(s0, s1) * PEAK_RATE) + 1);
  let mx = 0;
  for (; i < e; i++) if (P[i] > mx) mx = P[i];
  return mx;
}

const RULER = 16, CLIP_Y = 18, CLIP_H = 50, LANE_H = 11, TEXT_Y = CLIP_Y + CLIP_H + 5, MUSIC_Y = TEXT_Y + LANE_H + 4;
const VOICE_Y = MUSIC_Y + LANE_H + 4;
/** the timeline's height: the voiceover lane only shows once there's a voiceover (or one being recorded) */
export const timelineHeight = (voice: boolean) => (voice ? VOICE_Y : MUSIC_Y) + LANE_H + 4;
const VOICE = '#7fb8ff';
const REC = '#ff5a4e';
/** a cut's marker: half its size, and how near (px) a tap has to be */
const MARK = 7, MARK_HIT = 13;
const HANDLE = 12;
/** how close (px) something has to be to catch on a cut or keyframe */
const SNAP_PX = 7;
const ACCENT = '#ffc83d';

type Drag =
  | { kind: 'scroll'; x0: number; T0: number; moved: boolean; vx: number; lastX: number; lastT: number }
  | { kind: 'trimL' | 'trimR'; id: string; x0: number; in0: number; out0: number; T0: number; start: number; lastTick: number }
  | { kind: 'reorder'; from: number; to: number; x: number; baseX: number }
  | { kind: 'textMove' | 'textL' | 'textR'; id: string; x0: number; t00: number; t10: number }
  | { kind: 'voiceMove' | 'voiceL' | 'voiceR'; id: string; x0: number; t00: number; in0: number; out0: number }
  | { kind: 'pinch'; d0: number; pps0: number };

export class Timeline {
  pps = 60;
  private c: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private drag: Drag | null = null;
  private pts = new Map<number, { x: number; y: number }>();
  private hold = 0;
  private down: { x: number; y: number; t: number; id: number } | null = null;
  private coast = 0;
  private raf = 0;

  constructor(host: HTMLElement, private h: TimelineHost, private lib: MediaLib) {
    this.c = document.createElement('canvas');
    this.c.className = 'tl-canvas';
    host.appendChild(this.c);
    this.ctx = this.c.getContext('2d')!;
    this.bind();
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.c);
  }
  private ro: ResizeObserver;

  /** The editor is closing: nothing here runs again. */
  dispose() {
    this.ro.disconnect();
    cancelAnimationFrame(this.coast);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.hold);
  }

  private snapped: number | null = null;

  /**
   * T pulled onto the nearest cut, keyframe, title edge (or the playhead, for things other than
   * the playhead itself) within a few pixels; a tick when it catches.
   */
  snap(T: number, p: VideoProject, skipText: string | null, playhead = false) {
    const L = layout(p);
    const { starts, total } = L;
    const pts = [0, total];
    p.clips.forEach((c, i) => {
      pts.push(cutTime(L, i));
      for (const k of c.kf ?? []) pts.push(starts[i] + localAt(c, k.s));
      for (const k of c.look?.kf ?? []) pts.push(starts[i] + localAt(c, k.s));
    });
    for (const t of p.texts) if (t.id !== skipText) pts.push(t.t0, t.t1);
    for (const v of p.voice ?? []) if (v.id !== skipText) pts.push(v.t0, v.t0 + voiceLen(v));
    if (!playhead) pts.push(this.h.time());
    const reach = SNAP_PX / this.pps;
    let best: number | null = null;
    for (const x of pts) if (Math.abs(x - T) < reach && (best === null || Math.abs(x - T) < Math.abs(best - T))) best = x;
    if (best !== null && best !== this.snapped) tick();
    this.snapped = best;
    return best ?? T;
  }

  /** The title or voiceover clip being dragged right now, if any (it isn't put back on its shot meanwhile). */
  draggingText() {
    const d = this.drag;
    return d && (d.kind === 'textMove' || d.kind === 'textL' || d.kind === 'textR' || d.kind === 'voiceMove' || d.kind === 'voiceL' || d.kind === 'voiceR') ? d.id : undefined;
  }

  /** Stop a flick that's still coasting. */
  stopCoast() {
    cancelAnimationFrame(this.coast);
  }

  /** Fit the whole project in view (at most a sensible zoom). */
  fitAll() {
    const total = layout(this.h.project()).total || 1;
    const w = this.c.clientWidth || 360;
    this.pps = Math.max(8, Math.min(120, (w * 0.42) / total));
  }

  private x(t: number) {
    return this.c.clientWidth / 2 + (t - this.h.time()) * this.pps;
  }

  draw() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }

  private paint() {
    const c = this.c, ctx = this.ctx;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    const p = this.h.project();
    const L = layout(p);
    const { starts, total } = L;
    const sel = this.h.selection();
    const T = this.h.time();

    // ruler: a tick per step, a label every few
    const step = [0.25, 0.5, 1, 2, 5, 10, 30, 60].find((s) => s * this.pps >= 14) ?? 60;
    const t0 = Math.max(0, Math.floor((T - W / 2 / this.pps) / step) * step);
    ctx.font = '600 9px Silkscreen, monospace';
    ctx.textBaseline = 'top';
    for (let t = t0; t <= Math.min(total, T + W / 2 / this.pps) + step; t += step) {
      const x = Math.round(this.x(t));
      const major = Math.round(t / step) % 4 === 0;
      ctx.fillStyle = major ? 'rgba(242,239,232,0.55)' : 'rgba(242,239,232,0.22)';
      ctx.fillRect(x, major ? 9 : 12, 1, major ? 6 : 3);
      if (major) {
        ctx.fillStyle = 'rgba(242,239,232,0.5)';
        ctx.fillText(fmtTime(t, step < 1), x + 3, 1);
      }
    }

    const reorder = this.drag?.kind === 'reorder' ? this.drag : null;
    if (reorder) {
      this.paintReorder(reorder);
    } else {
      // the clips come from a cached strip covering three screen widths: while playing or
      // scrolling, that's one image copy per refresh rather than every thumbnail again
      const st = this.stripFor(T, W, dpr, p, L);
      const dx = Math.round((W / 2 + (st.t0 - T) * this.pps) * dpr) / dpr;
      ctx.drawImage(st.c, 0, 0, st.c.width, st.c.height, dx, CLIP_Y, st.w, CLIP_H);
      // look keyframes (any clip): light diamonds along the top
      p.clips.forEach((cl, i) => {
        if (!cl.look?.kf?.length) return;
        const x0 = this.x(cutTime(L, i)), x1 = this.x(cutTime(L, i + 1));
        if (x1 < 0 || x0 > W) return;
        for (const k of cl.look.kf) {
          const kx = this.x(starts[i] + localAt(cl, k.s));
          if (kx < x0 - 1 || kx > x1 + 1) continue;
          this.diamond(Math.round(kx), CLIP_Y + 7, true);
        }
      });
      // the selected clip: a yellow frame with trim handles
      if (sel?.kind === 'clip') {
        const i = p.clips.findIndex((c) => c.id === sel.id);
        if (i >= 0) {
          const x0 = this.x(cutTime(L, i)), x1 = this.x(cutTime(L, i + 1));
          this.frame(x0, x1, CLIP_Y, CLIP_H);
          // its keyframes: diamonds along the bottom (the one under the playhead filled)
          const cl = p.clips[i];
          for (const k of cl.kf ?? []) {
            const kx = this.x(starts[i] + localAt(cl, k.s));
            if (kx < x0 - 1 || kx > x1 + 1) continue;
            const here = Math.abs(kx - W / 2) < 2;
            this.diamond(Math.round(kx), CLIP_Y + CLIP_H - 7, here);
          }
        }
      }
      this.paintCuts(p, L, sel, W);
    }

    // text lane
    for (const tx of p.texts) {
      const x0 = this.x(tx.t0), x1 = this.x(tx.t1);
      if (x1 < 0 || x0 > W) continue;
      const on = sel?.kind === 'text' && sel.id === tx.id;
      ctx.fillStyle = on ? ACCENT : 'rgba(255,200,61,0.38)';
      ctx.fillRect(x0, TEXT_Y, Math.max(2, x1 - x0), LANE_H);
      ctx.fillStyle = on ? '#141414' : 'rgba(20,20,20,0.9)';
      ctx.font = '700 8px Silkscreen, monospace';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, TEXT_Y, x1 - x0, LANE_H);
      ctx.clip();
      ctx.fillText('T ' + tx.text.toUpperCase(), x0 + 4 + (on ? HANDLE * 0.6 : 0), TEXT_Y + 2);
      ctx.restore();
      if (on) {
        ctx.fillStyle = '#141414';
        ctx.fillRect(x0 + 2, TEXT_Y + 3, 2, LANE_H - 6);
        ctx.fillRect(x1 - 4, TEXT_Y + 3, 2, LANE_H - 6);
      }
    }
    // music lane
    if (p.music) {
      const m = this.lib.get(p.music.src);
      const len = Math.min(total, Math.max(0, (m?.duration ?? 0) - p.music.in));
      const x0 = this.x(0), x1 = this.x(len);
      const on = sel?.kind === 'music';
      ctx.fillStyle = on ? '#7fe0a0' : 'rgba(127,224,160,0.35)';
      ctx.fillRect(x0, MUSIC_Y, Math.max(2, x1 - x0), LANE_H);
      // the song's waveform, centred in the lane
      const P = this.h.peaks(p.music.src);
      if (P) {
        ctx.fillStyle = on ? 'rgba(20,20,20,0.35)' : 'rgba(127,224,160,0.55)';
        const xs = Math.max(x0, 0), xe = Math.min(x1, W);
        for (let x = xs; x < xe; x += 2) {
          const t = p.music.in + (x - this.x(0)) / this.pps;
          const a = peakIn(P, t, t + 2 / this.pps);
          const bar = Math.max(1, Math.round(a * (LANE_H - 2)));
          ctx.fillRect(x, MUSIC_Y + (LANE_H - bar) / 2, 1.5, bar);
        }
      }
      ctx.fillStyle = 'rgba(20,20,20,0.9)';
      ctx.font = '700 8px Silkscreen, monospace';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, MUSIC_Y, Math.max(0, x1 - x0), LANE_H);
      ctx.clip();
      ctx.fillText('♪ ' + p.music.name.toUpperCase(), Math.max(x0, 0) + 4, MUSIC_Y + 2);
      ctx.restore();
    }
    // voiceover lane
    const rec = this.h.recording();
    for (const v of p.voice ?? []) {
      const x0 = this.x(v.t0), x1 = this.x(v.t0 + voiceLen(v));
      if (x1 < 0 || x0 > W) continue;
      const on = sel?.kind === 'voice' && sel.id === v.id;
      ctx.fillStyle = on ? VOICE : 'rgba(127,184,255,0.38)';
      ctx.fillRect(x0, VOICE_Y, Math.max(2, x1 - x0), LANE_H);
      const P = this.h.peaks(v.src);
      if (P) {
        ctx.fillStyle = on ? 'rgba(20,20,20,0.35)' : 'rgba(127,184,255,0.7)';
        const xs = Math.max(x0, 0), xe = Math.min(x1, W);
        for (let x = xs; x < xe; x += 2) {
          const t = v.in + (x - x0) / this.pps;
          const a = peakIn(P, t, t + 2 / this.pps) * Math.min(1, Math.max(0.2, v.vol));
          const bar = Math.max(1, Math.round(a * (LANE_H - 2)));
          ctx.fillRect(x, VOICE_Y + (LANE_H - bar) / 2, 1.5, bar);
        }
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, VOICE_Y, Math.max(0, x1 - x0), LANE_H);
      ctx.clip();
      ctx.fillStyle = 'rgba(20,20,20,0.9)';
      ctx.font = '700 8px Silkscreen, monospace';
      ctx.fillText('VOICE', Math.max(x0, 0) + 4 + (on ? HANDLE * 0.6 : 0), VOICE_Y + 2);
      ctx.restore();
      if (on) {
        ctx.fillStyle = '#141414';
        ctx.fillRect(x0 + 2, VOICE_Y + 3, 2, LANE_H - 6);
        ctx.fillRect(x1 - 4, VOICE_Y + 3, 2, LANE_H - 6);
      }
    }
    if (rec) {
      const x0 = this.x(rec.t0), x1 = this.x(rec.t1);
      ctx.fillStyle = REC;
      ctx.fillRect(x0, VOICE_Y, Math.max(2, x1 - x0), LANE_H);
      ctx.fillStyle = '#141414';
      ctx.font = '700 8px Silkscreen, monospace';
      ctx.fillText('REC', Math.max(x0, 0) + 4, VOICE_Y + 2);
    }

    // the playhead
    const cx = Math.round(W / 2);
    ctx.fillStyle = '#f2efe8';
    ctx.fillRect(cx - 1, RULER - 2, 2, H - RULER + 2);
    ctx.fillRect(cx - 4, RULER - 4, 8, 3);
    ctx.fillRect(cx - 3, RULER - 1, 6, 1);
    if (!p.clips.length) {
      ctx.fillStyle = 'rgba(242,239,232,0.5)';
      ctx.font = '600 10px Silkscreen, monospace';
      ctx.fillText('ADD A CLIP WITH +', 14, CLIP_Y + 20);
    }
  }

  private strip: { c: HTMLCanvasElement; t0: number; w: number; key: string } | null = null;
  private thumbsVer = 0;

  /** New thumbnails arrived: the strip is redrawn. */
  thumbsChanged() {
    this.thumbsVer++;
    this.draw();
  }

  private stripFor(T: number, W: number, dpr: number, p: VideoProject, L: Layout) {
    const { starts } = L;
    const key = JSON.stringify([this.pps, W, dpr, this.thumbsVer, L.ov, p.clips.map((c) => [c.src, c.in, c.out, c.speed, c.vol, c.ramp, c.fin, c.fout])]);
    const half = W / 2 / this.pps;
    const s = this.strip;
    if (s && s.key === key && T - half >= s.t0 && T + half <= s.t0 + s.w / this.pps) return s;
    const w = W * 3, t0 = T - (W * 1.5) / this.pps;
    const c = s?.c ?? document.createElement('canvas');
    c.width = Math.round(w * dpr);
    c.height = Math.round(CLIP_H * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, CLIP_H);
    g.imageSmoothingEnabled = true;
    p.clips.forEach((cl, i) => {
      const c0 = cutTime(L, i), c1 = cutTime(L, i + 1);
      const x0 = (c0 - t0) * this.pps, x1 = (c1 - t0) * this.pps;
      if (x1 < -4 || x0 > w + 4) return;
      this.paintClip(g, w, cl, x0 + 1, x1 - 1, 0, CLIP_H, c0 - starts[i]);
      // its fades: a dark wedge at each end
      const len = clipLen(cl);
      const fi = Math.min(cl.fin ?? 0, len / 2), fo = Math.min(cl.fout ?? 0, len / 2);
      g.fillStyle = 'rgba(10,10,10,0.55)';
      if (fi > 0) this.wedge(g, (starts[i] - t0) * this.pps, (starts[i] + fi - t0) * this.pps, true, x0 + 1, x1 - 1);
      if (fo > 0) this.wedge(g, (starts[i] + len - fo - t0) * this.pps, (starts[i] + len - t0) * this.pps, false, x0 + 1, x1 - 1);
      const bx = x0 + 5 + (i > 0 ? MARK + 2 : 0);
      if (cl.ramp) this.badge(g, cl.speed !== 1 ? `Ramp ${cl.speed}×` : 'Ramp', bx, 4);
      else if (cl.speed !== 1) this.badge(g, `${cl.speed}×`, bx, 4);
      if (cl.vol === 0 && this.lib.get(cl.src)?.audio) this.badge(g, 'MUTE', x0 + 5, CLIP_H - 15);
    });
    // where a transition overlaps two clips: shaded, with a line along the top and bottom
    for (let i = 1; i < p.clips.length; i++) {
      if (!L.ov[i]) continue;
      const a = (starts[i] - t0) * this.pps, b = (starts[i] + L.ov[i] - t0) * this.pps;
      if (b < -4 || a > w + 4) continue;
      g.fillStyle = 'rgba(255,200,61,0.16)';
      g.fillRect(a, 0, b - a, CLIP_H);
      g.fillStyle = 'rgba(255,200,61,0.7)';
      g.fillRect(a, 0, b - a, 2);
      g.fillRect(a, CLIP_H - 2, b - a, 2);
    }
    this.strip = { c, t0, w, key };
    return this.strip;
  }

  /** Paint now (inside the playback loop, so the timeline moves with the frame). */
  paintNow() {
    cancelAnimationFrame(this.raf);
    this.paint();
  }

  private badge(ctx: CanvasRenderingContext2D, s: string, x: number, y: number) {
    ctx.font = '700 8px Silkscreen, monospace';
    const w = ctx.measureText(s).width + 6;
    ctx.fillStyle = 'rgba(14,14,14,0.75)';
    ctx.fillRect(x, y, w, 11);
    ctx.fillStyle = ACCENT;
    ctx.fillText(s, x + 3, y + 2);
  }

  /** A fade's darkening: a ramp from dark to clear (in) or clear to dark (out), between a and b, kept within lo…hi. */
  private wedge(g: CanvasRenderingContext2D, a: number, b: number, fadeIn: boolean, lo: number, hi: number) {
    g.save();
    g.beginPath();
    g.rect(lo, 0, Math.max(0, hi - lo), CLIP_H);
    g.clip();
    g.beginPath();
    if (fadeIn) {
      g.moveTo(a, 0);
      g.lineTo(b, 0);
      g.lineTo(a, CLIP_H);
    } else {
      g.moveTo(a, 0);
      g.lineTo(b, 0);
      g.lineTo(b, CLIP_H);
    }
    g.closePath();
    g.fill();
    g.restore();
  }

  /** The cuts' markers: tap one for its transition (filled where there is one). */
  private paintCuts(p: VideoProject, L: Layout, sel: Sel, W: number) {
    const ctx = this.ctx;
    for (let i = 1; i < p.clips.length; i++) {
      const x = Math.round(this.x(cutTime(L, i)));
      if (x < -MARK * 2 || x > W + MARK * 2) continue;
      const has = !!transInto(p, i) && L.ov[i] > 0;
      const on = sel?.kind === 'cut' && sel.id === p.clips[i - 1].id;
      const y = CLIP_Y;
      ctx.fillStyle = '#141414';
      ctx.fillRect(x - MARK - 1, y - MARK - 1, MARK * 2 + 2, MARK * 2 + 2);
      ctx.fillStyle = on ? '#f2efe8' : has ? ACCENT : 'rgba(242,239,232,0.78)';
      ctx.fillRect(x - MARK + 1, y - MARK + 1, MARK * 2 - 2, MARK * 2 - 2);
      ctx.fillStyle = '#141414';
      if (has) {
        // a bow tie: two shots meeting
        ctx.fillRect(x - 4, y - 3, 1, 7);
        ctx.fillRect(x - 3, y - 2, 1, 5);
        ctx.fillRect(x - 2, y - 1, 1, 3);
        ctx.fillRect(x + 3, y - 3, 1, 7);
        ctx.fillRect(x + 2, y - 2, 1, 5);
        ctx.fillRect(x + 1, y - 1, 1, 3);
        ctx.fillRect(x - 1, y, 2, 1);
      } else {
        ctx.fillRect(x - 3, y, 6, 1);
        ctx.fillRect(x - 0.5, y - 3, 1, 6);
      }
    }
  }

  /** A clip's strip of thumbnails between x0 and x1 (`lead`: how far into the clip x0 is, seconds). */
  private paintClip(ctx: CanvasRenderingContext2D, cullW: number, cl: VClip, x0: number, x1: number, y: number, h: number, lead = 0) {
    const m = this.lib.get(cl.src);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y, Math.max(0, x1 - x0), h);
    ctx.clip();
    ctx.fillStyle = '#26241f';
    ctx.fillRect(x0, y, x1 - x0, h);
    if (m) {
      const aspect = m.w && m.h ? m.w / m.h : 16 / 9;
      const tw = Math.max(18, Math.min(h * 1.8, h * aspect));
      for (let x = x0; x < x1; x += tw) {
        if (x + tw < 0 || x > cullW) continue;
        const t = m.kind === 'image' ? 0 : srcAt(cl, lead + (x + tw / 2 - x0) / this.pps);
        const th = this.lib.thumbAt(m, Math.min(cl.out, t));
        if (!th) continue;
        const iw = (th as HTMLCanvasElement).width, ih = (th as HTMLCanvasElement).height;
        // cover the tile
        const k = Math.max(tw / iw, h / ih);
        const sw = tw / k, sh = h / k;
        ctx.drawImage(th, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, tw, h);
      }
      // the clip's sound along its bottom (scaled by its volume)
      const P = m.kind === 'video' ? this.h.peaks(cl.src) : null;
      if (P && h > 24) {
        const bh = Math.round(h * 0.4), by = y + h - bh;
        ctx.fillStyle = 'rgba(10,10,10,0.55)';
        ctx.fillRect(x0, by, x1 - x0, bh);
        ctx.fillStyle = cl.vol > 0 ? 'rgba(242,239,232,0.85)' : 'rgba(242,239,232,0.25)';
        const k = Math.min(1, Math.max(0.15, cl.vol));
        const xs = Math.max(x0, 0), xe = Math.min(x1, cullW);
        for (let x = xs; x < xe; x += 2) {
          const a = peakIn(P, srcAt(cl, lead + (x - x0) / this.pps), srcAt(cl, lead + (x + 2 - x0) / this.pps)) * k;
          const bar = Math.max(1, Math.round(a * (bh - 3)));
          ctx.fillRect(x, by + bh - 1 - bar, 1.5, bar);
        }
      }
    }
    ctx.restore();
  }

  private diamond(x: number, y: number, on: boolean) {
    const ctx = this.ctx;
    ctx.fillStyle = '#141414';
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x + 6, y);
    ctx.lineTo(x, y + 6);
    ctx.lineTo(x - 6, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = on ? '#f2efe8' : ACCENT;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x + 4, y);
    ctx.lineTo(x, y + 4);
    ctx.lineTo(x - 4, y);
    ctx.closePath();
    ctx.fill();
  }

  private frame(x0: number, x1: number, y: number, h: number) {
    const ctx = this.ctx;
    ctx.fillStyle = ACCENT;
    ctx.fillRect(x0, y - 2, x1 - x0, 2);
    ctx.fillRect(x0, y + h, x1 - x0, 2);
    ctx.fillRect(x0 - HANDLE + 2, y - 2, HANDLE, h + 4);
    ctx.fillRect(x1 - 2, y - 2, HANDLE, h + 4);
    // grips
    ctx.fillStyle = '#141414';
    for (const gx of [x0 - HANDLE / 2 + 1, x1 + HANDLE / 2 - 3]) {
      ctx.fillRect(gx, y + h / 2 - 8, 2, 16);
    }
  }

  /** Reordering: clips become equal blocks; the one being moved follows the finger. */
  private slot = 60;
  private paintReorder(d: Extract<Drag, { kind: 'reorder' }>) {
    const p = this.h.project();
    const order = p.clips.map((_, i) => i).filter((i) => i !== d.from);
    order.splice(d.to, 0, d.from);
    order.forEach((ci, k) => {
      if (ci === d.from) return;
      const x = d.baseX + k * this.slot;
      const cl = p.clips[ci];
      this.paintClip(this.ctx, this.c.clientWidth, cl, x + 2, x + this.slot - 2, CLIP_Y + 6, CLIP_H - 12);
    });
    const cl = p.clips[d.from];
    const x = d.x - this.slot / 2;
    this.ctx.fillStyle = 'rgba(0,0,0,0.4)';
    this.ctx.fillRect(x + 4, CLIP_Y + 2, this.slot, CLIP_H);
    this.paintClip(this.ctx, this.c.clientWidth, cl, x - 2, x + this.slot + 2, CLIP_Y - 2, CLIP_H);
    this.frame(x - 2, x + this.slot + 2, CLIP_Y - 2, CLIP_H);
  }

  // ---- gestures

  private hit(x: number, y: number) {
    const p = this.h.project();
    const L = layout(p);
    const sel = this.h.selection();
    // a cut's marker (on the top edge of the strip, clear of most of the trim handles' height)
    if (Math.abs(y - CLIP_Y) <= MARK_HIT) {
      let best = -1, bd = MARK_HIT;
      for (let i = 1; i < p.clips.length; i++) {
        const d = Math.abs(x - this.x(cutTime(L, i)));
        if (d < bd) [best, bd] = [i, d];
      }
      if (best > 0) return { what: 'cut' as const, i: best };
    }
    if (y >= CLIP_Y - 6 && y <= CLIP_Y + CLIP_H + 6) {
      if (sel?.kind === 'clip') {
        const i = p.clips.findIndex((c) => c.id === sel.id);
        if (i >= 0) {
          const x0 = this.x(cutTime(L, i)), x1 = this.x(cutTime(L, i + 1));
          // the nearer handle (on a short clip both are within reach of one touch)
          const dl = Math.abs(x - (x0 - HANDLE / 2)), dr = Math.abs(x - (x1 + HANDLE / 2));
          if (Math.min(dl, dr) < HANDLE + 4) return { what: dl <= dr ? ('trimL' as const) : ('trimR' as const), i };
        }
      }
      for (let i = 0; i < p.clips.length; i++) {
        if (x >= this.x(cutTime(L, i)) && x <= this.x(cutTime(L, i + 1))) return { what: 'clip' as const, i };
      }
    }
    if (y >= TEXT_Y - 4 && y <= TEXT_Y + LANE_H + 3) {
      for (let k = p.texts.length - 1; k >= 0; k--) {
        const tx = p.texts[k];
        const x0 = this.x(tx.t0), x1 = this.x(tx.t1);
        const on = sel?.kind === 'text' && sel.id === tx.id;
        if (on && Math.abs(x - x0) < 12) return { what: 'textL' as const, i: k };
        if (on && Math.abs(x - x1) < 12) return { what: 'textR' as const, i: k };
        if (x >= x0 && x <= x1) return { what: 'text' as const, i: k };
      }
    }
    if (p.music && y >= MUSIC_Y - 4 && y <= MUSIC_Y + LANE_H + 3 && x >= this.x(0)) return { what: 'music' as const, i: 0 };
    const V = p.voice ?? [];
    if (V.length && y >= VOICE_Y - 3 && y <= VOICE_Y + LANE_H + 6) {
      for (let k = V.length - 1; k >= 0; k--) {
        const v = V[k];
        const x0 = this.x(v.t0), x1 = this.x(v.t0 + voiceLen(v));
        const on = sel?.kind === 'voice' && sel.id === v.id;
        if (on && Math.abs(x - x0) < 12) return { what: 'voiceL' as const, i: k };
        if (on && Math.abs(x - x1) < 12) return { what: 'voiceR' as const, i: k };
        if (x >= x0 && x <= x1) return { what: 'voice' as const, i: k };
      }
    }
    return null;
  }

  private bind() {
    const c = this.c;
    const local = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      cancelAnimationFrame(this.coast);
      const q = local(e);
      this.pts.set(e.pointerId, q);
      if (this.pts.size === 2) {
        clearTimeout(this.hold);
        if (this.drag && this.drag.kind !== 'scroll') return;
        const [a, b] = [...this.pts.values()];
        this.drag = { kind: 'pinch', d0: Math.abs(a.x - b.x) || 1, pps0: this.pps };
        return;
      }
      if (this.pts.size > 2) return;
      this.down = { x: q.x, y: q.y, t: e.timeStamp, id: e.pointerId };
      const p = this.h.project();
      const hit = this.hit(q.x, q.y);
      if (hit?.what === 'trimL' || hit?.what === 'trimR') {
        const cl = p.clips[hit.i];
        // (stops a running playback where it is, before the clip changes under it)
        this.h.scrub(this.h.time());
        this.drag = { kind: hit.what, id: cl.id, x0: q.x, in0: cl.in, out0: cl.out, T0: this.h.time(), start: layout(p).starts[hit.i], lastTick: 0 };
        tick();
        return;
      }
      if (hit?.what === 'voiceL' || hit?.what === 'voiceR' || (hit?.what === 'voice' && this.h.selection()?.id === p.voice![hit.i].id)) {
        const v = p.voice![hit.i];
        this.drag = { kind: hit.what === 'voice' ? 'voiceMove' : hit.what, id: v.id, x0: q.x, t00: v.t0, in0: v.in, out0: v.out };
        return;
      }
      if (hit?.what === 'textL' || hit?.what === 'textR' || (hit?.what === 'text' && this.h.selection()?.id === p.texts[hit.i].id)) {
        const tx = p.texts[hit.i];
        this.drag = { kind: hit.what === 'text' ? 'textMove' : hit.what, id: tx.id, x0: q.x, t00: tx.t0, t10: tx.t1 };
        return;
      }
      this.drag = { kind: 'scroll', x0: q.x, T0: this.h.time(), moved: false, vx: 0, lastX: q.x, lastT: e.timeStamp };
      // hold a clip to pick it up
      if (hit?.what === 'clip' && p.clips.length > 1) {
        clearTimeout(this.hold);
        const armed = performance.now();
        const pickUp = () => {
          if (this.drag?.kind !== 'scroll' || this.drag.moved) return;
          // late (the page was busy): finger moves may be waiting to be handled; let them first
          if (performance.now() - armed > 460) {
            this.hold = window.setTimeout(() => {
              if (this.drag?.kind === 'scroll' && !this.drag.moved && performance.now() - armed < 4000) pickUpNow();
            }, 60);
            return;
          }
          pickUpNow();
        };
        const pickUpNow = () => {
          tick(true);
          const baseX = q.x - this.slot / 2 - hit.i * this.slot;
          this.drag = { kind: 'reorder', from: hit.i, to: hit.i, x: q.x, baseX };
          this.draw();
        };
        this.hold = window.setTimeout(pickUp, 380);
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.pts.has(e.pointerId)) return;
      const q = local(e);
      this.pts.set(e.pointerId, q);
      const d = this.drag;
      if (!d) return;
      const p = this.h.project();
      if (d.kind === 'pinch' && this.pts.size >= 2) {
        const [a, b] = [...this.pts.values()];
        this.pps = Math.max(6, Math.min(600, (d.pps0 * Math.abs(a.x - b.x)) / d.d0));
        this.draw();
        return;
      }
      if (d.kind === 'scroll') {
        if (!d.moved && Math.abs(q.x - d.x0) < 6) return;
        if (!d.moved) clearTimeout(this.hold);
        d.moved = true;
        const total = layout(p).total;
        const dt = Math.max(1, e.timeStamp - d.lastT);
        d.vx = 0.7 * d.vx + 0.3 * ((q.x - d.lastX) / dt);
        d.lastX = q.x;
        d.lastT = e.timeStamp;
        const T = Math.max(0, Math.min(total, d.T0 - (q.x - d.x0) / this.pps));
        // a slow drag catches on cuts and keyframes (a quick one runs straight past)
        this.h.scrub(Math.abs(d.vx) < 0.5 ? this.snap(T, p, null, true) : T);
        return;
      }
      if (d.kind === 'reorder') {
        d.x = q.x;
        const to = Math.max(0, Math.min(p.clips.length - 1, Math.round((q.x - this.slot / 2 - d.baseX) / this.slot)));
        if (to !== d.to) {
          d.to = to;
          tick();
        }
        this.draw();
        return;
      }
      if (d.kind === 'trimL' || d.kind === 'trimR') {
        const cl = p.clips.find((x) => x.id === d.id);
        const m = cl && this.lib.get(cl.src);
        if (!cl || !m) return;
        // source seconds (with a ramp, at the speed of the edge being dragged)
        const rate = speedAt(cl, d.kind === 'trimL' ? d.in0 : d.out0);
        const ds = ((q.x - d.x0) / this.pps) * rate;
        const maxOut = m.kind === 'image' ? 600 : m.duration;
        if (d.kind === 'trimL') {
          cl.in = Math.max(0, Math.min(d.out0 - MIN_CLIP * rate, d.in0 + ds));
          if (m.kind === 'image') {
            // a still has no "in": trimming its start shortens it
            cl.in = 0;
            cl.out = Math.max(MIN_CLIP, Math.min(maxOut, d.out0 - ds));
          }
          // keep the right edge where it was: the view follows the left handle
          const shrink = clipLen({ ...cl, in: d.in0, out: d.out0 }) - clipLen(cl);
          this.h.setTime(Math.max(0, d.T0 - shrink));
          this.h.peek(d.start, cl.id);
        } else {
          cl.out = Math.max(cl.in + MIN_CLIP * rate, Math.min(maxOut, d.out0 + ds));
          this.h.peek(d.start + clipLen(cl) - 0.001, cl.id);
        }
        const len = clipLen(cl);
        if (Math.floor(len * 2) !== d.lastTick) {
          d.lastTick = Math.floor(len * 2);
          tick();
        }
        this.h.changed(false);
        this.draw();
        return;
      }
      if (d.kind === 'textMove' || d.kind === 'textL' || d.kind === 'textR') {
        const tx = p.texts.find((x) => x.id === d.id);
        if (!tx) return;
        const dt = (q.x - d.x0) / this.pps;
        const total = Math.max(0.5, layout(p).total);
        // the edge being moved catches on cuts, keyframes, other titles and the playhead
        if (d.kind === 'textMove') {
          const len = d.t10 - d.t00;
          let t0 = this.snap(Math.max(0, Math.min(total - len, d.t00 + dt)), p, tx.id);
          const t1 = this.snap(t0 + len, p, tx.id);
          if (t1 !== t0 + len && t0 === Math.max(0, Math.min(total - len, d.t00 + dt))) t0 = t1 - len;
          tx.t0 = Math.max(0, t0);
          tx.t1 = tx.t0 + len;
        } else if (d.kind === 'textL') tx.t0 = Math.max(0, Math.min(tx.t1 - 0.3, this.snap(d.t00 + dt, p, tx.id)));
        else tx.t1 = Math.min(total, Math.max(tx.t0 + 0.3, this.snap(d.t10 + dt, p, tx.id)));
        tx.anchor = anchorAt(p, tx.t0);
        this.h.changed(false);
        this.draw();
        return;
      }
      if (d.kind === 'voiceMove' || d.kind === 'voiceL' || d.kind === 'voiceR') {
        const v = p.voice?.find((x) => x.id === d.id);
        const m = v && this.lib.get(v.src);
        if (!v || !m) return;
        const dt = (q.x - d.x0) / this.pps;
        const total = Math.max(0.5, layout(p).total);
        const len = d.out0 - d.in0;
        if (d.kind === 'voiceMove') {
          // either edge catches
          let t0 = Math.max(0, Math.min(total - 0.1, d.t00 + dt));
          const a = this.snap(t0, p, v.id);
          if (a !== t0) t0 = a;
          else {
            const b = this.snap(t0 + len, p, v.id);
            if (b !== t0 + len) t0 = Math.max(0, b - len);
          }
          v.t0 = t0;
        } else if (d.kind === 'voiceL') {
          // the start of the recording comes back in (or goes), the rest stays where it is
          const t0 = this.snap(d.t00 + dt, p, v.id);
          const ds = Math.max(-d.in0, Math.min(len - 0.2, t0 - d.t00));
          v.in = d.in0 + ds;
          v.t0 = Math.max(0, d.t00 + ds);
        } else {
          const t1 = this.snap(d.t00 + len + dt, p, v.id);
          v.out = Math.max(d.in0 + 0.2, Math.min(m.duration, d.out0 + (t1 - d.t00 - len)));
        }
        v.anchor = anchorAt(p, v.t0);
        this.h.changed(false);
        this.draw();
      }
    });
    const up = (e: PointerEvent) => {
      if (!this.pts.has(e.pointerId)) return;
      this.pts.delete(e.pointerId);
      clearTimeout(this.hold);
      const d = this.drag;
      if (this.pts.size > 0) {
        // one finger of a pinch lifted: carry on scrolling with the other
        if (d?.kind === 'pinch') {
          const [o] = [...this.pts.values()];
          this.drag = { kind: 'scroll', x0: o.x, T0: this.h.time(), moved: true, vx: 0, lastX: o.x, lastT: e.timeStamp };
        }
        return;
      }
      this.drag = null;
      const p = this.h.project();
      if (!d) return;
      if (d.kind === 'reorder') {
        if (d.to !== d.from) {
          const [cl] = p.clips.splice(d.from, 1);
          p.clips.splice(d.to, 0, cl);
          this.h.select({ kind: 'clip', id: cl.id });
          // land the playhead at the start of the moved clip
          this.h.scrub(layout(p).starts[d.to] + 0.001);
          this.h.changed(true);
        }
        this.draw();
        return;
      }
      if (d.kind === 'trimL' || d.kind === 'trimR' || d.kind === 'textMove' || d.kind === 'textL' || d.kind === 'textR' || d.kind === 'voiceMove' || d.kind === 'voiceL' || d.kind === 'voiceR') {
        this.h.changed(true);
        this.h.scrub(this.h.time());
        this.draw();
        return;
      }
      if (d.kind === 'scroll') {
        if (!d.moved && this.down && e.type === 'pointerup') {
          const hit = this.hit(this.down.x, this.down.y);
          const cur = this.h.selection();
          if (!hit) this.h.select(null);
          else if (hit.what === 'clip') this.h.select(cur?.kind === 'clip' && cur.id === p.clips[hit.i].id ? null : { kind: 'clip', id: p.clips[hit.i].id });
          else if (hit.what === 'text') this.h.select({ kind: 'text', id: p.texts[hit.i].id });
          else if (hit.what === 'music') this.h.select(cur?.kind === 'music' ? null : { kind: 'music', id: 'music' });
          else if (hit.what === 'voice' || hit.what === 'voiceL' || hit.what === 'voiceR') this.h.select({ kind: 'voice', id: p.voice![hit.i].id });
          else if (hit.what === 'cut') {
            const id = p.clips[hit.i - 1].id;
            this.h.select(cur?.kind === 'cut' && cur.id === id ? null : { kind: 'cut', id });
          }
          tick();
          this.draw();
          return;
        }
        // a flick coasts to a stop
        let v = d.vx; // px per ms
        if (Math.abs(v) > 0.25) {
          let last = performance.now();
          const step = (now: number) => {
            const dt = now - last;
            last = now;
            v *= Math.pow(0.994, dt);
            const total = layout(this.h.project()).total;
            const T = Math.max(0, Math.min(total, this.h.time() - (v * dt) / this.pps));
            this.h.scrub(T);
            if (Math.abs(v) > 0.03 && T > 0 && T < total) this.coast = requestAnimationFrame(step);
          };
          this.coast = requestAnimationFrame(step);
        }
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    // a tap here can open a section, which moves the dock; without this the browser's
    // follow-up click lands on whatever button just slid under the finger
    c.addEventListener('touchend', (e) => e.cancelable && e.preventDefault(), { passive: false });
  }
}
