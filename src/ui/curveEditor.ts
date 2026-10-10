import { makeSpline } from '../curves';
import type { CurvePoint, Curves } from '../params';

type Channel = keyof Curves;
const STROKE: Record<Channel, string> = { rgb: '#ffffff', r: '#ff453a', g: '#32d74b', b: '#0a84ff' };

/** Touch curve editor: drag points, tap to add, drag a point off the graph (or double-tap) to remove. */
export class CurveEditor {
  el: HTMLDivElement;
  private svg: SVGSVGElement;
  channel: Channel = 'rgb';
  private drag: { idx: number; id: number; moved: boolean } | null = null;
  private lastTap = { t: 0, idx: -1 };
  hist: Float32Array | null = null;

  constructor(
    parent: HTMLElement,
    private get: () => Curves,
    private change: (c: Curves, commit: boolean) => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'curve-editor';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.el.appendChild(this.svg);
    parent.appendChild(this.el);
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('pointermove', (e) => this.move(e));
    this.el.addEventListener('pointerup', (e) => this.up(e));
    this.el.addEventListener('pointercancel', (e) => this.up(e));
  }

  show(on: boolean) {
    this.el.classList.toggle('on', on);
    if (on) this.draw();
  }

  private size() {
    const r = this.el.getBoundingClientRect();
    return { r, w: r.width, h: r.height };
  }

  private toNorm(e: PointerEvent): CurvePoint {
    const { r, w, h } = this.size();
    return [(e.clientX - r.left) / w, 1 - (e.clientY - r.top) / h];
  }

  private pts() {
    return this.get()[this.channel].map((p) => [...p] as CurvePoint);
  }

  private set(pts: CurvePoint[], commit: boolean) {
    const c = JSON.parse(JSON.stringify(this.get())) as Curves;
    c[this.channel] = pts;
    this.change(c, commit);
    this.draw();
  }

  private down(e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    this.el.setPointerCapture(e.pointerId);
    const [x, y] = this.toNorm(e);
    const pts = this.pts();
    const { w, h } = this.size();
    let best = -1;
    let bd = 1e9;
    pts.forEach(([px, py], i) => {
      const d = Math.hypot((px - x) * w, (py - y) * h);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    const now = performance.now();
    if (best >= 0 && bd < 30) {
      // double tap removes a middle point
      if (this.lastTap.idx === best && now - this.lastTap.t < 350 && best > 0 && best < pts.length - 1) {
        pts.splice(best, 1);
        this.set(pts, true);
        this.lastTap = { t: 0, idx: -1 };
        return;
      }
      this.lastTap = { t: now, idx: best };
      this.drag = { idx: best, id: e.pointerId, moved: false };
      return;
    }
    // add a point on the curve under the finger
    const f = makeSpline(pts);
    const np: CurvePoint = [clamp(x), clamp(Math.abs(f(x) - y) * h < 40 ? f(x) : y)];
    pts.push(np);
    pts.sort((a, b) => a[0] - b[0]);
    const idx = pts.indexOf(np);
    this.drag = { idx, id: e.pointerId, moved: true };
    this.set(pts, false);
  }

  private move(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    e.stopPropagation();
    const [x, y] = this.toNorm(e);
    const pts = this.pts();
    const i = this.drag.idx;
    const lo = i === 0 ? 0 : pts[i - 1][0] + 0.01;
    const hi = i === pts.length - 1 ? 1 : pts[i + 1][0] - 0.01;
    const off = y < -0.12 || y > 1.12 || x < -0.12 || x > 1.12;
    pts[i] = [Math.min(hi, Math.max(lo, x)), clamp(y)];
    this.drag.moved = true;
    this.el.classList.toggle('removing', off && i > 0 && i < pts.length - 1);
    this.set(pts, false);
  }

  private up(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    e.stopPropagation();
    const [x, y] = this.toNorm(e);
    const pts = this.pts();
    const i = this.drag.idx;
    const off = y < -0.12 || y > 1.12 || x < -0.12 || x > 1.12;
    if (off && i > 0 && i < pts.length - 1) pts.splice(i, 1);
    this.el.classList.remove('removing');
    this.drag = null;
    this.set(pts, true);
  }

  draw() {
    const { w, h } = this.size();
    if (!w || !h) return;
    const curves = this.get();
    let s = `<rect x="0" y="0" width="${w}" height="${h}" fill="rgba(0,0,0,.35)" rx="10"/>`;
    for (let i = 1; i < 4; i++) {
      s += `<line x1="${(w * i) / 4}" y1="0" x2="${(w * i) / 4}" y2="${h}" stroke="rgba(255,255,255,.14)"/>`;
      s += `<line x1="0" y1="${(h * i) / 4}" x2="${w}" y2="${(h * i) / 4}" stroke="rgba(255,255,255,.14)"/>`;
    }
    s += `<line x1="0" y1="${h}" x2="${w}" y2="0" stroke="rgba(255,255,255,.18)" stroke-dasharray="4 4"/>`;
    if (this.hist) {
      const H = this.hist;
      let d = `M0 ${h}`;
      for (let i = 0; i < H.length; i++) d += ` L${(i / (H.length - 1)) * w} ${h - H[i] * h * 0.6}`;
      d += ` L${w} ${h} Z`;
      s += `<path d="${d}" fill="rgba(255,255,255,.12)"/>`;
    }
    // faint other channels
    for (const ch of ['rgb', 'r', 'g', 'b'] as Channel[]) {
      if (ch === this.channel) continue;
      const p = curves[ch];
      if (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1) continue;
      s += `<path d="${this.path(p, w, h)}" stroke="${STROKE[ch]}" stroke-opacity=".35" stroke-width="1.5" fill="none"/>`;
    }
    const pts = curves[this.channel];
    s += `<path d="${this.path(pts, w, h)}" stroke="${STROKE[this.channel]}" stroke-width="2.4" fill="none"/>`;
    for (const [x, y] of pts) {
      s += `<circle cx="${x * w}" cy="${(1 - y) * h}" r="8" fill="#111" stroke="${STROKE[this.channel]}" stroke-width="2.4"/>`;
    }
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.innerHTML = s;
  }

  private path(pts: CurvePoint[], w: number, h: number) {
    const f = makeSpline(pts);
    let d = '';
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      d += `${i ? 'L' : 'M'}${x * w} ${(1 - clamp(f(x))) * h}`;
    }
    return d;
  }
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
