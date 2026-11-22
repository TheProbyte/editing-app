// Neural object removal in a worker. Two models:
//  * LaMa — best quality, 208 MB, downloaded once from Hugging Face and kept on the device
//  * MI-GAN — small (28 MB), ships with the app, used when LaMa isn't downloaded or can't run
import { fetchModel, isModelCached } from './segment';

export type NeuralKind = 'lama' | 'migan';

export const LAMA_URL = 'https://huggingface.co/g-ronimo/lama/resolve/main/lama_fp32.onnx';
export const LAMA_MB = 208;
const url = (k: NeuralKind) => (k === 'lama' ? LAMA_URL : new URL('models/migan.onnx', document.baseURI).href);

export class NeuralFill {
  private worker: Worker | null = null;
  private loaded: NeuralKind | null = null;
  private loading: Promise<void> | null = null;
  private loadingKind: NeuralKind | null = null;
  private busy = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;

  /** Whether `kind` can run without a download. */
  static available(kind: NeuralKind) {
    return kind === 'migan' ? Promise.resolve(true) : isModelCached(LAMA_URL);
  }

  /** The model's bytes: downloaded the first time (LaMa), from the device after that. */
  private async bytes(kind: NeuralKind, stage: (s: string) => void) {
    const name = kind === 'lama' ? 'LaMa' : 'AI model';
    const downloading = !(await NeuralFill.available(kind));
    stage(`${downloading ? 'Downloading' : 'Loading'} ${name}`);
    return fetchModel(url(kind), (f) => stage(`${downloading ? 'Downloading' : 'Loading'} ${name} ${Math.round(f * 100)}%`));
  }

  private async start(kind: NeuralKind, bytes: Uint8Array, stage: (s: string) => void, threads: number) {
    stage(`Starting ${kind === 'lama' ? 'LaMa' : 'AI model'}`);
    const wk = new Worker(new URL('./neuralWorker.ts', import.meta.url), { type: 'module' });
    await new Promise<void>((res, rej) => {
      // a worker that didn't start is no use to anyone: don't leave it (and the model in it) behind
      const fail = (e: Error) => {
        clearTimeout(t);
        wk.terminate();
        rej(e);
      };
      const t = setTimeout(() => fail(new Error('The AI model took too long to start')), 120_000);
      wk.onmessage = (e) => {
        if (e.data.log) console.info('[lumen]', e.data.log);
        else if (e.data.ready) {
          clearTimeout(t);
          // (from here on each run sets its own handlers)
          wk.onmessage = wk.onerror = null;
          res();
        } else if (e.data.error) fail(new Error(e.data.error));
      };
      wk.onerror = (e) => fail(new Error(e.message || 'Could not start the AI model'));
      // hand the bytes over without copying when we own the whole buffer
      const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      const buf = (own ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer;
      wk.postMessage({
        type: 'init', kind, bytes: buf, threads,
        wasm: new URL('ort/ort-wasm-simd-threaded.wasm', document.baseURI).href,
        mjs: new URL('ort/ort-wasm-simd-threaded.mjs', document.baseURI).href,
      }, [buf]);
    });
    this.worker = wk;
    this.loaded = kind;
  }

  private async load(kind: NeuralKind, stage: (s: string) => void, threads: number) {
    if (this.loaded === kind && this.worker) return;
    this.worker?.terminate();
    this.worker = null;
    this.loaded = null;
    // a download that fails is reported as it is; only a model that's here but won't start gets
    // a second try
    const bytes = await this.bytes(kind, stage);
    try {
      await this.start(kind, bytes, stage, threads);
    } catch (e) {
      if (threads <= 1 || /took too long/i.test(String((e as Error).message))) throw e;
      // threads can fail to start in some WebViews: try once more on a single thread (the bytes
      // went to the first worker, so they're read again: from the device now, not the network)
      console.warn('Threaded start failed, retrying on one thread', e);
      await this.start(kind, await this.bytes(kind, stage), stage, 1);
    }
  }

  /** Stop the worker and let go of the model (the next fill starts it again). */
  private dispose() {
    clearTimeout(this.idle);
    this.worker?.terminate();
    this.worker = null;
    this.loaded = null;
    this.loading = null;
    this.loadingKind = null;
  }

  /** Fill the masked pixels (mask 1 = remove). Returns RGBA with a soft alpha around the fill. */
  async fill(kind: NeuralKind, rgba: Uint8ClampedArray, w: number, h: number, mask: Uint8Array, stage: (s: string) => void): Promise<Uint8ClampedArray> {
    const cores = navigator.hardwareConcurrency || 2;
    const want = new URLSearchParams(location.search).get('ortThreads');
    const threads = want ? Number(want) : self.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 1)) : 1;
    clearTimeout(this.idle);
    this.busy++;
    try {
      if (this.loaded !== kind || !this.worker) {
        if (!this.loading || this.loadingKind !== kind) {
          this.loadingKind = kind;
          this.loading = this.load(kind, stage, threads);
        }
        await this.loading;
      }
      stage(kind === 'lama' ? 'Removing · LaMa is thorough, this takes a moment' : 'Removing');
      const wk = this.worker;
      if (!wk) throw new Error('The AI model stopped');
      return await new Promise<Uint8ClampedArray>((res, rej) => {
        wk.onmessage = (e) => {
          if (e.data.log) console.info('[lumen]', e.data.log);
          else if (e.data.done) res(e.data.done);
          else if (e.data.error) rej(new Error(e.data.error));
        };
        wk.onerror = (e) => rej(new Error(e.message || 'AI fill failed'));
        wk.postMessage({ type: 'run', rgba, w, h, mask }, [rgba.buffer, mask.buffer]);
      });
    } catch (e) {
      // start clean next time: a model that failed to load or mid-run may not run again
      this.dispose();
      throw e;
    } finally {
      // don't hold the model (LaMa is 208 MB, more once loaded) long after the last fill
      if (--this.busy === 0 && this.worker) this.idle = setTimeout(() => this.dispose(), 60_000);
    }
  }
}
