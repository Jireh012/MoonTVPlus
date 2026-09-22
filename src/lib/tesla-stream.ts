import { spawn, type ChildProcessByStdio } from 'child_process';
import { existsSync } from 'fs';
import type { Readable } from 'stream';

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  'ffmpeg',
  '/opt/homebrew/bin/ffmpeg',
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
].filter(Boolean) as string[];

let cachedFfmpegPath: string | null | undefined;

export function resolveFfmpegPath(): string | null {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;

  for (const candidate of FFMPEG_CANDIDATES) {
    if (candidate === 'ffmpeg') {
      cachedFfmpegPath = candidate;
      return candidate;
    }
    if (existsSync(candidate)) {
      cachedFfmpegPath = candidate;
      return candidate;
    }
  }

  cachedFfmpegPath = null;
  return null;
}

export function isSafeMediaUrl(raw: string): boolean {
  try {
    if (raw.startsWith('/')) return true;
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function rewritePlaylistThroughProxy(
  body: string,
  playlistUrl: string,
  proxyPath = '/api/tesla/proxy?url='
): string {
  const base = new URL(playlistUrl);
  return body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
          const absolute = new URL(uri, base).toString();
          return `URI="${proxyPath}${encodeURIComponent(absolute)}"`;
        });
      }
      const absolute = new URL(trimmed, base).toString();
      return `${proxyPath}${encodeURIComponent(absolute)}`;
    })
    .join('\n');
}

export function unwrapProxiedMediaUrl(raw: string): string {
  if (!raw.startsWith('/api/proxy/')) return raw;
  try {
    const parsed = new URL(raw, 'http://local.invalid');
    if (
      parsed.pathname !== '/api/proxy/m3u8' &&
      parsed.pathname !== '/api/proxy/vod/m3u8'
    ) {
      return raw;
    }
    const inner = parsed.searchParams.get('url');
    if (inner && isSafeMediaUrl(inner) && !inner.startsWith('/')) {
      return inner;
    }
  } catch {
    // 保持原地址
  }
  return raw;
}

export function resolveMediaUrl(raw: string, requestOrigin: string): string {
  const unwrapped = unwrapProxiedMediaUrl(raw);
  if (!isSafeMediaUrl(unwrapped)) {
    throw new Error('非法媒体地址');
  }
  if (unwrapped.startsWith('/')) {
    return new URL(unwrapped, requestOrigin).toString();
  }
  return unwrapped;
}

export type TeslaStreamKind = 'mpegts' | 'audio' | 'mjpeg';

const MJPEG_FPS = Math.max(8, Math.min(30, Number(process.env.MJPEG_FPS) || 18));
const MJPEG_QUALITY = Math.max(2, Math.min(31, Number(process.env.MJPEG_QUALITY) || 6));
const MJPEG_WIDTH = Math.max(320, Math.min(1920, Number(process.env.MJPEG_WIDTH) || 960));
const MJPEG_HEIGHT = Math.max(180, Math.min(1080, Number(process.env.MJPEG_HEIGHT) || 544));

