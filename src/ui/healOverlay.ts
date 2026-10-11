import type { Spot } from '../params';

interface Mapper {
  toScreen(x: number, y: number): { x: number; y: number };
  pxPerFrameH(): number;
}

/**
 * Draws the Remove tool's spots over the photo: every healed spot as a faint ring, and for
 * the selected one its target (white) and where it copies from (yellow, dashed).
 */
export class HealOverlay {
  private svg: SVGSVGElement;

  constructor(private host: HTMLElement, private map: Mapper, private get: () => { spots: Spot[]; sel: number; preview: { x: number; y: number; r: number } | null }) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mask-svg heal-svg');
    host.appendChild(this.svg);
  }

  show(on: boolean) {
    this.host.classList.toggle('on', on);
    if (on) this.draw();
  }

  /** Screen geometry of a spot: target centre, source centre and radius in px. */
  geom(sp: Spot) {
    const t = this.map.toScreen(sp.x, sp.y);
    const s = this.map.toScreen(sp.x + sp.ox, sp.y + sp.oy);
    return { t, s, r: sp.r * this.map.pxPerFrameH() };
  }

  draw() {
    const r = this.host.getBoundingClientRect();
    const W = this.host.clientWidth, H = this.host.clientHeight;
    if (!W || !r.width || !this.host.classList.contains('on')) {
      this.svg.innerHTML = '';
      return;
    }
    const k = W / r.width;
    const L = (p: { x: number; y: number }) => ({ x: (p.x - r.left) * k, y: (p.y - r.top) * k });
    const { spots, sel, preview } = this.get();
    let s = '';
    spots.forEach((sp, i) => {
      const g = this.geom(sp);
      const t = L(g.t);
      const rr = g.r * k;
      if (i !== sel) {
        s += `<circle class="ring faint dash" cx="${t.x}" cy="${t.y}" r="${rr}"/>`;
        return;
      }
      const src = L(g.s);
      s += `<line class="arm" x1="${t.x}" y1="${t.y}" x2="${src.x}" y2="${src.y}"/>`;
      s += `<circle class="ring src" cx="${src.x}" cy="${src.y}" r="${rr}"/>`;
      s += `<circle class="pin main" cx="${src.x}" cy="${src.y}" r="${7 * k}"/>`;
      s += `<circle class="ring" cx="${t.x}" cy="${t.y}" r="${rr}"/>`;
    });
    if (preview) {
      const t = L(preview);
      s += `<circle class="ring" cx="${t.x}" cy="${t.y}" r="${preview.r * k}"/>`;
    }
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.innerHTML = s;
  }
}
