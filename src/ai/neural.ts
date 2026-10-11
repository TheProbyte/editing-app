// Neural object removal: MI-GAN running in a worker. The model (28 MB) ships with the app, is
// cached after the first use, and the worker stays alive so later fills start right away.
import { fetchModel } from './segment';

export class NeuralFill {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;

  private init(progress: (f: number) => void) {
    this.ready ??= (async () => {
      const bytes = await fetchModel(new URL('models/migan.onnx', document.baseURI).href, progress);
      const wk = new Worker(new URL('./neuralWorker.ts', import.meta.url), { type: 'module' });
      this.worker = wk;
      await new Promise<void>((res, rej) => {
        wk.onmessage = (e) => {
          if (e.data.log) console.info('[lumen]', e.data.log);
          else if (e.data.ready) res();
          else if (e.data.error) rej(new Error(e.data.error));
        };
        wk.onerror = (e) => rej(new Error(e.message || 'Could not start the AI model'));
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const threads = Number(new URLSearchParams(location.search).get('ortThreads')) || 0;
        // don't leave the user waiting forever on a model that won't start
        setTimeout(() => rej(new Error('The AI model took too long to start')), 60_000);
        wk.postMessage({ type: 'init', bytes: buf, threads, wasm: new URL('ort/ort-wasm-simd-threaded.wasm', document.baseURI).href, mjs: new URL('ort/ort-wasm-simd-threaded.mjs', document.baseURI).href }, [buf]);
      });
    })();
    this.ready.catch(() => {
      this.ready = null;
      this.worker?.terminate();
      this.worker = null;
    });
    return this.ready;
  }

  get loaded() {
    return !!this.worker && this.ready !== null;
  }

  /** Fill the masked pixels (mask 1 = remove). Returns RGBA with a soft alpha around the fill. */
  async fill(rgba: Uint8ClampedArray, w: number, h: number, mask: Uint8Array, stage: (s: string) => void): Promise<Uint8ClampedArray> {
    if (!this.loaded) stage('Loading AI model');
    await this.init((f) => stage(`Loading AI model ${Math.round(f * 100)}%`));
    stage('Removing');
    const wk = this.worker!;
    return new Promise((res, rej) => {
      wk.onmessage = (e) => {
        if (e.data.log) console.info('[lumen]', e.data.log);
        else if (e.data.done) res(e.data.done);
        else if (e.data.error) rej(new Error(e.data.error));
      };
      wk.onerror = (e) => rej(new Error(e.message || 'AI fill failed'));
      wk.postMessage({ type: 'run', rgba, w, h, mask }, [rgba.buffer, mask.buffer]);
    });
  }
}
