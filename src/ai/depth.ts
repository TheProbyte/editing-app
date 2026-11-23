// Depth estimation for the lens blur, in a worker (see depthWorker.ts). The model (27 MB) is
// downloaded from Hugging Face the first time and kept on the device.
import { abortError, abortable, fetchModel, isAbortError, isModelCached } from './segment';

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
  private busy = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;

  /** The model's bytes: downloaded the first time, from the device after that. */
  private async bytes(stage: (s: string) => void, signal?: AbortSignal) {
    const url = modelUrl();
    const downloading = !(await isModelCached(url));
    const verb = downloading ? 'Downloading depth model' : 'Loading depth model';
    stage(verb);
    return fetchModel(url, (f) => stage(`${verb} ${Math.round(f * 100)}%`), signal);
  }

  private async start(bytes: Uint8Array, stage: (s: string) => void, threads: number, signal?: AbortSignal) {
    if (signal?.aborted) throw abortError();
    stage('Starting depth model');
    const wk = new Worker(new URL('./depthWorker.ts', import.meta.url), { type: 'module' });
    await new Promise<void>((res, rej) => {
      // a worker that didn't start is no use to anyone: don't leave it (and the model in it) behind
      const fail = (e: Error) => {
        clearTimeout(t);
        signal?.removeEventListener('abort', cancel);
        wk.terminate();
        rej(e);
      };
      const cancel = () => fail(abortError());
      signal?.addEventListener('abort', cancel, { once: true });
      const t = setTimeout(() => fail(new Error('The depth model took too long to start')), 120_000);
      wk.onmessage = (e) => {
        if (e.data.log) console.info('[lumen]', e.data.log);
        else if (e.data.ready) {
          clearTimeout(t);
          signal?.removeEventListener('abort', cancel);
          // (from here on each run sets its own handlers)
          wk.onmessage = wk.onerror = null;
          res();
        } else if (e.data.error) fail(new Error(e.data.error));
      };
      wk.onerror = (e) => fail(new Error(e.message || 'Could not start the depth model'));
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

  private async load(stage: (s: string) => void, threads: number, signal?: AbortSignal) {
    this.worker?.terminate();
    this.worker = null;
    // a download that fails is reported as it is; only a model that's here but won't start gets
    // a second try
    const bytes = await this.bytes(stage, signal);
    try {
      await this.start(bytes, stage, threads, signal);
    } catch (e) {
      if (threads <= 1 || isAbortError(e) || /took too long/i.test(String((e as Error).message))) throw e;
      // threads can fail to start in some WebViews: try once more on a single thread (the bytes
      // went to the first worker, so they're read again: from the device now, not the network)
      console.warn('Threaded start failed, retrying on one thread', e);
      await this.start(await this.bytes(stage, signal), stage, 1, signal);
    }
  }

  /** Stop the worker and let go of the model (the next estimate starts it again). */
  private dispose() {
    clearTimeout(this.idle);
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
  }

  /**
   * Depth for an RGBA image (any size; the result has the same size). `signal` cancels it
   * (rejects with an AbortError): a download stops, and a model starting or running is stopped
   * too, so the next estimate starts clean.
   */
  async estimate(rgba: Uint8ClampedArray, w: number, h: number, stage: (s: string) => void, signal?: AbortSignal): Promise<DepthMap> {
    // (before anything else: an estimate cancelled before it began shouldn't stop a model that's ready)
    if (signal?.aborted) throw abortError();
    clearTimeout(this.idle);
    this.busy++;
    try {
      if (!this.worker) {
        const cores = navigator.hardwareConcurrency || 2;
        const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 1)) : 1;
        this.loading ??= this.load(stage, threads, signal);
        await abortable(this.loading, signal);
      }
      stage('Finding depth');
      const wk = this.worker;
      if (!wk) throw new Error('The depth model stopped');
      // a run can't be stopped part way: a cancel stops waiting, and the worker is let go below
      const data = await abortable(new Promise<Float32Array>((res, rej) => {
        wk.onmessage = (e) => {
          if (e.data.log) console.info('[lumen]', e.data.log);
          else if (e.data.done) res(e.data.done);
          else if (e.data.error) rej(new Error(e.data.error));
        };
        wk.onerror = (e) => rej(new Error(e.message || 'Depth estimation failed'));
        wk.postMessage({ type: 'run', rgba, w, h }, [rgba.buffer]);
      }), signal);
      return { data, w, h };
    } catch (e) {
      // start clean next time: a model that failed to load or mid-run may not run again
      this.dispose();
      throw e;
    } finally {
      // depth is worked out once per photo: the model needn't stay in memory after that
      if (--this.busy === 0 && this.worker) this.idle = setTimeout(() => this.dispose(), 15_000);
    }
  }
}
