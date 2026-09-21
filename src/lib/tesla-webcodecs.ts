interface TeslaDecodedFrame {
  displayWidth: number;
  displayHeight: number;
  timestamp: number;
  close(): void;
}

declare global {
  class EncodedVideoChunk {
    constructor(init: {
      type: 'key' | 'delta';
      timestamp: number;
      duration?: number;
      data?: BufferSource;
    });
  }

  class VideoDecoder {
    readonly decodeQueueSize: number;
    constructor(init: {
      output: (frame: TeslaDecodedFrame) => void;
      error: (error: DOMException) => void;
    });
    configure(config: {
      codec: string;
      description?: BufferSource;
      optimizeForLatency?: boolean;
    }): void;
    decode(chunk: EncodedVideoChunk): void;
    flush(): Promise<void>;
    close(): void;
  }
}

type AccessUnit = {
  key: boolean;
  data: Uint8Array;
};

export type TeslaWebCodecsController = {
  pause: () => void;
  play: () => void;
  destroy: () => void;
};

type StartOptions = {
  src: string;
  canvas: HTMLCanvasElement;
  audio?: HTMLAudioElement | null;
  signal?: AbortSignal;
  onStarted?: () => void;
  onError?: (error: Error) => void;
};

function proxyUrl(raw: string): string {
  if (raw.startsWith('/api/tesla/proxy')) return raw;
  return `/api/tesla/proxy?url=${encodeURIComponent(raw)}`;
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) throw new Error(`播放列表请求失败 (${response.status})`);
  return response.text();
}

type Segment = { url: string; duration: number };

function parseMediaPlaylist(text: string): {
  master: boolean;
  variants: { url: string; bandwidth: number }[];
  segments: Segment[];
  endList: boolean;
  encrypted: boolean;
  fmp4: boolean;
} {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants: { url: string; bandwidth: number }[] = [];
  const segments: Segment[] = [];
  let pendingDuration = 4;
  let expectVariant = false;
  let bandwidth = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      expectVariant = true;
      const match = /BANDWIDTH=(\d+)/.exec(line);
      bandwidth = match ? Number(match[1]) : 0;
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const match = /#EXTINF:([\d.]+)/.exec(line);
      pendingDuration = match ? Number(match[1]) : 4;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (expectVariant) {
      variants.push({ url: line, bandwidth });
      expectVariant = false;
      continue;
    }
    segments.push({ url: line, duration: pendingDuration });
  }
  return {
    master: variants.length > 0,
    variants,
    segments,
    endList: text.includes('#EXT-X-ENDLIST'),
    encrypted: /#EXT-X-KEY:METHOD=(?!NONE)/.test(text),
    fmp4: text.includes('#EXT-X-MAP'),
  };
}

async function resolveMedia(src: string, signal?: AbortSignal): Promise<{
  segments: Segment[];
  endList: boolean;
  playlistUrl: string;
}> {
  let playlistUrl = proxyUrl(src);
  for (let hop = 0; hop < 4; hop += 1) {
    const text = await fetchText(playlistUrl, signal);
    const parsed = parseMediaPlaylist(text);
    if (parsed.encrypted) {
      throw new Error('加密 HLS 请改用兼容模式');
    }
    if (parsed.fmp4) {
      throw new Error('fMP4 分片请改用兼容模式');
    }
    if (parsed.master) {
      const best = [...parsed.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
      if (!best) throw new Error('没有可用清晰度');
      playlistUrl = best.url.startsWith('/api/tesla/proxy') ? best.url : proxyUrl(best.url);
      continue;
    }
    return { segments: parsed.segments, endList: parsed.endList, playlistUrl };
  }
  throw new Error('播放列表跳转过多');
}

function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const avcC = new Uint8Array(11 + sps.length + pps.length);
  avcC[0] = 1;
  avcC[1] = sps[1];
  avcC[2] = sps[2];
  avcC[3] = sps[3];
  avcC[4] = 0xff;
  avcC[5] = 0xe1;
  avcC[6] = (sps.length >> 8) & 0xff;
  avcC[7] = sps.length & 0xff;
  avcC.set(sps, 8);
  const ppsOffset = 8 + sps.length;
  avcC[ppsOffset] = 1;
  avcC[ppsOffset + 1] = (pps.length >> 8) & 0xff;
  avcC[ppsOffset + 2] = pps.length & 0xff;
  avcC.set(pps, ppsOffset + 3);
  return avcC;
}

