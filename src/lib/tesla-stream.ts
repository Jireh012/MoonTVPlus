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

/** 解析路由上的 start（秒）查询参数，非法或缺省返回 undefined */
export function parseStartSeconds(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(value, 360000);
}

export type TeslaStreamKind = 'mpegts' | 'audio' | 'mjpeg';

const MJPEG_FPS = Math.max(8, Math.min(30, Number(process.env.MJPEG_FPS) || 18));
const MJPEG_QUALITY = Math.max(2, Math.min(31, Number(process.env.MJPEG_QUALITY) || 6));
const MJPEG_WIDTH = Math.max(320, Math.min(1920, Number(process.env.MJPEG_WIDTH) || 960));
const MJPEG_HEIGHT = Math.max(180, Math.min(1080, Number(process.env.MJPEG_HEIGHT) || 544));

/** 清晰度档位：尺寸同时决定 mpegts 编码分辨率与 mjpeg 输出尺寸，浏览器端画布按此渲染 */
export type TeslaQuality = 'low' | 'std' | 'high';

export const TESLA_QUALITY_PRESETS: Record<
  TeslaQuality,
  { width: number; height: number; videoKbps: number; mjpegQ: number; mjpegFps: number; label: string }
> = {
  // 标清档沿用 MJPEG_* 环境变量的默认，保持与历史行为一致
  low: { width: 640, height: 360, videoKbps: 700, mjpegQ: 10, mjpegFps: 12, label: '流畅' },
  std: { width: MJPEG_WIDTH, height: MJPEG_HEIGHT, videoKbps: 1400, mjpegQ: MJPEG_QUALITY, mjpegFps: MJPEG_FPS, label: '标清' },
  high: { width: 1280, height: 720, videoKbps: 2200, mjpegQ: 4, mjpegFps: 24, label: '高清' },
};

const DEFAULT_QUALITY: TeslaQuality =
  process.env.TESLA_DEFAULT_QUALITY === 'low' ||
  process.env.TESLA_DEFAULT_QUALITY === 'high'
    ? (process.env.TESLA_DEFAULT_QUALITY as TeslaQuality)
    : 'std';

export function parseQuality(raw: string | null): TeslaQuality {
  return raw === 'low' || raw === 'high' ? raw : DEFAULT_QUALITY;
}

/**
 * 兼容模式（mpeg1video + JSMpeg）画布尺寸，必须是 16 的倍数：
 * JSMpeg 从 MPEG-1 序列头读到的是向上取整到 16 的编码尺寸。
 */
export const COMPAT_CANVAS_WIDTH = 960;
export const COMPAT_CANVAS_HEIGHT = 544;

/**
 * 输入探测窗口。原来的 32KB / 0 太激进：ffmpeg 探测不出 AAC/MP2 音轨的采样率和声道，
 * 会直接把整条音频流丢掉（实测输出 TS 里只剩 mpeg1video、stderr 报
 * "Could not find codec parameters for stream 1 (Audio: aac), unspecified sample rate"），
 * 车机上就变成了无声画面。实测 probesize >= 128KB 才能稳定保留音轨。
 * analyzeduration 放宽到 1 秒，避免低码率流因为「0.5 秒的数据不足 512KB」被提前截断探测。
 */
const INPUT_PROBESIZE = 512 * 1024;
const INPUT_ANALYZEDURATION = 1000 * 1000;

/**
 * 等比缩放 + 居中黑边，并把像素比锁成 1:1。
 *
 * 关键：JSMpeg 会把 MPEG-1 序列头里的 aspect_ratio_information 直接跳过
 * （decodeSequenceHeader 读完 12bit 宽高后紧跟一句 `bits.skip(4)`），永远按方形像素渲染。
 * 所以绝不能依赖封装里的 SAR 来表达画面比例——必须在这里 setsar=1，
 * 否则 ffmpeg 会写入非方形像素比（1920x816 片源实测得到 239:182），
 * 车机上表现为画面被纵向拉伸变形。
 */
export function buildLetterboxFilter(width: number, height: number): string {
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    'setsar=1',
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
    'format=yuv420p',
  ].join(',');
}

