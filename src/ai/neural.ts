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

  /** Whether `kind` can run without a download. */
  static available(kind: NeuralKind) {
    return kind === 'migan' ? Promise.resolve(true) : isModelCached(LAMA_URL);
  }

  private async load(kind: NeuralKind, stage: (s: string) => void, threads: number) {
    if (this.loaded === kind && this.worker) return;
    this.worker?.terminate();
    this.worker = null;
    this.loaded = null;
    const name = kind === 'lama' ? 'LaMa' : 'AI model';
    const downloading = !(await NeuralFill.available(kind));
    stage(`${downloading ? 'Downloading' : 'Loading'} ${name}`);
    const bytes = await fetchModel(url(kind), (f) => stage(`${downloading ? 'Downloading' : 'Loading'} ${name} ${Math.round(f * 100)}%`));
    stage(`Starting ${name}`);
    const wk = new Worker(new URL('./neuralWorker.ts', import.meta.url), { type: 'module' });
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => {
        wk.terminate();
        rej(new Error('The AI model took too long to start'));
      }, 120_000);
      wk.onmessage = (e) => {
        if (e.data.log) console.info('[lumen]', e.data.log);
        else if (e.data.ready) {
          clearTimeout(t);
          res();
        } else if (e.data.error) {
          clearTimeout(t);
          rej(new Error(e.data.error));
        }
      };
      wk.onerror = (e) => {
        clearTimeout(t);
        rej(new Error(e.message || 'Could not start the AI model'));
      };
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

  /** Fill the masked pixels (mask 1 = remove). Returns RGBA with a soft alpha around the fill. */
  async fill(kind: NeuralKind, rgba: Uint8ClampedArray, w: number, h: number, mask: Uint8Array, stage: (s: string) => void): Promise<Uint8ClampedArray> {
    const cores = navigator.hardwareConcurrency || 2;
    const want = new URLSearchParams(location.search).get('ortThreads');
    const threads = want ? Number(want) : self.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 1)) : 1;
    if (this.loaded !== kind || !this.worker) {
      if (!this.loading || this.loadingKind !== kind) {
        this.loadingKind = kind;
        this.loading = this.load(kind, stage, threads).catch(async (e) => {
          // threads can fail to start in some WebViews: try once more on a single thread
          if (threads > 1 && !/took too long|download failed|failed to fetch|404|403/i.test(String(e.message))) {
            console.warn('Threaded start failed, retrying on one thread', e);
            await this.load(kind, stage, 1);
          } else throw e;
        });
      }
      try {
        await this.loading;
      } catch (e) {
        this.loading = null;
        throw e;
      }
    }
    stage(kind === 'lama' ? 'Removing · LaMa is thorough, this takes a moment' : 'Removing');
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
