export interface BlurShape {
  type: number; // 1 tilt, 2 radial, 3 lens (just a focus point)
  x: number;
  y: number;
  /** focus half-size and transition, in image heights */
  size: number;
  feather: number;
  angle: number; // radians
}

type Grab = 'move' | 'size';

/**
 * Blur section: the focus point (drag to move) and a square handle on the focus edge (drag to
 * resize; for tilt-shift it also turns the band).
 */
export class BlurOverlay {
  private svg: SVGSVGElement;
  private drag: { what: Grab; dx: number; dy: number } | null = null;
  guides = false;

  constructor(
    private host: HTMLElement,
    private get: () => BlurShape,
    private set: (p: Partial<BlurShape>, commit: boolean) => void,
  ) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mask-svg');
    host.appendChild(this.svg);
  }

  show(on: boolean) {
    this.host.classList.toggle('on', on);
    if (on) this.draw();
  }

  /** Screen positions of the centre and the size handle. */
  private points() {
    const s = this.get();
    const r = this.host.getBoundingClientRect();
    const c = { x: r.left + s.x * r.width, y: r.top + s.y * r.height };
    const a = s.size * r.height;
    const h = s.type === 1 ? { x: c.x - Math.sin(s.angle) * a, y: c.y + Math.cos(s.angle) * a } : { x: c.x + a, y: c.y };
    return { c, h, r };
  }

  start(e: PointerEvent) {
    const s = this.get();
    if (!s.type) return false;
    const { c, h } = this.points();
    if (s.type === 3) {
      if (Math.hypot(c.x - e.clientX, c.y - e.clientY) >= 34) return false;
      this.drag = { what: 'move', dx: e.clientX - c.x, dy: e.clientY - c.y };
    } else if (Math.hypot(h.x - e.clientX, h.y - e.clientY) < 30) this.drag = { what: 'size', dx: 0, dy: 0 };
    else if (Math.hypot(c.x - e.clientX, c.y - e.clientY) < 34) this.drag = { what: 'move', dx: e.clientX - c.x, dy: e.clientY - c.y };
    else return false;
    this.guides = true;
    return true;
  }

  moveTo(e: PointerEvent) {
    if (!this.drag) return;
    const { c, r } = this.points();
    if (this.drag.what === 'move') {
      const x = Math.min(1, Math.max(0, (e.clientX - this.drag.dx - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (e.clientY - this.drag.dy - r.top) / r.height));
      this.set({ x, y }, false);
    } else {
      const vx = e.clientX - c.x, vy = e.clientY - c.y;
      const p: Partial<BlurShape> = { size: Math.hypot(vx, vy) / r.height };
      if (this.get().type === 1) p.angle = Math.atan2(vy, vx) - Math.PI / 2;
      this.set(p, false);
    }
    this.draw();
  }

  /** Where a screen point falls on the picture (0..1), or null when it's off it. */
  uvAt(e: { clientX: number; clientY: number }) {
    const r = this.host.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }

  end() {
    if (!this.drag) return;
    this.drag = null;
    this.guides = false;
    this.set({}, true);
    this.draw();
  }

  draw() {
    const s = this.get();
    const W = this.host.clientWidth, H = this.host.clientHeight;
    const r = this.host.getBoundingClientRect();
    if (!s.type || !W || !this.host.classList.contains('on')) {
      this.svg.innerHTML = '';
      return;
    }
    const k = W / (r.width || W); // undo zoom for constant-size marks
    const cx = s.x * W, cy = s.y * H;
    const a = s.size * H, b = (s.size + s.feather) * H;
    let g = '';
    const op = this.guides ? 1 : 0.6;
    let hx = cx + a, hy = cy;
    if (s.type === 3) {
      // lens: the focus point only (a focus-square reticle; tap anywhere to move it)
      const q = 16 * k, t = 6 * k;
      g += `<g opacity="${op}">`;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x0 = cx + sx * q, y0 = cy + sy * q;
        g += `<path class="ring" d="M${x0} ${y0 - sy * t}V${y0}H${x0 - sx * t}"/>`;
      }
      g += `</g><rect class="pin main" x="${cx - 4 * k}" y="${cy - 4 * k}" width="${8 * k}" height="${8 * k}"/>`;
      this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      this.svg.innerHTML = g;
      return;
    }
    if (s.type === 1) {
      const deg = (s.angle * 180) / Math.PI;
      const L = (W + H) * 2;
      g += `<g transform="translate(${cx} ${cy}) rotate(${deg})" opacity="${op}">`;
      for (const [d, cls] of [[a, 'ring'], [-a, 'ring'], [b, 'ring faint dash'], [-b, 'ring faint dash']] as const) {
        g += `<line class="${cls}" x1="${-L}" y1="${d}" x2="${L}" y2="${d}"/>`;
      }
      g += `</g>`;
      hx = cx - Math.sin(s.angle) * a;
      hy = cy + Math.cos(s.angle) * a;
    } else {
      g += `<g opacity="${op}"><circle class="ring" cx="${cx}" cy="${cy}" r="${a}"/><circle class="ring faint dash" cx="${cx}" cy="${cy}" r="${b}"/></g>`;
    }
    g += `<rect class="pin" x="${hx - 7 * k}" y="${hy - 7 * k}" width="${14 * k}" height="${14 * k}"/>`;
    g += `<rect class="pin main" x="${cx - 9 * k}" y="${cy - 9 * k}" width="${18 * k}" height="${18 * k}"/>`;
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.innerHTML = g;
  }
}