function buildFfmpegArgs(kind: TeslaStreamKind, inputUrl: string): string[] {
  const hls = /\.m3u8?(\?|$)/i.test(inputUrl);
  const beforeInput = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5',
    '-rw_timeout',
    '15000000',
    '-fflags',
    'nobuffer+discardcorrupt+genpts',
    '-flags',
    'low_delay',
    '-probesize',
    '32768',
    '-analyzeduration',
    '0',
  ];
  // 和 WebCodecs 一样从倒数第 3 个完整分片起播，避免声音从播放列表开头、画面从直播沿。
  if (hls) {
    beforeInput.push('-live_start_index', '-3');
  }
  beforeInput.push('-i', inputUrl);

  if (kind === 'mpegts') {
    return [
      ...beforeInput,
      '-vf',
      'scale=960:540:flags=bicubic,pad=960:544:0:2,format=yuv420p',
      '-c:v',
      'mpeg1video',
      '-b:v',
      '1400k',
      '-maxrate',
      '1600k',
      '-bufsize',
      '2800k',
      '-bf',
      '0',
      '-r',
      '24',
      '-c:a',
      'mp2',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-muxdelay',
      '0',
      '-muxpreload',
      '0',
      '-f',
      'mpegts',
      'pipe:1',
    ];
  }

  if (kind === 'mjpeg') {
    return [
      ...beforeInput,
      '-vf',
      `scale=${MJPEG_WIDTH}:${MJPEG_HEIGHT}:force_original_aspect_ratio=decrease,pad=${MJPEG_WIDTH}:${MJPEG_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
      '-c:v',
      'mjpeg',
      '-q:v',
      String(MJPEG_QUALITY),
      '-r',
      String(MJPEG_FPS),
      '-f',
      'image2pipe',
      '-vframes',
      '99999999',
      'pipe:1',
    ];
  }

  return [
    ...beforeInput,
    '-vn',
    '-f',
    'mp3',
    '-codec:a',
    'libmp3lame',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-b:a',
    '128k',
    'pipe:1',
  ];
}

function findJpegMarker(
  data: Uint8Array,
  from: number,
  a: number,
  b: number
): number {
  for (let i = from; i < data.length - 1; i += 1) {
    if (data[i] === 0xff && data[i + 1] === a) return i;
    if (b >= 0 && data[i] === 0xff && data[i + 1] === b) return i;
  }
  return -1;
}

/**
 * 把 ffmpeg image2pipe 输出的裸 JPEG 流封装成 multipart/x-mixed-replace。
 * JPEG 熵编码区经 0xFF00 填充，FFD8(SOI)/FFD9(EOI) 只会出现在帧边界，可安全切分。
 */
export function createMjpegMultipartStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  const header = (length: number) =>
    new TextEncoder().encode(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${length}\r\n\r\n`
    );
  const tail = new TextEncoder().encode('\r\n');
  let buffer: Uint8Array = new Uint8Array(0);

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      buffer = merged;

      let cursor = 0;
      for (;;) {
        const soi = findJpegMarker(buffer, cursor, 0xd8, -1);
        if (soi < 0) break;
        const eoi = findJpegMarker(buffer, soi + 2, 0xd9, -1);
        if (eoi < 0) break;
        const frame = buffer.subarray(soi, eoi + 2);
        try {
          controller.enqueue(header(frame.length));
          controller.enqueue(frame);
          controller.enqueue(tail);
        } catch {
          return;
        }
        cursor = eoi + 2;
      }
      buffer = buffer.slice(cursor);
    },
  });
}

export function spawnTeslaFfmpeg(
  kind: TeslaStreamKind,
  inputUrl: string
): ChildProcessByStdio<null, Readable, Readable> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('服务器未安装 ffmpeg，无法启用 Tesla 画布播放');
  }

  const args = buildFfmpegArgs(kind, inputUrl);
  const child = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return child;
}

export function createFfmpegReadableStream(
  kind: TeslaStreamKind,
  inputUrl: string,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  const child = spawnTeslaFfmpeg(kind, inputUrl);
  let closed = false;

  const kill = () => {
    if (closed) return;
    closed = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  };

  if (signal) {
    if (signal.aborted) kill();
    else signal.addEventListener('abort', kill, { once: true });
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          kill();
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.trim()) {
          console.warn(`[tesla-ffmpeg:${kind}]`, text.trim());
        }
      });

      child.on('error', (error) => {
        try {
          controller.error(error);
        } catch {
          // ignore
        }
        kill();
      });

      child.on('close', (code) => {
        if (!closed) {
          closed = true;
          if (code && code !== 0) {
            try {
              controller.error(new Error(`ffmpeg exited with code ${code}`));
            } catch {
              // ignore
            }
          } else {
            try {
              controller.close();
            } catch {
              // ignore
            }
          }
        }
      });
    },
    cancel() {
      kill();
    },
  });
}
