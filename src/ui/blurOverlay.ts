export interface BlurShape {
  type: number; // 1 tilt, 2 radial
  x: number;
  y: number;
  /** focus half-size and transition, in image heights */
  size: number;
  feather: number;
  angle: number; // radians
}

/** Focus point + guide lines for the Blur section. Drag the point to move the focus. */
export class BlurOverlay {
  private svg: SVGSVGElement;
  private drag: { id: number; dx: number; dy: number } | null = null;
  guides = false;

  constructor(
    private host: HTMLElement,
    private get: () => BlurShape,
    private move: (x: number, y: number, commit: boolean) => void,
  ) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mask-svg');
    host.appendChild(this.svg);
  }

  show(on: boolean) {
    this.host.classList.toggle('on', on);
    if (on) this.draw();
  }

  start(e: PointerEvent) {
    const s = this.get();
    if (!s.type) return false;
    const r = this.host.getBoundingClientRect();
    const px = r.left + s.x * r.width, py = r.top + s.y * r.height;
    if (Math.hypot(px - e.clientX, py - e.clientY) > 34) return false;
    this.drag = { id: e.pointerId, dx: e.clientX - px, dy: e.clientY - py };
    this.guides = true;
    return true;
  }

  moveTo(e: PointerEvent) {
    if (!this.drag) return;
    const r = this.host.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - this.drag.dx - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - this.drag.dy - r.top) / r.height));
    this.move(x, y, false);
    this.draw();
  }

  end() {
    if (!this.drag) return;
    this.drag = null;
    this.guides = false;
    const s = this.get();
    this.move(s.x, s.y, true);
    this.draw();
  }

  draw() {
    const s = this.get();
    const W = this.host.clientWidth, H = this.host.clientHeight;
    const r = this.host.getBoundingClientRect();
    if (!s.type || !W) {
      this.svg.innerHTML = '';
      return;
    }
    const k = W / (r.width || W); // undo zoom for constant-size marks
    const cx = s.x * W, cy = s.y * H;
    const a = s.size * H, b = (s.size + s.feather) * H;
    let g = '';
    const op = this.guides ? 1 : 0.55;
    if (s.type === 1) {
      const deg = (s.angle * 180) / Math.PI;
      const L = (W + H) * 2;
      g += `<g transform="translate(${cx} ${cy}) rotate(${deg})" opacity="${op}">`;
      for (const [d, cls] of [[a, 'ring'], [-a, 'ring'], [b, 'ring faint dash'], [-b, 'ring faint dash']] as const) {
        g += `<line class="${cls}" x1="${-L}" y1="${d}" x2="${L}" y2="${d}"/>`;
      }
      g += `</g>`;
    } else {
      g += `<g opacity="${op}"><circle class="ring" cx="${cx}" cy="${cy}" r="${a}"/><circle class="ring faint dash" cx="${cx}" cy="${cy}" r="${b}"/></g>`;
    }
    g += `<circle class="pin main" cx="${cx}" cy="${cy}" r="${10 * k}"/>`;
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.innerHTML = g;
  }
}