export function buildFfmpegArgs(
  kind: TeslaStreamKind,
  inputUrl: string,
  startSeconds?: number,
  quality: TeslaQuality = DEFAULT_QUALITY
): string[] {
  const hls =
    /\.m3u8?(\?|$)/i.test(inputUrl) || inputUrl.includes('proxy-m3u8');
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
    '-probesize',
    String(INPUT_PROBESIZE),
    '-analyzeduration',
    String(INPUT_ANALYZEDURATION),
    '-flags',
    'low_delay',
  ];
  if (hls) {
    // 直播源：genpts 补缺失的 PTS，nobuffer 压低起播延迟。
    // 这两个 flag 只对直播流安全——对 mp4 之类的渐进式输入 +genpts 会让编码器拿到错误帧率
    // （实测 12800/1 fps，mpeg1video 直接打不开编码器、一个字节都不输出）。
    beforeInput.push(
      '-fflags',
      'nobuffer+discardcorrupt+genpts',
      // 和 WebCodecs 一样从倒数第 3 个完整分片起播，避免声音从播放列表开头、画面从直播沿。
      '-live_start_index',
      '-3'
    );
  } else {
    beforeInput.push('-fflags', 'discardcorrupt');
  }
  // 起播定位（拖动进度 / 续播）。必须放在 -i 之前（输入定位，跳读关键帧，秒级生效）。
  if (startSeconds && startSeconds > 0.5) {
    beforeInput.push('-ss', String(Math.floor(startSeconds * 10) / 10));
  }
  if (kind === 'mjpeg') {
    // 关键：极简 MJPEG 模式的画面是一条 image2pipe 裸流，浏览器端没有任何时钟可循，
    // ffmpeg 不加 -re 会按解码速度全速出帧——车机上就是画面 2~5 倍速快进、声音正常 1x，
    // 表现为声画不同步。加 -re 让画面按片源原生节拍实时输出，与音频流的 1x 对齐。
    beforeInput.push('-re');
  }
  beforeInput.push('-i', inputUrl);

  const preset = TESLA_QUALITY_PRESETS[quality];

  if (kind === 'mpegts') {
    return [
      ...beforeInput,
      '-vf',
      buildLetterboxFilter(preset.width, preset.height),
      '-c:v',
      'mpeg1video',
      '-b:v',
      `${preset.videoKbps}k`,
      '-maxrate',
      `${Math.round(preset.videoKbps * 1.15)}k`,
      '-bufsize',
      `${preset.videoKbps * 2}k`,
      // JSMpeg 的 MPEG-1 解码器不支持 B 帧，必须关掉
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
      buildLetterboxFilter(preset.width, preset.height),
      '-c:v',
      'mjpeg',
      '-q:v',
      String(preset.mjpegQ),
      '-r',
      String(preset.mjpegFps),
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
  inputUrl: string,
  startSeconds?: number,
  quality?: TeslaQuality
): ChildProcessByStdio<null, Readable, Readable> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('服务器未安装 ffmpeg，无法启用 Tesla 画布播放');
  }

  const args = buildFfmpegArgs(kind, inputUrl, startSeconds, quality);
  const child = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return child;
}

// ---------------------------------------------------------------------------
// ffprobe：给进度条提供片源总时长
// ---------------------------------------------------------------------------

const FFPROBE_CANDIDATES = [
  process.env.FFPROBE_PATH,
  'ffprobe',
  '/opt/homebrew/bin/ffprobe',
  '/usr/bin/ffprobe',
  '/usr/local/bin/ffprobe',
].filter(Boolean) as string[];

let cachedFfprobePath: string | null | undefined;

export function resolveFfprobePath(): string | null {
  if (cachedFfprobePath !== undefined) return cachedFfprobePath;
  for (const candidate of FFPROBE_CANDIDATES) {
    if (candidate === 'ffprobe') {
      cachedFfprobePath = candidate;
      return candidate;
    }
    if (existsSync(candidate)) {
      cachedFfprobePath = candidate;
      return candidate;
    }
  }
  cachedFfprobePath = null;
  return null;
}

/**
 * 探测片源总时长（秒）。失败返回 null（前端隐藏进度条即可，不影响播放）。
 * 注意 ffmpeg/ffprobe 会继承 Node 进程的 http_proxy 环境变量，内网源若有代理要求由部署方处理。
 */
export function probeMediaDuration(
  inputUrl: string
): Promise<number | null> {
  const ffprobePath = resolveFfprobePath();
  if (!ffprobePath) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // 探测最多等 15 秒，超时放弃（进度条退化为不可用，不影响播放本身）
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(null);
    }, 15000);

    const child = spawn(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputUrl,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const value = parseFloat(out.trim());
      finish(Number.isFinite(value) && value > 0 ? value : null);
    });
  });
}

export function createFfmpegReadableStream(
  kind: TeslaStreamKind,
  inputUrl: string,
  signal?: AbortSignal,
  startSeconds?: number,
  quality?: TeslaQuality
): ReadableStream<Uint8Array> {
  const child = spawnTeslaFfmpeg(kind, inputUrl, startSeconds, quality);
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
