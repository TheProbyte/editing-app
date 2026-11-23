// Export: every output frame is decoded exactly (Mediabunny), put through the same GPU
// pipeline as the preview at full size and handed to the hardware encoder straight from the
// canvas. Audio (clips at their speed and volume, the voiceover and the music) is mixed offline
// first. The file is written to the site's private storage as it's made (a long export would
// not fit in memory), and handed back as that file.
//
// Frames go out in time order, clip by clip: each clip from its cut to the next (see cutTime).
// Inside a transition a second decoder runs alongside, on the other clip, so both clips'
// frames for that moment reach drawFrame together.
import {
  AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_VERY_HIGH,
  StreamTarget, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec, type VideoSample,
} from 'mediabunny';
import type { Media, MediaLib } from './media';
import { MIX_RATE, type AudioEngine } from './audio';
import { cutTime, heldLocal, layout, mixAt, srcAt, voiceLen, type VClip, type VideoProject } from './project';

export interface VideoExportOptions {
  lib: MediaLib;
  audio: AudioEngine;
  project: VideoProject;
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  fps: number;
  quality: 'high' | 'max';
  /** extra bitrate for pictures that are hard to compress (moving film grain), 1 = none */
  boost?: number;
  /** the cine frame rate a clip's picture is held to (0: none; see heldLocal) */
  cine?: (clip: VClip) => number;
  /** before a clip's frames are drawn (e.g. to read a still at full size) */
  prepare?: (clip: VClip, media: Media) => Promise<void>;
  /** draw the finished frame for timeline time T onto the canvas (w×h); inside a transition, with the other clip's frame */
  drawFrame: (clip: VClip, media: Media, sample: VideoSample | null, T: number, other?: OtherFrame) => void;
  progress: (f: number, stage: string) => void;
  cancelled: () => boolean;
}

/** The other clip of a transition, at the same moment. */
export interface OtherFrame {
  clip: VClip;
  media: Media;
  sample: VideoSample | null;
}

/**
 * The other clip's frames across one transition, decoded as they're asked for (in order). It
 * keeps the frame it last handed out (shown again where the file has none), and closes it when
 * the next one comes or it's done.
 */
class OtherFeed {
  private it: AsyncGenerator<VideoSample | null, void, unknown> | null = null;
  private last: VideoSample | null = null;
  private k = 0;
  /** the other clip's source times, one per frame it's asked for */
  readonly times: number[] = [];
  constructor(readonly clip: VClip, readonly media: Media, private lib: MediaLib) {}

  async next(): Promise<OtherFrame> {
    const m = this.media;
    if (m.kind === 'image' || !m.video) return { clip: this.clip, media: m, sample: null };
    if (!this.it) this.it = this.lib.videoSink(m)!.samplesAtTimestamps(this.times);
    const r = this.k++ < this.times.length ? await this.it.next() : { done: true as const, value: undefined };
    const s = r.done ? null : r.value;
    if (!s && !this.last) this.last = await this.lib.videoSink(m)!.getSample(await m.video.getFirstTimestamp()).catch(() => null);
    if (s) {
      if (this.last && this.last !== s) this.last.close();
      this.last = s;
    }
    return { clip: this.clip, media: m, sample: this.last };
  }

  close() {
    void this.it?.return().catch(() => {});
    this.last?.close();
    this.last = null;
  }
}

/** the folder (in the site's private storage) exports are written into */
const DIR = 'lumen-exports';

/**
 * A new file for an export in the site's private storage. What earlier exports left there goes
 * first (the last one stays until then: it may still be being saved). Null where there's no such
 * storage (older WebViews): the export is then built in memory, as before.
 */
async function diskFile() {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    const dir = await root.getDirectoryHandle(DIR, { create: true });
    const old: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) old.push(name);
    for (const name of old) await dir.removeEntry(name).catch(() => {});
    const name = `export-${Date.now()}.mp4`;
    const fh = await dir.getFileHandle(name, { create: true });
    const drop = () => dir.removeEntry(name).catch(() => {});
    if (typeof fh.createWritable !== 'function') {
      await drop();
      return null;
    }
    return { fh, writable: await fh.createWritable(), drop };
  } catch (e) {
    console.warn('no private storage for the export: building it in memory', e);
    return null;
  }
}

