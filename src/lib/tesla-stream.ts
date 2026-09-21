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

export type TeslaStreamKind = 'mpegts' | 'audio';

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
