import { ICONS } from './icons';
import { tick } from './haptics';

// A minimal camera. It captures through the browser's ImageCapture API, which on Android
// returns the camera's own full-resolution still — without the Pixel camera app's HDR+ /
// Night Sight / computational stack. Swipe ↔ on the viewfinder for exposure compensation.

interface Caps {
  ev?: { min: number; max: number; step: number };
  torch?: boolean;
  zoom?: { min: number; max: number; step: number };
}

declare class ImageCapture {
  constructor(track: MediaStreamTrack);
  takePhoto(settings?: { imageWidth?: number; imageHeight?: number; fillLightMode?: string }): Promise<Blob>;
  getPhotoCapabilities(): Promise<{ imageWidth: { max: number }; imageHeight: { max: number } }>;
}

export class Camera {
  private el: HTMLElement;
  private video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private facing: 'environment' | 'user' = 'environment';
  private caps: Caps = {};
  private ev = 0;
  private torch = false;
  private onPhoto: ((f: File) => void) | null = null;
  private busy = false;

  constructor(private toast: (s: string, ms?: number) => void) {
    this.el = document.createElement('div');
    this.el.id = 'camera';
    this.el.innerHTML = `
      <video playsinline muted autoplay></video>
      <div class="cam-top">
        <button class="round" data-a="close" aria-label="Close">${ICONS.close}</button>
        <div class="cam-title">CAMERA · <span>NATURAL</span></div>
        <button class="round" data-a="torch" aria-label="Torch">${ICONS.light}</button>
      </div>
      <div class="cam-ev"><span class="name">EXPOSURE</span><span class="val">±0.0</span></div>
      <div class="cam-bottom">
        <span class="cam-spacer"></span>
        <button class="shutter" data-a="shoot" aria-label="Take photo"><i></i></button>
        <button class="round" data-a="flip" aria-label="Switch camera">${ICONS.flipCam}</button>
      </div>`;
    document.body.appendChild(this.el);
    this.video = this.el.querySelector('video')!;
    this.el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => this.action(b.dataset.a!);
    });
    this.bindSwipe();
  }

  get supported() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  async open(onPhoto: (f: File) => void) {
    this.onPhoto = onPhoto;
    this.el.classList.add('on');
    await this.start();
  }

  /** Called when the back gesture pops our history entry. */
  isOpen() {
    return this.el.classList.contains('on');
  }

  close(fromBack = false) {
    this.stop();
    this.el.classList.remove('on');
    void fromBack;
  }

  private async start() {
    this.stop();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: this.facing, width: { ideal: 4032 }, height: { ideal: 3024 } },
      });
    } catch (e) {
      this.toast('Camera not available: ' + ((e as Error).message || 'permission denied'), 4000);
      this.close();
      return;
    }
    this.video.srcObject = this.stream;
    const track = this.stream.getVideoTracks()[0];
    const c = (track.getCapabilities?.() ?? {}) as Record<string, any>;
    this.caps = {
      ev: c.exposureCompensation,
      torch: !!c.torch,
      zoom: c.zoom,
    };
    // ask for a neutral pipeline where the device allows it
    const adv: Record<string, unknown> = {};
    if (c.whiteBalanceMode?.includes?.('continuous')) adv.whiteBalanceMode = 'continuous';
    if (c.exposureMode?.includes?.('continuous')) adv.exposureMode = 'continuous';
    if (Object.keys(adv).length) track.applyConstraints({ advanced: [adv] } as MediaTrackConstraints).catch(() => {});
    this.ev = 0;
    this.torch = false;
    this.updateEv();
    (this.el.querySelector('[data-a="torch"]') as HTMLElement).style.visibility = this.caps.torch ? '' : 'hidden';
    this.el.querySelector('.cam-ev')!.classList.toggle('hide', !this.caps.ev);
  }

  private stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private track() {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  private async action(a: string) {
    tick();
    if (a === 'close') return this.close();
    if (a === 'flip') {
      this.facing = this.facing === 'environment' ? 'user' : 'environment';
      return this.start();
    }
    if (a === 'torch' && this.caps.torch) {
      this.torch = !this.torch;
      this.track()?.applyConstraints({ advanced: [{ torch: this.torch } as MediaTrackConstraintSet] }).catch(() => {});
      this.el.querySelector('[data-a="torch"]')!.classList.toggle('orange', this.torch);
      return;
    }
    if (a === 'shoot') return this.shoot();
  }

  private async shoot() {
    const track = this.track();
    if (!track || this.busy) return;
    this.busy = true;
    this.el.classList.add('flash');
    setTimeout(() => this.el.classList.remove('flash'), 180);
    try {
      let blob: Blob | null = null;
      if (typeof ImageCapture !== 'undefined') {
        try {
          const cap = new ImageCapture(track);
          const pc = await cap.getPhotoCapabilities();
          blob = await cap.takePhoto({ imageWidth: pc.imageWidth.max, imageHeight: pc.imageHeight.max });
        } catch {
          blob = null;
        }
      }
      if (!blob) blob = await this.grabFrame();
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const file = new File([blob], `LUMEN_${stamp}.jpg`, { type: blob.type || 'image/jpeg' });
      tick(true);
      this.close();
      this.onPhoto?.(file);
    } catch (e) {
      this.toast('Could not take the photo: ' + (e as Error).message, 4000);
    } finally {
      this.busy = false;
    }
  }

  /** Fallback: the current video frame at full stream resolution. */
  private grabFrame(): Promise<Blob> {
    const v = this.video;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('no frame'))), 'image/jpeg', 0.97));
  }

  private updateEv() {
    const val = this.el.querySelector('.cam-ev .val') as HTMLElement;
    val.textContent = (this.ev > 0 ? '+' : this.ev < 0 ? '' : '±') + this.ev.toFixed(1);
  }

  private bindSwipe() {
    let x0 = 0, ev0 = 0, id = -1;
    this.video.addEventListener('pointerdown', (e) => {
      if (!this.caps.ev) return;
      id = e.pointerId;
      x0 = e.clientX;
      ev0 = this.ev;
      this.video.setPointerCapture(id);
    });
    this.video.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id || !this.caps.ev) return;
      const r = this.caps.ev;
      const step = r.step || 0.1;
      let v = ev0 + ((e.clientX - x0) / this.video.clientWidth) * (r.max - r.min) * 0.8;
      v = Math.round(Math.min(r.max, Math.max(r.min, v)) / step) * step;
      if (v !== this.ev) {
        this.ev = v;
        tick();
        this.updateEv();
        this.track()?.applyConstraints({ advanced: [{ exposureCompensation: v } as MediaTrackConstraintSet] }).catch(() => {});
      }
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === id) id = -1;
    };
    this.video.addEventListener('pointerup', end);
    this.video.addEventListener('pointercancel', end);
  }
}