function codecFromSps(sps: Uint8Array): string {
  const hex = (value: number) => value.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

function splitNals(payload: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i < payload.length - 3; i += 1) {
    if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    } else if (
      i < payload.length - 4 &&
      payload[i] === 0 &&
      payload[i + 1] === 0 &&
      payload[i + 2] === 0 &&
      payload[i + 3] === 1
    ) {
      starts.push(i + 4);
      i += 3;
    }
  }
  const nals: Uint8Array[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] - (payload[starts[i + 1] - 4] === 0 ? 4 : 3) : payload.length;
    const nal = payload.subarray(starts[i], Math.max(starts[i], end));
    if (nal.length > 1) nals.push(nal);
  }
  return nals;
}

type PesPayload = { pts90k: number | null; data: Uint8Array };

function readPts90k(pes: Uint8Array): number | null {
  if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return null;
  if ((pes[7] & 0x80) === 0) return null;
  return (
    (pes[9] & 0x0e) * 536870912 +
    pes[10] * 4194304 +
    (pes[11] & 0xfe) * 16384 +
    pes[12] * 128 +
    (pes[13] >> 1)
  );
}

function extractVideoPes(ts: Uint8Array): PesPayload[] {
  const chunks: PesPayload[] = [];
  let pmtPid = -1;
  let videoPid = -1;
  let current: PesPayload | null = null;
  const pushCurrent = () => {
    if (current && current.data.length) chunks.push(current);
    current = null;
  };
  for (let offset = 0; offset + 188 <= ts.length; offset += 188) {
    if (ts[offset] !== 0x47) continue;
    const pid = ((ts[offset + 1] & 0x1f) << 8) | ts[offset + 2];
    const payloadStart = (ts[offset + 1] & 0x40) !== 0;
    const adapt = (ts[offset + 3] >> 4) & 0x3;
    let cursor = offset + 4;
    if (adapt === 2 || adapt === 3) {
      cursor += 1 + ts[offset + 4];
    }
    if (adapt === 0 || adapt === 2 || cursor >= offset + 188) continue;
    const packet = ts.subarray(cursor, offset + 188);
    if (pid === 0 && payloadStart && pmtPid < 0) {
      const section = packet[0] + 1;
      if (section + 12 <= packet.length) {
        const programNumber = (packet[section + 8] << 8) | packet[section + 9];
        const mapPid = ((packet[section + 10] & 0x1f) << 8) | packet[section + 11];
        if (programNumber !== 0) pmtPid = mapPid;
      }
      continue;
    }
    if (pid === pmtPid && payloadStart && videoPid < 0) {
      const section = packet[0] + 1;
      if (section + 12 > packet.length) continue;
      const sectionLength = ((packet[section + 1] & 0x0f) << 8) | packet[section + 2];
      const programInfoLength = ((packet[section + 10] & 0x0f) << 8) | packet[section + 11];
      let index = section + 12 + programInfoLength;
      const end = Math.min(packet.length, section + 3 + sectionLength - 4);
      while (index + 5 <= end) {
        const streamType = packet[index];
        const elementaryPid = ((packet[index + 1] & 0x1f) << 8) | packet[index + 2];
        const esInfoLength = ((packet[index + 3] & 0x0f) << 8) | packet[index + 4];
        if (streamType === 0x1b) videoPid = elementaryPid;
        index += 5 + esInfoLength;
      }
      continue;
    }
    if (pid !== videoPid || videoPid < 0) continue;
    if (payloadStart && packet.length > 9 && packet[0] === 0 && packet[1] === 0 && packet[2] === 1) {
      pushCurrent();
      const headerLength = packet[8];
      current = {
        pts90k: readPts90k(packet),
        data: packet.subarray(Math.min(packet.length, 9 + headerLength)),
      };
    } else if (current) {
      const next = new Uint8Array(current.data.length + packet.length);
      next.set(current.data, 0);
      next.set(packet, current.data.length);
      current.data = next;
    }
  }
  pushCurrent();
  return chunks;
}

