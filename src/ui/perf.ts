// A small readout of how the app is running on this phone (frame rate, render time, playback,
// memory), switched on from the ⋯ menu. It's there to be screenshotted: numbers from a real
// device instead of guesses.

export interface PerfSource {
  /** the video editor's playback numbers, if a video is open */
  video(): { playing: boolean; shown: number; drops: number; cap: number; frames: number } | null;
  /** bytes held in the render-target pool */
  poolBytes(): number;
  /** the preview canvas and its render scale */
  canvas(): { w: number; h: number; rs: number };
  gpu(): string;
}

export class PerfReadout {
  private el: HTMLElement;
  private on = false;
  private raf = 0;
  private timer = 0;
  /** screen refreshes, renders and render time since the last update */
  private frames = 0;
  private renders = 0;
  private renderMs = 0;
  private worst = 0;
  private long: number[] = [];
  private obs: PerformanceObserver | null = null;
  private last = performance.now();
  private lastVideo = { shown: 0, drops: 0, frames: 0 };

  constructor(private src: PerfSource) {
    this.el = document.createElement('div');
    this.el.id = 'perf';
    this.el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.el);
    try {
      this.show(localStorage.getItem('lumen.perf') === '1');
    } catch {
      /* private mode */
    }
  }

  get shown() {
    return this.on;
  }

  show(on: boolean) {
    this.on = on;
    this.el.classList.toggle('on', on);
    try {
      localStorage.setItem('lumen.perf', on ? '1' : '0');
    } catch {
      /* private mode */
    }
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    this.obs?.disconnect();
    this.obs = null;
    if (!on) return;
    const tick = () => {
      this.frames++;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    try {
      this.obs = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) this.long.push(performance.now(), e.duration);
      });
      this.obs.observe({ type: 'longtask', buffered: false });
    } catch {
      /* not supported */
    }
    this.last = performance.now();
    this.timer = window.setInterval(() => this.update(), 500);
    this.update();
  }

  /** One render took `ms` (main-thread time; the GPU finishes on its own). */
  rendered(ms: number) {
    if (!this.on) return;
    this.renders++;
    this.renderMs += ms;
    if (ms > this.worst) this.worst = ms;
  }

  private update() {
    const now = performance.now(), dt = Math.max(1, now - this.last) / 1000;
    this.last = now;
    const fps = this.frames / dt, rps = this.renders / dt, avg = this.renders ? this.renderMs / this.renders : 0;
    // long tasks over the last 10 s
    while (this.long.length && now - this.long[0] > 10_000) this.long.splice(0, 2);
    let longN = 0, longMax = 0;
    for (let i = 1; i < this.long.length; i += 2) {
      longN++;
      longMax = Math.max(longMax, this.long[i]);
    }
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const c = this.src.canvas();
    const lines = [
      `screen ${fps.toFixed(0)} fps · drew ${rps.toFixed(0)}/s`,
      `render ${avg.toFixed(1)} ms (worst ${this.worst.toFixed(0)})`,
      `canvas ${c.w}×${c.h} · scale ${c.rs.toFixed(2)}`,
    ];
    const v = this.src.video();
    if (v) {
      const shown = v.shown - this.lastVideo.shown, drops = v.drops - this.lastVideo.drops, frames = v.frames - this.lastVideo.frames;
      lines.push(v.playing ? `play ${(shown / dt).toFixed(0)} fps · dropped ${(drops / dt).toFixed(0)}/s · res ${Math.round(v.cap * 100)}%` : `scrub ${(frames / dt).toFixed(0)} frames/s`);
      this.lastVideo = { shown: v.shown, drops: v.drops, frames: v.frames };
    }
    lines.push(`stalls ${longN} in 10 s${longN ? ` (longest ${Math.round(longMax)} ms)` : ''}`);
    lines.push(`memory ${mem ? Math.round(mem.usedJSHeapSize / 1e6) + ' MB JS · ' : ''}${Math.round(this.src.poolBytes() / 1e6)} MB GPU pool`);
    lines.push(this.src.gpu());
    this.el.textContent = lines.join('\n');
    this.frames = 0;
    this.renders = 0;
    this.renderMs = 0;
    this.worst = 0;
  }
}
