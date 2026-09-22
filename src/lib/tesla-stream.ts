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

/**
 * 解析路由上的 rate 查询参数（倍速）。
 * 只接受 0.5~2 之间的值——画布模式是服务端实时转码，放任 ?rate=100 会直接把服务器 CPU 打满。
 * 客户端可选的档位是 0.5 / 1 / 1.25 / 1.5 / 2（见 TeslaCanvasPlayer 的 RATE_ORDER）。
 */
export function parsePlaybackRate(raw: string | null): number {
  if (!raw) return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.5 || value > 2) return 1;
  return Math.round(value * 100) / 100;
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
  quality: TeslaQuality = DEFAULT_QUALITY,
  playbackRate = 1
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
    //
    // 倍速：-re 就是 -readrate 1，所以倍速直接换成 -readrate <rate>。
    // 画面帧率（-r）保持不变——2x 时每墙钟秒出来的帧数自然翻倍，这才是倍速该有的样子。
    if (playbackRate === 1) {
      beforeInput.push('-re');
    } else {
      beforeInput.push('-readrate', String(playbackRate));
    }
  }
  beforeInput.push('-i', inputUrl);

  const preset = TESLA_QUALITY_PRESETS[quality];

  // 音频流：倍速靠 atempo 把内容压缩/拉长，输出仍是 1 墙钟秒 1 秒数据，
  // 由浏览器端的 TCP 背压节奏消费（1x 时本来也不加 -re）。atempo 支持 0.5~2.0，正好覆盖我们的档位。
  const audioFilters: string[] =
    playbackRate !== 1 ? ['-filter:a', `atempo=${playbackRate}`] : [];

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
      ...audioFilters,
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
    ...audioFilters,
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
  quality?: TeslaQuality,
  playbackRate?: number
): ChildProcessByStdio<null, Readable, Readable> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('服务器未安装 ffmpeg，无法启用 Tesla 画布播放');
  }

  const args = buildFfmpegArgs(kind, inputUrl, startSeconds, quality, playbackRate);
  const child = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return child;
}

// ---------------------------------------------------------------------------
// ffprobe：给进度条提供片源总时长
// ---------------------------------------------------------------------------

/** 探测用的桌面 UA：不少采集源对 UA/Referer 敏感，裸请求会被 403 */
const PROBE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
 * 探测片源总时长（秒）。失败返回 null（前端把进度条退化为「不可拖动」即可，不影响播放）。
 * 注意 ffmpeg/ffprobe 会继承 Node 进程的 http_proxy 环境变量，内网源若有代理要求由部署方处理。
 *
 * 实测：对真实的远端 HLS，ffprobe 为了拿到 format=duration 会真的去拉分片，
 * 直连就要 ~5s，经 /api/proxy-m3u8 再包一层能到 23~50s，远超这里的 15s 上限 →
 * 返回 null → 车机上进度条直接不出现。所以这条只作为兜底，主路径用下面的
 * fetchHlsDuration（只读播放列表文本，快得多）。
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
        // 不少采集源对 UA/Referer 敏感，裸 ffprobe 会被 403
        '-user_agent',
        PROBE_USER_AGENT,
        '-rw_timeout',
        '12000000',
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

// ---------------------------------------------------------------------------
// HLS 播放列表时长：进度条的主路径
// ---------------------------------------------------------------------------

async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number
): Promise<{ text: string; finalUrl: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        'User-Agent': PROBE_USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!response.ok) return null;
    const text = await response.text();
    return { text, finalUrl: response.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 直接解析 HLS 播放列表求总时长：累加 media playlist 的 EXTINF。
 *
 * 比 ffprobe 快一个数量级（后者为了 format=duration 会真的去读分片），
 * master playlist 会挑码率最高的变体递归下去（最多两层）。
 * 直播流（没有 EXT-X-ENDLIST）没有总时长，返回 null 让前端把进度条变成不可拖动。
 */
export async function fetchHlsDuration(
  url: string,
  timeoutMs = 8000,
  depth = 0
): Promise<number | null> {
  if (depth > 2) return null;
  const page = await fetchTextWithTimeout(url, timeoutMs);
  if (!page) return null;
  const text = page.text;
  if (!text.trimStart().startsWith('#EXTM3U')) return null; // 不是 HLS，交给 ffprobe

  const lines = text.split(/\r?\n/);

  // master playlist：#EXT-X-STREAM-INF: 的下一行是变体地址
  const variants: { url: string; bandwidth: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const next = (lines[i + 1] || '').trim();
    if (!next || next.startsWith('#')) continue;
    try {
      variants.push({
        url: new URL(next, page.finalUrl).toString(),
        bandwidth: Number(/BANDWIDTH=(\d+)/i.exec(line)?.[1] || 0),
      });
    } catch {
      // 忽略解析不了的变体
    }
  }
  if (variants.length > 0) {
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    for (const variant of variants) {
      const value = await fetchHlsDuration(variant.url, timeoutMs, depth + 1);
      if (value && value > 0) return value;
    }
    return null;
  }

  let total = 0;
  let segments = 0;
  for (const line of lines) {
    const match = /^#EXTINF:\s*([\d.]+)/.exec(line.trim());
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) {
      total += value;
      segments += 1;
    }
  }
  if (segments === 0) return null;
  if (!text.includes('#EXT-X-ENDLIST')) return null; // 直播/滚动窗口，长度还会变
  return Math.round(total * 100) / 100;
}

/**
 * 从站内代理地址里取出上游真实地址。
 *
 * 去广告开关打开时，画布模式会把源包成 /api/proxy-m3u8?url=<上游> 再交给各条流，
 * 于是时长探测也会拿到这个包装地址。对探测来说绕这一圈纯亏：
 * 每个播放列表都要多走一趟 Next 路由（实测 50s vs 直连 4.8s），而且
 * proxy-m3u8 只做分片过滤，不影响总时长。所以探测前先把它拆开。
 *
 * 注意：不能用 resolveMediaUrl 去拆——字节流那边必须保留包装才有去广告效果。
 */
export function extractUpstreamPlaylistUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw, 'http://local.invalid');
    if (
      parsed.pathname !== '/api/proxy-m3u8' &&
      parsed.pathname !== '/api/proxy/m3u8' &&
      parsed.pathname !== '/api/proxy/vod/m3u8'
    ) {
      return null;
    }
    const inner = parsed.searchParams.get('url');
    if (!inner) return null;
    if (!isSafeMediaUrl(inner) || inner.startsWith('/')) return null;
    return inner;
  } catch {
    return null;
  }
}

export function createFfmpegReadableStream(
  kind: TeslaStreamKind,
  inputUrl: string,
  signal?: AbortSignal,
  startSeconds?: number,
  quality?: TeslaQuality,
  playbackRate?: number
): ReadableStream<Uint8Array> {
  const child = spawnTeslaFfmpeg(kind, inputUrl, startSeconds, quality, playbackRate);
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