function toAccessUnits(nals: Uint8Array[]): { units: AccessUnit[]; sps?: Uint8Array; pps?: Uint8Array } {
  let sps: Uint8Array | undefined;
  let pps: Uint8Array | undefined;
  const units: AccessUnit[] = [];
  let pending: Uint8Array[] = [];
  let key = false;

  const flush = () => {
    if (!pending.length) return;
    const hasSlice = pending.some((nal) => {
      const nalType = nal[0] & 0x1f;
      return nalType === 1 || nalType === 5;
    });
    if (!hasSlice) {
      pending = [];
      key = false;
      return;
    }
    let size = 0;
    pending.forEach((nal) => {
      size += 4 + nal.length;
    });
    const data = new Uint8Array(size);
    let offset = 0;
    pending.forEach((nal) => {
      data[offset] = (nal.length >> 24) & 0xff;
      data[offset + 1] = (nal.length >> 16) & 0xff;
      data[offset + 2] = (nal.length >> 8) & 0xff;
      data[offset + 3] = nal.length & 0xff;
      data.set(nal, offset + 4);
      offset += 4 + nal.length;
    });
    units.push({ key, data });
    pending = [];
    key = false;
  };

  nals.forEach((nal) => {
    const type = nal[0] & 0x1f;
    if (type === 7) sps = nal;
    if (type === 8) pps = nal;
    if (type === 1 || type === 5) {
      flush();
      key = type === 5;
    }
    if (type !== 9 && type !== 12) pending.push(nal);
  });
  flush();
  return { units, sps, pps };
}

