export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Mode = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

/** Crop rectangle with corner/edge handles, drawn over the uncropped frame. */
export class CropOverlay {
  private box: HTMLDivElement;
  private drag: { mode: Mode; sx: number; sy: number; start: Rect; id: number } | null = null;

  constructor(
    private layer: HTMLElement,
    private get: () => Rect,
    private set: (r: Rect, commit: boolean) => void,
    /** Aspect lock as normalized w/h (null = free). */
    private aspect: () => number | null,
  ) {
    this.box = document.createElement('div');
    this.box.className = 'crop-box';
    this.box.innerHTML =
      '<i class="g g1"></i><i class="g g2"></i><i class="g g3"></i><i class="g g4"></i>' +
      ['nw', 'ne', 'sw', 'se'].map((c) => `<b class="h ${c}"></b>`).join('');
    layer.appendChild(this.box);
  }

  show(on: boolean) {
    this.layer.classList.toggle('on', on);
    if (on) this.update();
  }

  update() {
    const r = this.get();
    const s = this.box.style;
    s.left = r.x * 100 + '%';
    s.top = r.y * 100 + '%';
    s.width = r.w * 100 + '%';
    s.height = r.h * 100 + '%';
  }

  setGrid(dense: boolean) {
    this.box.classList.toggle('dense', dense);
  }

  /** Returns true if the pointer grabbed the crop box. */
  start(e: PointerEvent): boolean {
    const L = this.layer.getBoundingClientRect();
    const r = this.get();
    const px = e.clientX - L.left;
    const py = e.clientY - L.top;
    const x0 = r.x * L.width, x1 = (r.x + r.w) * L.width;
    const y0 = r.y * L.height, y1 = (r.y + r.h) * L.height;
    const T = 34;
    const nearL = Math.abs(px - x0) < T, nearR = Math.abs(px - x1) < T;
    const nearT = Math.abs(py - y0) < T, nearB = Math.abs(py - y1) < T;
    const inX = px > x0 - T && px < x1 + T, inY = py > y0 - T && py < y1 + T;
    let mode: Mode | null = null;
    if (nearT && nearL) mode = 'nw';
    else if (nearT && nearR) mode = 'ne';
    else if (nearB && nearL) mode = 'sw';
    else if (nearB && nearR) mode = 'se';
    else if (nearT && inX) mode = 'n';
    else if (nearB && inX) mode = 's';
    else if (nearL && inY) mode = 'w';
    else if (nearR && inY) mode = 'e';
    else if (px > x0 && px < x1 && py > y0 && py < y1) mode = 'move';
    if (!mode) return false;
    this.drag = { mode, sx: px / L.width, sy: py / L.height, start: { ...r }, id: e.pointerId };
    this.box.classList.add('active');
    return true;
  }

  move(e: PointerEvent) {
    if (!this.drag) return;
    const L = this.layer.getBoundingClientRect();
    const dx = (e.clientX - L.left) / L.width - this.drag.sx;
    const dy = (e.clientY - L.top) / L.height - this.drag.sy;
    this.set(this.compute(this.drag.mode, this.drag.start, dx, dy), false);
    this.update();
  }

  cancel() {
    this.drag = null;
    this.box.classList.remove('active');
  }

  end() {
    if (!this.drag) return;
    this.drag = null;
    this.box.classList.remove('active');
    this.set(this.get(), true);
  }

  private compute(mode: Mode, s: Rect, dx: number, dy: number): Rect {
    const MIN = 0.06;
    if (mode === 'move') {
      return { ...s, x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h) };
    }
    let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
    if (mode.includes('w')) x0 = clamp(x0 + dx, 0, x1 - MIN);
    if (mode.includes('e')) x1 = clamp(x1 + dx, x0 + MIN, 1);
    if (mode.includes('n')) y0 = clamp(y0 + dy, 0, y1 - MIN);
    if (mode.includes('s')) y1 = clamp(y1 + dy, y0 + MIN, 1);
    const a = this.aspect();
    if (a) {
      let w = x1 - x0;
      let h = y1 - y0;
      // keep the side the user is dragging, derive the other
      if (mode === 'n' || mode === 's') w = h * a;
      else if (mode === 'e' || mode === 'w') h = w / a;
      else if (w / h > a) h = w / a;
      else w = h * a;
      // fit inside bounds
      const ax = mode.includes('w') ? x1 : mode.includes('e') ? x0 : (x0 + x1) / 2;
      const ay = mode.includes('n') ? y1 : mode.includes('s') ? y0 : (y0 + y1) / 2;
      const maxW = mode.includes('w') ? ax : mode.includes('e') ? 1 - ax : 2 * Math.min(ax, 1 - ax);
      const maxH = mode.includes('n') ? ay : mode.includes('s') ? 1 - ay : 2 * Math.min(ay, 1 - ay);
      const k = Math.min(1, maxW / w, maxH / h);
      w *= k;
      h *= k;
      x0 = mode.includes('w') ? ax - w : mode.includes('e') ? ax : ax - w / 2;
      y0 = mode.includes('n') ? ay - h : mode.includes('s') ? ay : ay - h / 2;
      return { x: x0, y: y0, w, h };
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
}

/** Largest centered rect of the given normalized aspect. */
export function fitAspect(a: number | null): Rect {
  if (!a) return { x: 0, y: 0, w: 1, h: 1 };
  let w = 1;
  let h = 1 / a;
  if (h > 1) {
    h = 1;
    w = a;
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
