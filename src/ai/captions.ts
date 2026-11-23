// Auto captions (see whisperWorker.ts). The model (about 43 MB) isn't inside the app: it's on the
// app's website, downloaded the first time captions are made and kept on the device (Storage
// lists it as "Captions").
import { isNative } from '../native';
import { abortError, abortable, fetchModel, isModelCached } from './segment';

/** where the model lives: this site, or (in the Android app, which doesn't carry it) the website */
const BASE = isNative ? 'https://theprobyte.github.io/editing-app/asr/' : new URL('asr/', document.baseURI).href;
const FILES = { enc: 'whisper-tiny-en-encoder.onnx', dec: 'whisper-tiny-en-decoder.onnx', tok: 'whisper-tiny-en-tokens.txt' };
export const CAPTIONS_MB = 44;

export interface Caption {
  /** seconds from the start of the sound given */
  start: number;
  end: number;
  text: string;
}

export class Captioner {
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;

  /** Is the model on the device already (no download needed)? */
  static ready() {
    return isModelCached(BASE + FILES.dec);
  }

  private async load(stage: (s: string) => void, signal?: AbortSignal) {
    const down = !(await Captioner.ready());
    const verb = down ? 'Downloading captions model' : 'Loading captions model';
    stage(verb);
    // the three files one after another, shown as one download (by size)
    const parts = [[FILES.enc, 0, 0.29], [FILES.dec, 0.29, 0.69], [FILES.tok, 0.98, 0.02]] as const;
    const got: Uint8Array[] = [];
    for (const [f, at, size] of parts) {
      got.push(await fetchModel(BASE + f, (p) => stage(`${verb} ${Math.round((at + p * size) * 100)}%`), signal, true));
    }
    const cores = navigator.hardwareConcurrency || 2;
    const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 1)) : 1;
    stage('Starting captions model');
    const wk = new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' });
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
      wk.onerror = (e) => fail(new Error(e.message || 'Could not start the captions model'));
      const own = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      const enc = own(got[0]), dec = own(got[1]);
      wk.postMessage({
        type: 'init', enc, dec, tokens: new TextDecoder().decode(got[2]), threads,
        wasm: new URL('ort/ort-wasm-simd-threaded.wasm', document.baseURI).href,
        mjs: new URL('ort/ort-wasm-simd-threaded.mjs', document.baseURI).href,
      }, [enc, dec]);
    });
    this.worker = wk;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
  }

  /**
   * Captions for a sound (mono, 16 kHz): what's said, phrase by phrase, with times. `signal`
   * cancels (the model is let go). The model is let go when done too: it's used now and then.
   */
  async transcribe(pcm: Float32Array, stage: (s: string) => void, signal?: AbortSignal): Promise<Caption[]> {
    if (signal?.aborted) throw abortError();
    try {
      if (!this.worker) {
        this.loading ??= this.load(stage, signal);
        await abortable(this.loading, signal);
      }
      const wk = this.worker!;
      stage('Listening');
      return await abortable(new Promise<Caption[]>((res, rej) => {
        wk.onmessage = (e) => {
          const d = e.data;
          if (d.progress !== undefined) {
            const s = Math.round(d.left / 1000);
            stage(`Listening ${Math.round(d.progress * 100)}%${d.progress < 1 && s > 3 ? ` · about ${s > 90 ? `${Math.round(s / 60)} min` : `${s} s`} left` : ''}`);
          } else if (d.done) res(d.done);
          else if (d.error) rej(new Error(d.error));
        };
        wk.onerror = (e) => rej(new Error(e.message || 'The captions model stopped'));
        wk.postMessage({ type: 'run', pcm }, [pcm.buffer]);
      }), signal);
    } finally {
      this.dispose();
    }
  }
}

/** Long captions split into readable pieces (about two short lines each), timed by their length. */
export function splitCaptions(list: Caption[], maxChars = 38): Caption[] {
  const out: Caption[] = [];
  for (const c of list) {
    if (c.text.length <= maxChars) {
      out.push(c);
      continue;
    }
    const words = c.text.split(' ');
    const pieces: string[] = [];
    let cur = '';
    for (const w of words) {
      if (cur && (cur + ' ' + w).length > maxChars) {
        pieces.push(cur);
        cur = w;
      } else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) pieces.push(cur);
    const total = pieces.reduce((s, p) => s + p.length, 0);
    let t = c.start;
    for (const p of pieces) {
      const d = ((c.end - c.start) * p.length) / total;
      out.push({ start: t, end: t + d, text: p });
      t += d;
    }
  }
  return out;
}