export function startTeslaWebCodecs(options: StartOptions): TeslaWebCodecsController {
  if (typeof VideoDecoder === 'undefined') {
    throw new Error('当前浏览器没有 WebCodecs，请改用兼容模式');
  }

  const abort = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) abort.abort();
    else options.signal.addEventListener('abort', () => abort.abort(), { once: true });
  }
  const signal = abort.signal;
  let paused = false;
  let destroyed = false;
  let decoder: VideoDecoder | null = null;
  const ctx = options.canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');

  const queue: TeslaDecodedFrame[] = [];
  const MAX_BUFFERED_FRAMES = 45;
  let presentTimer = 0;
  let haveClock = false;
  let wallOrigin = 0;
  let started = false;

  const markStarted = () => {
    if (started) return;
    started = true;
    options.onStarted?.();
  };

  const closeQueuedFrames = () => {
    while (queue.length) queue.pop()?.close();
  };

  const drawFrame = (frame: TeslaDecodedFrame) => {
    if (options.canvas.width !== frame.displayWidth) {
      options.canvas.width = frame.displayWidth;
    }
    if (options.canvas.height !== frame.displayHeight) {
      options.canvas.height = frame.displayHeight;
    }
    ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
    frame.close();
    markStarted();
  };

  const schedulePresent = () => {
    if (destroyed) return;
    presentTimer = window.setTimeout(present, 15);
  };

  // 画面时钟跟 <audio> 的 currentTime 走。两边都从同一直播沿起播，第一帧出现时才开声音。
  const present = () => {
    if (destroyed) return;
    schedulePresent();
    if (paused || !queue.length) return;

    const now = performance.now();
    const audio = options.audio;
    if (!haveClock) {
      if (queue.length < 5) return;
      haveClock = true;
      wallOrigin = now;
      audio?.play()?.catch(() => undefined);
    }

    const audioMoved =
      !!audio && audio.readyState >= 2 && !audio.paused && audio.currentTime > 0.05;
    if (audio && !audioMoved && audio.paused && now - wallOrigin > 500) {
      audio.play()?.catch(() => undefined);
    }
    // 有 <audio> 时画面只跟它的 currentTime，避免墙钟先跑起来再和声音错位。
    const media = audioMoved
      ? audio.currentTime
      : !audio && now - wallOrigin > 1500
        ? (now - wallOrigin) / 1000
        : 0;

    let draw: TeslaDecodedFrame | null = null;
    while (queue.length && queue[0].timestamp / 1_000_000 <= media + 0.04) {
      if (draw) draw.close();
      draw = queue.shift() ?? null;
    }
    if (draw) drawFrame(draw);
  };
  schedulePresent();

  const waitWhilePaused = async () => {
    while (paused && !destroyed && !signal.aborted) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
  };

  const run = async () => {
    const { segments, endList } = await resolveMedia(options.src, signal);
    if (!segments.length) throw new Error('播放列表没有分片');

    let timestamp = 0;
    let primed = false;
    let ptsOrigin: number | null = null;
    const seen = new Set<string>();

    const ensureDecoder = (sps: Uint8Array, pps: Uint8Array) => {
      if (decoder) return;
      decoder = new VideoDecoder({
        output: (frame) => {
          if (destroyed) {
            frame.close();
            return;
          }
          queue.push(frame);
        },
        error: (error) => {
          if (destroyed || signal.aborted) return;
          options.onError?.(error);
        },
      });
      decoder.configure({
        codec: codecFromSps(sps),
        description: buildAvcC(sps, pps),
        optimizeForLatency: true,
      });
    };

    const playList = async (list: Segment[]) => {
      for (const segment of list) {
        if (destroyed || signal.aborted) return;
        if (seen.has(segment.url)) continue;
        seen.add(segment.url);
        await waitWhilePaused();
        const response = await fetch(segment.url, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal,
        });
        if (!response.ok) {
          if (response.status === 404) continue;
          throw new Error(`分片请求失败 (${response.status})`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const pesList = extractVideoPes(bytes);
        const frameDuration = Math.max(
          1,
          Math.round((segment.duration * 1_000_000) / Math.max(pesList.length, 1))
        );
        for (const pes of pesList) {
          if (destroyed || signal.aborted) return;
          const { units, sps, pps } = toAccessUnits(splitNals(pes.data));
          if (sps && pps) ensureDecoder(sps, pps);
          if (!decoder) continue;
          let pesTs = 0;
          if (pes.pts90k != null && ptsOrigin != null) {
            let delta = pes.pts90k - ptsOrigin;
            if (delta < 0) delta += 0x200000000;
            pesTs = Math.round((delta * 1_000_000) / 90000);
          }
          for (const unit of units) {
            if (destroyed || signal.aborted) return;
            if (!unit.key && !primed) continue;
            if (ptsOrigin == null && pes.pts90k != null) {
              ptsOrigin = pes.pts90k;
              pesTs = 0;
            }
            primed = true;
            while (
              !destroyed &&
              !signal.aborted &&
              decoder &&
              (decoder.decodeQueueSize > 6 || queue.length >= MAX_BUFFERED_FRAMES)
            ) {
              await new Promise((resolve) => window.setTimeout(resolve, 20));
            }
            if (destroyed || signal.aborted || !decoder) return;
            decoder.decode(
              new EncodedVideoChunk({
                type: unit.key ? 'key' : 'delta',
                timestamp: Math.max(0, pesTs),
                duration: frameDuration,
                data: unit.data,
              })
            );
            pesTs += frameDuration;
            timestamp = pesTs;
          }
        }
      }
    };

    const initialSegments = endList || segments.length < 2
      ? segments
      : segments.slice(Math.max(0, segments.length - 3), segments.length - 1);
    await playList(initialSegments);
    if (!decoder && !destroyed && !signal.aborted) {
      throw new Error('没有解出 H.264 画面，请改用兼容模式');
    }

    if (!endList) {
      let playlistUrl = proxyUrl(options.src);
      while (!destroyed && !signal.aborted) {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        const next = await resolveMedia(playlistUrl, signal);
        playlistUrl = next.playlistUrl;
        await playList(next.segments);
        if (next.endList) break;
      }
    }
    await decoder?.flush();
  };

  void run().catch((error) => {
    if (destroyed || signal.aborted) return;
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    pause: () => {
      paused = true;
    },
    play: () => {
      paused = false;
    },
    destroy: () => {
      destroyed = true;
      paused = false;
      abort.abort();
      if (presentTimer) window.clearTimeout(presentTimer);
      closeQueuedFrames();
      try {
        decoder?.close();
      } catch {
        // ignore
      }
      decoder = null;
    },
  };
}
