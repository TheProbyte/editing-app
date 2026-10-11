import type { Mask } from '../params';

type Grab = 'center' | 'rx' | 'ry' | 'p0' | 'p1' | 'mid';

export interface Frame {
  /** crop rect in frame coords */
  crop: { x: number; y: number; w: number; h: number };
  /** frame aspect (w/h) */
  aspect: number;
}

/**
 * Draws the selected mask's handles over the photo and lets you drag them.
 * Everything is converted between screen space and frame coordinates through the
 * on-screen photo's bounding box, so it works at any zoom.
 */
export class MaskOverlay {
  private svg: SVGSVGElement;
  private drag: { what: Grab; id: number; start: Mask; sx: number; sy: number } | null = null;

  constructor(
    private host: HTMLElement,
    private get: () => { mask: Mask | null; frame: Frame },
    private change: (m: Mask, commit: boolean) => void,
  ) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mask-svg');
    host.appendChild(this.svg);
  }

  show(on: boolean) {
    this.host.classList.toggle('on', on);
    if (on) this.draw();
  }

  get active() {
    return !!this.drag;
  }

  /** Screen point → frame coords. */
  toFrame(clientX: number, clientY: number) {
    const r = this.host.getBoundingClientRect();
    const { crop } = this.get().frame;
    const u = (clientX - r.left) / r.width;
    const v = (clientY - r.top) / r.height;
    return { x: crop.x + u * crop.w, y: crop.y + v * crop.h, u, v };
  }

  /** Frame coords → screen point. */
  toScreen(x: number, y: number) {
    const r = this.host.getBoundingClientRect();
    const { crop } = this.get().frame;
    return { x: r.left + ((x - crop.x) / crop.w) * r.width, y: r.top + ((y - crop.y) / crop.h) * r.height };
  }

  /** Screen pixels per frame height. */
  pxPerFrameH() {
    return this.host.getBoundingClientRect().height / this.get().frame.crop.h;
  }

  private handles(m: Mask): Record<string, { x: number; y: number }> {
    const g = m.g;
    if (m.type === 'radial') {
      const c = this.toScreen(g.cx, g.cy);
      const k = this.pxPerFrameH();
      const ca = Math.cos(g.angle), sa = Math.sin(g.angle);
      return {
        center: c,
        rx: { x: c.x + ca * g.rx * k, y: c.y + sa * g.rx * k },
        ry: { x: c.x + sa * g.ry * k, y: c.y - ca * g.ry * k },
      };
    }
    if (m.type === 'linear') {
      const a = this.toScreen(g.x0, g.y0), b = this.toScreen(g.x1, g.y1);
      return { p0: a, p1: b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    }
    return {};
  }

  /** Try to grab a handle. */
  start(e: PointerEvent): boolean {
    const { mask } = this.get();
    if (!mask) return false;
    const hs = this.handles(mask);
    let best: Grab | null = null;
    let bd = 30;
    for (const [k, p] of Object.entries(hs)) {
      const d = Math.hypot(p.x - e.clientX, p.y - e.clientY);
      if (d < bd) {
        bd = d;
        best = k as Grab;
      }
    }
    // inside a radial mask also grabs it (to move)
    if (!best && mask.type === 'radial') {
      const c = hs.center;
      const k = this.pxPerFrameH();
      if (Math.hypot(c.x - e.clientX, c.y - e.clientY) < Math.min(mask.g.rx, mask.g.ry) * k * 0.6) best = 'center';
    }
    if (!best) return false;
    this.drag = { what: best, id: e.pointerId, start: JSON.parse(JSON.stringify(mask)), sx: e.clientX, sy: e.clientY };
    this.svg.classList.add('active');
    return true;
  }

  move(e: PointerEvent) {
    if (!this.drag) return;
    const m: Mask = JSON.parse(JSON.stringify(this.drag.start));
    const g = m.g;
    const s = this.drag.start.g;
    const f = this.toFrame(e.clientX, e.clientY);
    const f0 = this.toFrame(this.drag.sx, this.drag.sy);
    const dx = f.x - f0.x, dy = f.y - f0.y;
    const { aspect } = this.get().frame;
    switch (this.drag.what) {
      case 'center':
        g.cx = s.cx + dx;
        g.cy = s.cy + dy;
        break;
      case 'rx':
      case 'ry': {
        const vx = (f.x - s.cx) * aspect, vy = f.y - s.cy; // frame heights
        const len = Math.max(0.01, Math.hypot(vx, vy));
        const ang = Math.atan2(vy, vx);
        if (this.drag.what === 'rx') {
          g.rx = len;
          g.angle = ang;
        } else {
          g.ry = len;
          g.angle = ang + Math.PI / 2;
        }
        break;
      }
      case 'p0':
        g.x0 = f.x;
        g.y0 = f.y;
        break;
      case 'p1':
        g.x1 = f.x;
        g.y1 = f.y;
        break;
      case 'mid':
        g.x0 = s.x0 + dx;
        g.y0 = s.y0 + dy;
        g.x1 = s.x1 + dx;
        g.y1 = s.y1 + dy;
        break;
    }
    this.change(m, false);
    this.draw();
  }

  end() {
    if (!this.drag) return;
    this.drag = null;
    this.svg.classList.remove('active');
    const { mask } = this.get();
    if (mask) this.change(mask, true);
    this.draw();
  }

  cancel() {
    this.drag = null;
    this.svg.classList.remove('active');
  }

  draw() {
    const { mask } = this.get();
    const r = this.host.getBoundingClientRect();
    const W = this.host.clientWidth, H = this.host.clientHeight;
    if (!mask || !W || !r.width) {
      this.svg.innerHTML = '';
      return;
    }
    // work in screen px, then map into the host's (unscaled) coordinate space
    const k = W / r.width;
    const L = (p: { x: number; y: number }) => ({ x: (p.x - r.left) * k, y: (p.y - r.top) * k });
    const hs = Object.fromEntries(Object.entries(this.handles(mask)).map(([n, p]) => [n, L(p)]));
    const pin = (p: { x: number; y: number }, cls = '') =>
      `<circle class="pin ${cls}" cx="${p.x}" cy="${p.y}" r="${9 * k}"/>`;
    let s = '';
    if (mask.type === 'radial') {
      const c = hs.center;
      const ppf = this.pxPerFrameH() * k;
      const deg = (mask.g.angle * 180) / Math.PI;
      const rx = mask.g.rx * ppf, ry = mask.g.ry * ppf;
      const inner = 1 - (mask.g.feather ?? 60) / 100;
      s += `<g transform="translate(${c.x} ${c.y}) rotate(${deg})">`;
      s += `<ellipse class="ring" rx="${rx}" ry="${ry}"/>`;
      if (inner > 0.02) s += `<ellipse class="ring faint" rx="${rx * inner}" ry="${ry * inner}"/>`;
      s += `</g>`;
      s += `<line class="arm" x1="${c.x}" y1="${c.y}" x2="${hs.rx.x}" y2="${hs.rx.y}"/>`;
      s += `<line class="arm" x1="${c.x}" y1="${c.y}" x2="${hs.ry.x}" y2="${hs.ry.y}"/>`;
      s += pin(hs.rx, 'small') + pin(hs.ry, 'small') + pin(c, 'main');
    } else if (mask.type === 'linear') {
      const { p0, p1, mid } = hs;
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * (W + H) * 2, ny = (dx / len) * (W + H) * 2;
      const line = (p: { x: number; y: number }, cls: string) =>
        `<line class="${cls}" x1="${p.x - nx}" y1="${p.y - ny}" x2="${p.x + nx}" y2="${p.y + ny}"/>`;
      s += line(p0, 'ring') + line(mid, 'ring faint') + line(p1, 'ring faint dash');
      s += pin(p0, 'main') + pin(mid, 'small') + pin(p1, 'small');
    }
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.innerHTML = s;
  }
}
