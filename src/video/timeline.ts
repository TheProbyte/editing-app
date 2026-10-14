// The timeline: clips as strips of thumbnails under a fixed playhead in the middle. Drag to
// scrub (with a flick that coasts), pinch to zoom, tap a clip to select it, drag its yellow
// handles to trim, hold a clip to pick it up and move it. Text titles and the music sit in
// thin lanes underneath.
import { tick } from '../ui/haptics';
import type { MediaLib } from './media';
import { clipLen, layout, localAt, MIN_CLIP, fmtTime, speedAt, srcAt, type VClip, type VideoProject } from './project';

export type Sel = { kind: 'clip' | 'text' | 'music'; id: string } | null;

export interface TimelineHost {
  project(): VideoProject;
  /** playhead time */
  time(): number;
  /** move the playhead (scrubbing; pauses playback) */
  scrub(T: number): void;
  /** show the frame at T without moving the playhead (trimming) */
  peek(T: number): void;
  /** the project changed in place: re-render / remember it */
  changed(commit: boolean): void;
  select(s: Sel): void;
  selection(): Sel;
}

const RULER = 16, CLIP_Y = 18, CLIP_H = 50, LANE_H = 11, TEXT_Y = CLIP_Y + CLIP_H + 5, MUSIC_Y = TEXT_Y + LANE_H + 4;
export const TIMELINE_H = MUSIC_Y + LANE_H + 4;
const HANDLE = 12;
const ACCENT = '#ffc83d';

type Drag =
  | { kind: 'scroll'; x0: number; T0: number; moved: boolean; vx: number; lastX: number; lastT: number }
  | { kind: 'trimL' | 'trimR'; id: string; x0: number; in0: number; out0: number; T0: number; start: number; lastTick: number }
  | { kind: 'reorder'; from: number; to: number; x: number; baseX: number }
  | { kind: 'textMove' | 'textL' | 'textR'; id: string; x0: number; t00: number; t10: number }
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
    new ResizeObserver(() => this.draw()).observe(this.c);
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
    const { starts, total } = layout(p);
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
      const st = this.stripFor(T, W, dpr, p, starts);
      const dx = Math.round((W / 2 + (st.t0 - T) * this.pps) * dpr) / dpr;
      ctx.drawImage(st.c, 0, 0, st.c.width, st.c.height, dx, CLIP_Y, st.w, CLIP_H);
      // look keyframes (any clip): light diamonds along the top
      p.clips.forEach((cl, i) => {
        if (!cl.look?.kf?.length) return;
        const x0 = this.x(starts[i]), x1 = this.x(starts[i] + clipLen(cl));
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
          const x0 = this.x(starts[i]), x1 = this.x(starts[i] + clipLen(p.clips[i]));
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
      ctx.fillStyle = 'rgba(20,20,20,0.9)';
      ctx.font = '700 8px Silkscreen, monospace';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, MUSIC_Y, Math.max(0, x1 - x0), LANE_H);
      ctx.clip();
      ctx.fillText('♪ ' + p.music.name.toUpperCase(), Math.max(x0, 0) + 4, MUSIC_Y + 2);
      ctx.restore();
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

  private stripFor(T: number, W: number, dpr: number, p: VideoProject, starts: number[]) {
    const key = JSON.stringify([this.pps, W, dpr, this.thumbsVer, p.clips.map((c) => [c.src, c.in, c.out, c.speed, c.vol, c.ramp])]);
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
      const x0 = (starts[i] - t0) * this.pps, x1 = (starts[i] + clipLen(cl) - t0) * this.pps;
      if (x1 < -4 || x0 > w + 4) return;
      this.paintClip(g, w, cl, x0 + 1, x1 - 1, 0, CLIP_H);
      if (cl.ramp) this.badge(g, cl.speed !== 1 ? `Ramp ${cl.speed}×` : 'Ramp', x0 + 5, 4);
      else if (cl.speed !== 1) this.badge(g, `${cl.speed}×`, x0 + 5, 4);
      if (cl.vol === 0 && this.lib.get(cl.src)?.audio) this.badge(g, 'MUTE', x0 + 5, CLIP_H - 15);
    });
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

  /** A clip's strip of thumbnails between x0 and x1. */
  private paintClip(ctx: CanvasRenderingContext2D, cullW: number, cl: VClip, x0: number, x1: number, y: number, h: number) {
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
        const t = m.kind === 'image' ? 0 : srcAt(cl, (x + tw / 2 - x0) / this.pps);
        const th = this.lib.thumbAt(m, Math.min(cl.out, t));
        if (!th) continue;
        const iw = (th as HTMLCanvasElement).width, ih = (th as HTMLCanvasElement).height;
        // cover the tile
        const k = Math.max(tw / iw, h / ih);
        const sw = tw / k, sh = h / k;
        ctx.drawImage(th, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, tw, h);
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
    const { starts } = layout(p);
    const sel = this.h.selection();
    if (y >= CLIP_Y - 6 && y <= CLIP_Y + CLIP_H + 6) {
      if (sel?.kind === 'clip') {
        const i = p.clips.findIndex((c) => c.id === sel.id);
        if (i >= 0) {
          const x0 = this.x(starts[i]), x1 = this.x(starts[i] + clipLen(p.clips[i]));
          if (Math.abs(x - (x0 - HANDLE / 2)) < HANDLE + 4) return { what: 'trimL' as const, i };
          if (Math.abs(x - (x1 + HANDLE / 2)) < HANDLE + 4) return { what: 'trimR' as const, i };
        }
      }
      for (let i = 0; i < p.clips.length; i++) {
        if (x >= this.x(starts[i]) && x <= this.x(starts[i] + clipLen(p.clips[i]))) return { what: 'clip' as const, i };
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
    if (p.music && y >= MUSIC_Y - 4 && y <= MUSIC_Y + LANE_H + 4 && x >= this.x(0)) return { what: 'music' as const, i: 0 };
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
        this.drag = { kind: hit.what, id: cl.id, x0: q.x, in0: cl.in, out0: cl.out, T0: this.h.time(), start: layout(p).starts[hit.i], lastTick: 0 };
        tick();
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
        this.h.scrub(Math.max(0, Math.min(total, d.T0 - (q.x - d.x0) / this.pps)));
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
          this.h.scrub(Math.max(0, d.T0 - shrink));
          this.h.peek(d.start);
        } else {
          cl.out = Math.max(cl.in + MIN_CLIP * rate, Math.min(maxOut, d.out0 + ds));
          this.h.peek(d.start + clipLen(cl) - 0.001);
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
        if (d.kind === 'textMove') {
          const len = d.t10 - d.t00;
          tx.t0 = Math.max(0, Math.min(total - len, d.t00 + dt));
          tx.t1 = tx.t0 + len;
        } else if (d.kind === 'textL') tx.t0 = Math.max(0, Math.min(tx.t1 - 0.3, d.t00 + dt));
        else tx.t1 = Math.min(total, Math.max(tx.t0 + 0.3, d.t10 + dt));
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
      if (d.kind === 'trimL' || d.kind === 'trimR' || d.kind === 'textMove' || d.kind === 'textL' || d.kind === 'textR') {
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
    c.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });
  }
}
