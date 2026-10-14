// The speed ramp curve of a clip: speed (log scale, 0.1× … 10×) across the clip. Drag a point up
// or down to change the speed there; it snaps to 1× near the middle line.
import { RAMP_MAX, RAMP_MIN } from './project';
import { tick } from '../ui/haptics';

export interface RampView {
  pts: [number, number][];
  /** where the playhead is in the clip (0…1), if it's on it */
  at: number | null;
  /** the clip's own speed, to label the lines with the real speed */
  base: number;
}

const L0 = Math.log(RAMP_MIN), L1 = Math.log(RAMP_MAX);

export class RampEditor {
  readonly el: HTMLDivElement;
  private svg: SVGSVGElement;
  private drag: { i: number; snapped: boolean } | null = null;

  constructor(
    parent: HTMLElement,
    private get: () => RampView | null,
    private set: (pts: [number, number][], commit: boolean) => void,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'rampWrap';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.el.appendChild(this.svg);
    parent.appendChild(this.el);
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('pointermove', (e) => this.move(e));
    const up = (e: PointerEvent) => this.up(e);
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
  }

  show(on: boolean) {
    this.el.classList.toggle('on', on);
    if (on) this.draw();
  }

  get shown() {
    return this.el.classList.contains('on');
  }

  private box() {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    return { W, H, l: 40, r: W - 16, t: 14, b: H - 14 };
  }
  private xOf(u: number) {
    const B = this.box();
    return B.l + u * (B.r - B.l);
  }
  private yOf(m: number) {
    const B = this.box();
    return B.b - ((Math.log(m) - L0) / (L1 - L0)) * (B.b - B.t);
  }
  private mOf(y: number) {
    const B = this.box();
    return Math.exp(L0 + ((B.b - y) / (B.b - B.t)) * (L1 - L0));
  }

  draw() {
    const v = this.get();
    if (!v || !this.shown) return;
    const B = this.box();
    let g = '';
    for (const m of [0.25, 0.5, 1, 2, 4, 8]) {
      const y = this.yOf(m);
      g += `<line x1="${B.l}" x2="${B.r}" y1="${y}" y2="${y}" class="rgrid${m === 1 ? ' one' : ''}"/>`;
      const sp = m * v.base;
      g += `<text x="${B.l - 6}" y="${y + 4}" class="rlab">${String(+sp.toFixed(2)).replace(/^0\./, '.')}×</text>`;
    }
    // the curve: straight in speed, so drawn point by point on the log scale
    const P = v.pts;
    let d = '';
    for (let i = 1; i < P.length; i++) {
      const [u0, m0] = P[i - 1], [u1, m1] = P[i];
      for (let k = 0; k <= 16; k++) {
        const f = k / 16;
        const x = this.xOf(u0 + (u1 - u0) * f), y = this.yOf(m0 + (m1 - m0) * f);
        d += `${d ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
    }
    g += `<path d="${d}" class="rcurve"/>`;
    if (v.at !== null) g += `<line x1="${this.xOf(v.at)}" x2="${this.xOf(v.at)}" y1="${B.t - 6}" y2="${B.b + 6}" class="rplay"/>`;
    P.forEach(([u, m], i) => {
      const x = this.xOf(u), y = this.yOf(m), s = this.drag?.i === i ? 8 : 6;
      g += `<rect x="${x - s}" y="${y - s}" width="${s * 2}" height="${s * 2}" class="rpt${this.drag?.i === i ? ' on' : ''}"/>`;
    });
    this.svg.setAttribute('viewBox', `0 0 ${B.W} ${B.H}`);
    this.svg.innerHTML = g;
  }

  private local(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down(e: PointerEvent) {
    e.stopPropagation();
    const v = this.get();
    if (!v) return;
    const q = this.local(e);
    let best = -1, bd = 40;
    v.pts.forEach(([u, m], i) => {
      const dd = Math.hypot(this.xOf(u) - q.x, (this.yOf(m) - q.y) * 0.6);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    if (best < 0) return;
    this.el.setPointerCapture(e.pointerId);
    this.drag = { i: best, snapped: Math.abs(v.pts[best][1] - 1) < 1e-3 };
    tick();
    this.move(e);
  }

  private move(e: PointerEvent) {
    if (!this.drag) return;
    e.stopPropagation();
    const v = this.get();
    if (!v) return;
    let m = Math.min(RAMP_MAX, Math.max(RAMP_MIN, this.mOf(this.local(e).y)));
    // a little stickiness at 1× (the clip's own speed)
    const one = Math.abs(Math.log(m)) < 0.09;
    if (one) m = 1;
    if (one !== this.drag.snapped) {
      this.drag.snapped = one;
      if (one) tick();
    }
    const pts = v.pts.map((p) => [p[0], p[1]] as [number, number]);
    pts[this.drag.i][1] = Math.round(m * 100) / 100;
    this.set(pts, false);
    this.draw();
  }

  private up(e: PointerEvent) {
    if (!this.drag) return;
    e.stopPropagation();
    this.drag = null;
    const v = this.get();
    if (v) this.set(v.pts, true);
    this.draw();
  }
}
