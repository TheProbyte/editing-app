import { spotCircles, type Spot } from '../params';

interface Mapper {
  toScreen(x: number, y: number): { x: number; y: number };
  pxPerFrameH(): number;
}

type P = { x: number; y: number };

/**
 * Draws the Remove tool over the photo: every patch as a faint outline, the selected one as
 * the area being fixed (white) and where it copies from (yellow, dashed) with a handle, and
 * the stroke being painted right now.
 */
export class HealOverlay {
  private svg: SVGSVGElement;

  constructor(
    private host: HTMLElement,
    private map: Mapper,
    private get: () => { spots: Spot[]; sel: number; aspect: number; painting: { pts: P[]; r: number } | null },
  ) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mask-svg heal-svg');
    host.appendChild(this.svg);
  }

  show(on: boolean) {
    this.host.classList.toggle('on', on);
    if (on) this.draw();
  }

  /** Screen geometry of a patch: its circles, centre, source centre and radius (px). */
  geom(sp: Spot) {
    const circles = spotCircles(sp, this.get().aspect).map(([x, y]) => this.map.toScreen(x, y));
    const t = this.map.toScreen(sp.x, sp.y);
    const s = this.map.toScreen(sp.x + sp.ox, sp.y + sp.oy);
    return { circles, t, s, dx: s.x - t.x, dy: s.y - t.y, r: sp.r * this.map.pxPerFrameH() };
  }

  /** Is a screen point on the patch itself / on its source? */
  hit(sp: Spot, x: number, y: number, slop = 6) {
    const g = this.geom(sp);
    const near = (pts: P[], ox: number, oy: number) => pts.some((p) => Math.hypot(p.x + ox - x, p.y + oy - y) < Math.max(g.r, 14) + slop);
    return { target: near(g.circles, 0, 0), source: near(g.circles, g.dx, g.dy) };
  }

  draw() {
    const r = this.host.getBoundingClientRect();
    const W = this.host.clientWidth, H = this.host.clientHeight;
    if (!W || !r.width || !this.host.classList.contains('on')) {
      this.svg.innerHTML = '';
      return;
    }
    const k = W / r.width;
    const L = (p: P) => ({ x: (p.x - r.left) * k, y: (p.y - r.top) * k });
    const path = (pts: P[], ox = 0, oy = 0) => pts.map((p, i) => `${i ? 'L' : 'M'}${(p.x - r.left + ox) * k} ${(p.y - r.top + oy) * k}`).join('');
    // a painted area: a fat round-capped line (a single point still draws a dot)
    const area = (pts: P[], rad: number, cls: string, ox = 0, oy = 0) =>
      `<path class="${cls}" d="${path(pts.length > 1 ? pts : [pts[0], { x: pts[0].x + 0.01, y: pts[0].y }], ox, oy)}" stroke-width="${rad * 2 * k}"/>`;
    const { spots, sel, painting } = this.get();
    let s = '';
    spots.forEach((sp, i) => {
      const g = this.geom(sp);
      if (i !== sel) {
        s += area(g.circles, g.r, 'patch faint');
        return;
      }
      const t = L(g.t), src = L(g.s);
      s += area(g.circles, g.r, 'patch src', g.dx, g.dy);
      s += `<line class="arm" x1="${t.x}" y1="${t.y}" x2="${src.x}" y2="${src.y}"/>`;
      s += area(g.circles, g.r, 'patch sel');
      s += `<rect class="pin main" x="${src.x - 8 * k}" y="${src.y - 8 * k}" width="${16 * k}" height="${16 * k}"/>`;
    });
    if (painting && painting.pts.length) s += area(painting.pts, painting.r, 'patch live');
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.innerHTML = s;
  }
}
