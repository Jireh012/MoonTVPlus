import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';

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

export function resolveMediaUrl(raw: string, requestOrigin: string): string {
  if (!isSafeMediaUrl(raw)) {
    throw new Error('非法媒体地址');
  }
  if (raw.startsWith('/')) {
    return new URL(raw, requestOrigin).toString();
  }
  return raw;
}

export type TeslaStreamKind = 'mpegts' | 'audio';

function buildFfmpegArgs(kind: TeslaStreamKind, inputUrl: string): string[] {
  const commonInput = [
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
    '-i',
    inputUrl,
  ];

  if (kind === 'mpegts') {
    return [
      ...commonInput,
      '-an',
      '-f',
      'mpegts',
      '-codec:v',
      'mpeg1video',
      '-s',
      '960x540',
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
      '-muxdelay',
      '0.001',
      'pipe:1',
    ];
  }

  return [
    ...commonInput,
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
): ChildProcessWithoutNullStreams {
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