export async function exportVideo(o: VideoExportOptions): Promise<Blob> {
  const p = o.project;
  const L = layout(p);
  const { starts, total } = L;
  if (total <= 0) throw new Error('Nothing to export');
  const vcodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: o.w, height: o.h });
  if (!vcodec) throw new Error(`This phone can’t encode ${o.w}×${o.h} video`);
  const hasAudio = p.clips.some((c) => c.vol > 0 && o.lib.get(c.src)?.audio) || !!(p.music && o.lib.get(p.music.src)?.audio && p.music.vol > 0) ||
    (p.voice ?? []).some((v) => v.vol > 0 && voiceLen(v) > 0 && o.lib.get(v.src)?.audio);
  const acodec = hasAudio ? await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: MIX_RATE }) : null;

  const disk = await diskFile();
  // on disk the index goes at the end, written once everything's length is known (a plain MP4
  // every player and gallery reads); only in memory can it go at the front
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: disk ? false : 'in-memory' }),
    target: disk ? new StreamTarget(disk.writable, { chunked: true, chunkSize: 4 * 2 ** 20 }) : new BufferTarget(),
  });
  // bits per pixel per frame, capped at what phones record at
  const bitrate = Math.round(Math.min(80e6, o.w * o.h * o.fps * (o.quality === 'max' ? 0.3 : 0.16) * (o.boost ?? 1)));
  const video = new CanvasSource(o.canvas, { codec: vcodec, bitrate: bitrate || (o.quality === 'max' ? QUALITY_VERY_HIGH : QUALITY_HIGH), keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: o.fps });
  let audio: AudioBufferSource | null = null;
  if (acodec) {
    audio = new AudioBufferSource({ codec: acodec, bitrate: 192_000 });
    output.addAudioTrack(audio);
  }
  await output.start();

  try {
    // ---- sound
    if (audio) {
      o.progress(0, 'Mixing sound');
      // the same premixed soundtrack the preview plays
      const mix = await o.audio.mix(p);
      if (o.cancelled()) throw new DOMException('cancelled', 'AbortError');
      if (mix) await audio.add(mix);
      audio.close();
    }

    // ---- pictures
    const frames = Math.max(1, Math.round(total * o.fps));
    let n = 0;
    for (let i = 0; i < p.clips.length; i++) {
      const clip = p.clips[i];
      const m = o.lib.get(clip.src);
      if (!m) continue;
      const start = starts[i];
      // the output frames this clip leads: from its cut to the next one
      const k0 = Math.ceil(cutTime(L, i) * o.fps - 1e-6), k1 = Math.min(frames, Math.ceil(cutTime(L, i + 1) * o.fps - 1e-6));
      if (k1 <= k0) continue;
      const times = Array.from({ length: k1 - k0 }, (_, j) => (k0 + j) / o.fps);
      // inside a transition, the other clip at each of those moments (one feed per transition)
      const feeds = new Map<number, OtherFeed>();
      const others = times.map((T) => {
        const mx = mixAt(p, T, L);
        const j = mx ? (mx.a === i ? mx.b : mx.a) : -1;
        const c = p.clips[j], mj = c && o.lib.get(c.src);
        if (!mj) return null;
        let fd = feeds.get(j);
        if (!fd) feeds.set(j, (fd = new OtherFeed(c, mj, o.lib)));
        fd.times.push(Math.min(c.out - 1e-4, Math.max(c.in, srcAt(c, heldLocal(T - starts[j], o.cine?.(c) ?? 0)))));
        return fd;
      });
      const otherAt = (j: number) => others[j]?.next();
      await o.prepare?.(clip, m);
      try {
        if (m.kind === 'image' || !m.video) {
          for (let j = 0; j < times.length; j++) {
            if (o.cancelled()) throw new DOMException('cancelled', 'AbortError');
            const T = times[j];
            o.drawFrame(clip, m, null, T, await otherAt(j));
            await video.add(T, 1 / o.fps);
            o.progress(++n / frames, 'Exporting');
          }
          continue;
        }
        const sink = o.lib.videoSink(m)!;
        // (held to a cine rate: the same frame for several output frames)
        const fps = o.cine?.(clip) ?? 0;
        const srcTimes = times.map((T) => Math.min(clip.out - 1e-4, Math.max(clip.in, srcAt(clip, heldLocal(T - start, fps)))));
        let j = 0;
        let last: VideoSample | null = null;
        try {
          for await (const s of sink.samplesAtTimestamps(srcTimes)) {
            if (o.cancelled()) {
              s?.close();
              throw new DOMException('cancelled', 'AbortError');
            }
            const T = times[j];
            // no frame (before the file's first one): the last one again, or at the very start
            // of a clip its first frame, rather than whatever the previous clip left
            if (!s && !last) last = await sink.getSample(await m.video.getFirstTimestamp()).catch(() => null);
            const use = s ?? last;
            o.drawFrame(clip, m, use, T, await otherAt(j));
            j++;
            if (s) {
              if (last && last !== s) last.close();
              last = s;
            }
            await video.add(T, 1 / o.fps);
            o.progress(++n / frames, 'Exporting');
          }
        } finally {
          last?.close();
        }
      } finally {
        for (const fd of feeds.values()) fd.close();
      }
    }
    video.close();
    o.progress(1, 'Finishing');
    await output.finalize();
    if (disk) {
      // the file itself (read from disk when it's saved), not a copy of it in memory
      const f = await disk.fh.getFile();
      if (!f.size) throw new Error('The video came out empty');
      return new File([f], f.name, { type: 'video/mp4' });
    }
    const buf = (output.target as BufferTarget).buffer;
    if (!buf) throw new Error('The video came out empty');
    return new Blob([buf], { type: 'video/mp4' });
  } catch (e) {
    await output.cancel().catch(() => {});
    // a cancelled or failed export leaves no file behind
    await disk?.drop();
    throw e;
  }
}
