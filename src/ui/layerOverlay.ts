type P = { x: number; y: number };

/**
 * The box around a placed layer (double-exposure photo or light leak): drag inside to move it,
 * drag the corner square to scale and turn it, or pinch with two fingers.
 */
export class LayerOverlay {
  private svg: SVGSVGElement;

  constructor(private host: HTMLElement, private get: () => { corners: P[]; centre: P } | null) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mask-svg');
    host.appendChild(this.svg);
  }

  show(on: boolean) {
    this.host.classList.toggle('on', on);
    if (on) this.draw();
  }

  draw() {
    const g = this.get();
    const r = this.host.getBoundingClientRect();
    const W = this.host.clientWidth, H = this.host.clientHeight;
    if (!g || !W || !r.width || !this.host.classList.contains('on')) {
      this.svg.innerHTML = '';
      return;
    }
    const k = W / r.width;
    const L = (p: P) => ({ x: (p.x - r.left) * k, y: (p.y - r.top) * k });
    const c = g.corners.map(L);
    const ctr = L(g.centre);
    const sq = (p: P, n: number, cls: string) => `<rect class="${cls}" x="${p.x - n * k}" y="${p.y - n * k}" width="${2 * n * k}" height="${2 * n * k}"/>`;
    let s = `<polygon class="ring dash" points="${c.map((p) => `${p.x},${p.y}`).join(' ')}"/>`;
    s += sq(c[2], 8, 'pin main') + sq(ctr, 5, 'pin');
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.innerHTML = s;
  }
}
