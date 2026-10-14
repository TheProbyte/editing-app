// Export: every output frame is decoded exactly (Mediabunny), put through the same GPU
// pipeline as the preview at full size and handed to the hardware encoder straight from the
// canvas. Audio (clips at their speed and volume, plus the music) is mixed offline first.
import {
  AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_VERY_HIGH,
  getFirstEncodableAudioCodec, getFirstEncodableVideoCodec, type VideoSample,
} from 'mediabunny';
import type { Media, MediaLib } from './media';
import { MIX_RATE, type AudioEngine } from './audio';
import { clipLen, layout, type VClip, type VideoProject } from './project';

export interface VideoExportOptions {
  lib: MediaLib;
  audio: AudioEngine;
  project: VideoProject;
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  fps: number;
  quality: 'high' | 'max';
  /** draw the finished frame for timeline time T onto the canvas (w×h) */
  drawFrame: (clip: VClip, media: Media, sample: VideoSample | null, T: number) => void;
  progress: (f: number, stage: string) => void;
  cancelled: () => boolean;
}


export async function exportVideo(o: VideoExportOptions): Promise<Blob> {
  const p = o.project;
  const { starts, total } = layout(p);
  if (total <= 0) throw new Error('Nothing to export');
  const vcodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: o.w, height: o.h });
  if (!vcodec) throw new Error(`This phone can’t encode ${o.w}×${o.h} video`);
  const hasAudio = p.clips.some((c) => c.vol > 0 && o.lib.get(c.src)?.audio) || !!(p.music && o.lib.get(p.music.src)?.audio && p.music.vol > 0);
  const acodec = hasAudio ? await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: MIX_RATE }) : null;

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  // bits per pixel per frame, capped at what phones record at
  const bitrate = Math.round(Math.min(80e6, o.w * o.h * o.fps * (o.quality === 'max' ? 0.3 : 0.16)));
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
      const start = starts[i], end = start + clipLen(clip);
      // the output frames that fall in this clip
      const k0 = Math.ceil(start * o.fps - 1e-6), k1 = Math.min(frames, Math.ceil(end * o.fps - 1e-6));
      if (k1 <= k0) continue;
      const times = Array.from({ length: k1 - k0 }, (_, j) => (k0 + j) / o.fps);
      if (m.kind === 'image' || !m.video) {
        for (const T of times) {
          if (o.cancelled()) throw new DOMException('cancelled', 'AbortError');
          o.drawFrame(clip, m, null, T);
          await video.add(T, 1 / o.fps);
          o.progress(++n / frames, 'Exporting');
        }
        continue;
      }
      const sink = o.lib.videoSink(m)!;
      const srcTimes = times.map((T) => Math.min(clip.out - 1e-4, clip.in + (T - start) * clip.speed));
      let j = 0;
      let last: VideoSample | null = null;
      for await (const s of sink.samplesAtTimestamps(srcTimes)) {
        if (o.cancelled()) {
          s?.close();
          throw new DOMException('cancelled', 'AbortError');
        }
        const T = times[j++];
        // no frame (before the first one): reuse the last
        const use = s ?? last;
        o.drawFrame(clip, m, use, T);
        if (s) {
          if (last && last !== s) last.close();
          last = s;
        }
        await video.add(T, 1 / o.fps);
        o.progress(++n / frames, 'Exporting');
      }
      last?.close();
    }
    video.close();
    o.progress(1, 'Finishing');
    await output.finalize();
    const buf = (output.target as BufferTarget).buffer;
    if (!buf) throw new Error('The video came out empty');
    return new Blob([buf], { type: 'video/mp4' });
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }
}
