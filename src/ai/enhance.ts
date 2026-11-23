// AI upscale and denoise for photos (see enhanceWorker.ts). The model (5 MB) ships with the app.
import { abortError, abortable, fetchModel } from './segment';

export type EnhanceMode = 'denoise' | 'up2' | 'up4';

/** the longest side a result may have (the GPU's texture limit on phones), and its pixel cap */
export const ENHANCE_MAX_SIDE = 8192;
export const ENHANCE_MAX_PX = 36e6;

/** Can this photo be done in this mode (the result must fit)? */
export function enhanceFits(mode: EnhanceMode, w: number, h: number) {
  const s = mode === 'up4' ? 4 : mode === 'up2' ? 2 : 1;
  return Math.max(w, h) * s <= ENHANCE_MAX_SIDE && w * h * s * s <= ENHANCE_MAX_PX;
}

export class Enhancer {
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private busy = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;

  private async load(stage: (s: string) => void, signal?: AbortSignal) {
    stage('Loading AI model');
    const bytes = await fetchModel(new URL('models/realesr-x4.onnx', document.baseURI).href, () => {}, signal);
    const cores = navigator.hardwareConcurrency || 2;
    const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 1)) : 1;
    const wk = new Worker(new URL('./enhanceWorker.ts', import.meta.url), { type: 'module' });
    await new Promise<void>((res, rej) => {
      const fail = (e: Error) => {
        signal?.removeEventListener('abort', cancel);
        wk.terminate();
        rej(e);
      };
      const cancel = () => fail(abortError());
      signal?.addEventListener('abort', cancel, { once: true });
      wk.onmessage = (e) => {
        if (e.data.ready) {
          signal?.removeEventListener('abort', cancel);
          wk.onmessage = wk.onerror = null;
          res();
        } else if (e.data.error) fail(new Error(e.data.error));
      };
      wk.onerror = (e) => fail(new Error(e.message || 'Could not start the AI model'));
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      wk.postMessage({
        type: 'init', bytes: buf, threads,
        wasm: new URL('ort/ort-wasm-simd-threaded.wasm', document.baseURI).href,
        mjs: new URL('ort/ort-wasm-simd-threaded.mjs', document.baseURI).href,
      }, [buf]);
    });
    this.worker = wk;
  }

  /** Let go of the model (it's used now and then: not kept in memory). */
  dispose() {
    clearTimeout(this.idle);
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
  }

  /**
   * Run `mode` on an RGBA picture; `stage` gets messages with progress and time left. `signal`
   * cancels it (the worker is stopped part way). The result is released from memory afterwards.
   */
  async run(rgba: Uint8ClampedArray, w: number, h: number, mode: EnhanceMode, dn: number, stage: (s: string) => void, signal?: AbortSignal) {
    if (signal?.aborted) throw abortError();
    clearTimeout(this.idle);
    this.busy++;
    try {
      if (!this.worker) {
        this.loading ??= this.load(stage, signal);
        await abortable(this.loading, signal);
      }
      const wk = this.worker!;
      const verb = mode === 'denoise' ? 'Denoising' : 'Upscaling';
      stage(verb);
      return await abortable(new Promise<{ px: Uint8ClampedArray; w: number; h: number }>((res, rej) => {
        wk.onmessage = (e) => {
          const d = e.data;
          if (d.log) console.info('[lumen]', d.log);
          else if (d.progress !== undefined) {
            const s = Math.round(d.left / 1000);
            stage(`${verb} ${Math.round(d.progress * 100)}%${d.progress < 1 && s > 3 ? ` · about ${s > 90 ? `${Math.round(s / 60)} min` : `${s} s`} left` : ''}`);
          } else if (d.done) res(d.done);
          else if (d.error) rej(new Error(d.error));
        };
        wk.onerror = (e) => rej(new Error(e.message || 'The AI model stopped'));
        wk.postMessage({ type: 'run', rgba, w, h, mode, dn }, [rgba.buffer]);
      }), signal);
    } catch (e) {
      // (a cancelled or failed run may leave the model mid-way: start clean next time)
      this.dispose();
      throw e;
    } finally {
      // a model in memory for a rare job: let it go soon after
      if (--this.busy === 0 && this.worker) this.idle = setTimeout(() => this.dispose(), 20_000);
    }
  }
}
