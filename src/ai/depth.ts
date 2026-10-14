// Depth estimation for the lens blur, in a worker (see depthWorker.ts). The model (27 MB) is
// downloaded from Hugging Face the first time and kept on the device.
import { fetchModel, isModelCached } from './segment';

export const DEPTH_URL = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx';
export const DEPTH_MB = 27;
/** tests can point at another model: ?depthModel=<url> */
const modelUrl = () => new URLSearchParams(location.search).get('depthModel') || DEPTH_URL;

export interface DepthMap {
  /** 0 = far … 1 = near, row 0 at the top */
  data: Float32Array;
  w: number;
  h: number;
}

export class DepthEstimator {
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;

  private async load(stage: (s: string) => void, threads: number) {
    this.worker?.terminate();
    this.worker = null;
    const url = modelUrl();
    const downloading = !(await isModelCached(url));
    const verb = downloading ? 'Downloading depth model' : 'Loading depth model';
    stage(verb);
    const bytes = await fetchModel(url, (f) => stage(`${verb} ${Math.round(f * 100)}%`));
    stage('Starting depth model');
    const wk = new Worker(new URL('./depthWorker.ts', import.meta.url), { type: 'module' });
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => {
        wk.terminate();
        rej(new Error('The depth model took too long to start'));
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
        rej(new Error(e.message || 'Could not start the depth model'));
      };
      const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      const buf = (own ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer;
      wk.postMessage({
        type: 'init', bytes: buf, threads,
        wasm: new URL('ort/ort-wasm-simd-threaded.wasm', document.baseURI).href,
        mjs: new URL('ort/ort-wasm-simd-threaded.mjs', document.baseURI).href,
      }, [buf]);
    });
    this.worker = wk;
  }

  /** Depth for an RGBA image (any size; the result has the same size). */
  async estimate(rgba: Uint8ClampedArray, w: number, h: number, stage: (s: string) => void): Promise<DepthMap> {
    if (!this.worker) {
      const cores = navigator.hardwareConcurrency || 2;
      const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 1)) : 1;
      this.loading ??= this.load(stage, threads).catch(async (e) => {
        // threads can fail to start in some WebViews: try once more on a single thread
        if (threads > 1 && !/took too long|download failed|failed to fetch|404|403/i.test(String(e.message))) {
          console.warn('Threaded start failed, retrying on one thread', e);
          await this.load(stage, 1);
        } else throw e;
      });
      try {
        await this.loading;
      } catch (e) {
        this.loading = null;
        throw e;
      }
    }
    stage('Finding depth');
    const wk = this.worker!;
    const data = await new Promise<Float32Array>((res, rej) => {
      wk.onmessage = (e) => {
        if (e.data.log) console.info('[lumen]', e.data.log);
        else if (e.data.done) res(e.data.done);
        else if (e.data.error) rej(new Error(e.data.error));
      };
      wk.onerror = (e) => rej(new Error(e.message || 'Depth estimation failed'));
      wk.postMessage({ type: 'run', rgba, w, h }, [rgba.buffer]);
    });
    return { data, w, h };
  }
}
