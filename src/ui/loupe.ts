/**
 * A magnifier that floats above your finger while picking, showing the spot under it
 * enlarged with a crosshair; its ring takes on the picked color.
 */
export class Loupe {
  private ctx: CanvasRenderingContext2D;
  private size = 112;
  private zoom = 3.2;
  pos: { x: number; y: number } | null = null;
  color = '#fff';

  constructor(private el: HTMLCanvasElement) {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    el.width = el.height = Math.round(this.size * dpr);
    el.style.width = el.style.height = this.size + 'px';
    this.ctx = el.getContext('2d')!;
  }

  show(x: number, y: number) {
    this.pos = { x, y };
    this.el.classList.add('on');
  }

  hide() {
    this.pos = null;
    this.el.classList.remove('on');
  }

  /** Draw from the photo canvas. Call right after the photo renders (same task). */
  draw(src: HTMLCanvasElement, stageRect: DOMRect) {
    if (!this.pos) return;
    const r = src.getBoundingClientRect();
    const { x, y } = this.pos;
    const S = this.size;
    // keep it above the finger, nudged inside the screen
    let lx = x - S / 2;
    let ly = y - S - 46;
    if (ly < stageRect.top + 8) ly = y + 46;
    lx = Math.max(stageRect.left + 8, Math.min(stageRect.right - S - 8, lx));
    this.el.style.transform = `translate(${lx - stageRect.left}px, ${ly - stageRect.top}px)`;
    const c = this.ctx;
    const W = this.el.width;
    const kx = src.width / r.width;
    const ky = src.height / r.height;
    const span = S / this.zoom; // client px shown across the loupe
    const sx = (x - r.left - span / 2) * kx;
    const sy = (y - r.top - span / 2) * ky;
    c.save();
    c.clearRect(0, 0, W, W);
    c.beginPath();
    c.arc(W / 2, W / 2, W / 2 - W * 0.04, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = '#0b0a09';
    c.fillRect(0, 0, W, W);
    c.imageSmoothingEnabled = false;
    try {
      c.drawImage(src, sx, sy, span * kx, span * ky, 0, 0, W, W);
    } catch {
      /* canvas not ready */
    }
    c.restore();
    // crosshair
    c.strokeStyle = 'rgba(0,0,0,.55)';
    c.lineWidth = W * 0.03;
    c.beginPath();
    c.arc(W / 2, W / 2, W * 0.07, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = '#fff';
    c.lineWidth = W * 0.014;
    c.stroke();
    // ring in the picked color
    c.lineWidth = W * 0.07;
    c.strokeStyle = this.color;
    c.beginPath();
    c.arc(W / 2, W / 2, W / 2 - W * 0.04, 0, Math.PI * 2);
    c.stroke();
  }
}