export interface VigShape {
  x: number;
  y: number;
  /** edge of the vignette as the shader sees it (0.25..1.15) */
  start: number;
  /** roundness 0..1 (how much it follows a circle instead of the frame) */
  round: number;
  /** output aspect (w/h) */
  aspect: number;
}

/**
 * Vignette section: drag the centre to move it, the side handle to resize, the other handle to
 * squish it between the frame's shape and a circle.
 */
export class VignetteOverlay {
  private svg: SVGSVGElement;
  private drag: { what: 'move' | 'size' | 'round'; dx: number; dy: number } | null = null;

  constructor(private host: HTMLElement, private get: () => VigShape, private set: (p: Partial<VigShape>, commit: boolean) => void) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mask-svg');
    host.appendChild(this.svg);
  }

  show(on: boolean) {
    this.host.classList.toggle('on', on);
    if (on) this.draw();
  }

  /** Ellipse half-sizes as fractions of the frame, matching the shader. */
  private halves(s: VigShape) {
    const A = s.aspect, rt = Math.max(0, s.round);
    const sx = A >= 1 ? 1 : 1 + (A - 1) * rt;
    const sy = A >= 1 ? 1 + (1 / A - 1) * rt : 1;
    return { hx: s.start / (2 * sx), hy: s.start / (2 * sy), sx, sy };
  }

  private points() {
    const s = this.get();
    const r = this.host.getBoundingClientRect();
    const { hx, hy } = this.halves(s);
    const c = { x: r.left + s.x * r.width, y: r.top + s.y * r.height };
    return { s, r, c, side: { x: c.x + hx * r.width, y: c.y }, top: { x: c.x, y: c.y - hy * r.height } };
  }

  start(e: PointerEvent) {
    const { s, c, side, top } = this.points();
    const d = (p: { x: number; y: number }) => Math.hypot(p.x - e.clientX, p.y - e.clientY);
    // the handle on the frame's long axis resizes; the other squishes (roundness)
    const sizeH = s.aspect >= 1 ? side : top, roundH = s.aspect >= 1 ? top : side;
    if (d(sizeH) < 30) this.drag = { what: 'size', dx: 0, dy: 0 };
    else if (d(roundH) < 30) this.drag = { what: 'round', dx: 0, dy: 0 };
    else if (d(c) < 34) this.drag = { what: 'move', dx: e.clientX - c.x, dy: e.clientY - c.y };
    else return false;
    return true;
  }

  moveTo(e: PointerEvent) {
    if (!this.drag) return;
    const { s, r, c } = this.points();
    if (this.drag.what === 'move') {
      this.set({
        x: Math.min(1, Math.max(0, (e.clientX - this.drag.dx - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - this.drag.dy - r.top) / r.height)),
      }, false);
    } else {
      const fx = Math.abs(e.clientX - c.x) / r.width, fy = Math.abs(e.clientY - c.y) / r.height;
      const { sx, sy } = this.halves(s);
      const A = s.aspect;
      if (this.drag.what === 'size') {
        this.set({ start: A >= 1 ? 2 * sx * fx : 2 * sy * fy }, false);
      } else {
        // solve the scale on the short axis for the dragged half-size, then roundness from it
        const scl = A >= 1 ? s.start / (2 * Math.max(0.01, fy)) : s.start / (2 * Math.max(0.01, fx));
        const k = A >= 1 ? 1 / A - 1 : A - 1;
        this.set({ round: Math.min(1, Math.max(0, Math.abs(k) < 1e-3 ? 0 : (scl - 1) / k)) }, false);
      }
    }
    this.draw();
  }

  /** Where a screen point falls on the picture (0..1), or null when it's off it. */
  uvAt(e: { clientX: number; clientY: number }) {
    const r = this.host.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }

  end() {
    if (!this.drag) return;
    this.drag = null;
    this.set({}, true);
    this.draw();
  }

  get active() {
    return !!this.drag;
  }

  draw() {
    const W = this.host.clientWidth, H = this.host.clientHeight;
    const r = this.host.getBoundingClientRect();
    if (!W || !this.host.classList.contains('on')) {
      this.svg.innerHTML = '';
      return;
    }
    const s = this.get();
    const k = W / (r.width || W);
    const { hx, hy } = this.halves(s);
    const cx = s.x * W, cy = s.y * H;
    const op = this.drag ? 1 : 0.6;
    let g = `<ellipse class="ring" cx="${cx}" cy="${cy}" rx="${hx * W}" ry="${hy * H}" opacity="${op}"/>`;
    const sq = (x: number, y: number, n: number, cls = 'pin') => `<rect class="${cls}" x="${x - n * k}" y="${y - n * k}" width="${2 * n * k}" height="${2 * n * k}"/>`;
    g += sq(cx + hx * W, cy, 7) + sq(cx, cy - hy * H, 7) + sq(cx, cy, 9, 'pin main');
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.innerHTML = g;
  }
}
