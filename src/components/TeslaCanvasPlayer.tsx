'use client';

import {
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Shield,
  ShieldOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/** 清晰度档位（与服务端 TESLA_QUALITY_PRESETS 的宽高保持一致；客户端不能 import tesla-stream，因其引用 child_process） */
type TeslaQuality = 'low' | 'std' | 'high';
const QUALITY_DIMS: Record<TeslaQuality, { w: number; h: number; label: string }> = {
  low: { w: 640, h: 360, label: '流畅' },
  std: { w: 960, h: 544, label: '标清' },
  high: { w: 1280, h: 720, label: '高清' },
};
const QUALITY_ORDER: TeslaQuality[] = ['low', 'std', 'high'];

/** 倍速档位：服务端 -readrate / atempo 只接受 0.5~2 */
const RATE_ORDER = [0.5, 1, 1.25, 1.5, 2];
const SKIP_SECONDS = 10;

const LS_QUALITY = 'moontv_tesla_quality';
const LS_AD_FILTER = 'moontv_tesla_ad_filter';
const LS_SYNC_DELTA = 'moontv_tesla_sync_delta';
const LS_RATE = 'moontv_tesla_rate';
const LS_VOLUME = 'moontv_tesla_volume';

/** 时长探测失败后的重试节奏（毫秒）：片源慢/抖动时靠它把进度条补上 */
const DURATION_RETRY_DELAYS = [0, 4000, 12000, 30000];

type TeslaCanvasPlayerProps = {
  src: string;
  title?: string;
  isLive?: boolean;
  poster?: string;
  className?: string;
  /**
   * 是否自动起播。点播建议传 false：画面/声音是两条独立流，
   * 让用户点一下再同时拉流，既符合「不自动播放」的预期，也让音画从同一时刻起步。
   */
  autoPlay?: boolean;
  /** 初始起播位置（秒），用于续播。只在挂载时读取一次，之后由组件内部管理。 */
  startTime?: number;
  /** 播放源名，去广告的自定义规则按源匹配时需要 */
  sourceName?: string;
  onError?: (message: string) => void;
  /**
   * 画面真正开始输出时回调。
   * 外层页面用它收起自己的「加载中」蒙层——画布模式没有 Artplayer/video
   * 元素，页面原来的 ready/playing 事件永远不会来。
   */
  onReady?: () => void;
  /** 播放进度回调（约每秒一次），current 为含起播偏移的绝对时间（秒） */
  onProgress?: (current: number, duration: number) => void;
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function isHlsSource(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url);
}

/**
 * input[type=range] 用了 appearance-none，WebKit/Blink 下必须自己画滑块，
 * 否则车机浏览器里只剩一条灰线、拖都拖不动（看着就像「进度条不见了」）。
 */
const SLIDER_CLASS = [
  'h-1.5 cursor-pointer appearance-none rounded-full bg-white/25 accent-emerald-400',
  '[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none',
  '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-400 [&::-webkit-slider-thumb]:shadow',
  '[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full',
  '[&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-emerald-400',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

/**
 * Tesla 画布播放器（极简 MJPEG 单模式）：
 * 画面由 <img> 直接收服务端 ffmpeg 转出的 multipart JPEG 帧流，
 * 音频走独立 MP3 流（<audio> 元素）。不依赖 <video> 与 rAF，D 档最抗冻结。
 *
 * 控件对齐「正常模式」的 Artplayer：播放/暂停、进度条（可拖动）、±10s、
 * 音量、静音、倍速、清晰度、音画校准、去广告、全屏（原生 + 网页全屏兜底）。
 */
export default function TeslaCanvasPlayer({
  src,
  title,
  isLive = false,
  poster,
  className = '',
  autoPlay = true,
  startTime,
  sourceName,
  onError,
  onReady,
  onProgress,
}: TeslaCanvasPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');
  const [needGesture, setNeedGesture] = useState(false);
  const [streamNonce, setStreamNonce] = useState(0);
  // 起播手势：autoPlay=false 时先只挂海报，点了才开始拉流
  const [started, setStarted] = useState(autoPlay);
  // 进度条状态：duration 来自 /api/tesla/duration；scrub 是拖动中的临时值
  const [duration, setDuration] = useState(0);
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [seekNonce, setSeekNonce] = useState(0);
  // 当前流的起播偏移（秒）：初始为 startTime，拖动进度后更新并整流重启
  const initialStartTime = Math.max(0, startTime || 0);
  const offsetRef = useRef(initialStartTime);
  // startTime 每次渲染同步进 ref；换集（src 变化）时用它重置偏移到新一集的续播位置
  const startTimeRef = useRef(startTime);
  startTimeRef.current = startTime;
  const prevSrcRef = useRef(src);
  // 流失败容错：连续失败计数（手动操作会清零），everReady 记录是否成功出过画面
  const failCountRef = useRef(0);
  const everReadyRef = useRef(false);
  // 暂停：把当前帧画到 canvas 冻结显示，音频暂停，画面流断开；恢复时从当前位置重拉
  const [frozen, setFrozen] = useState(false);
  // 全屏：原生全屏（桌面/支持的浏览器）与 CSS 网页全屏（车机浏览器没有 Fullscreen API 时的兜底）
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [cssFullscreen, setCssFullscreen] = useState(false);
  const fsFallbackTimerRef = useRef<number | null>(null);
  // 清晰度（本地持久化，重启流生效）
  const [quality, setQuality] = useState<TeslaQuality>(() => {
    if (typeof window === 'undefined') return 'std';
    const v = window.localStorage.getItem(LS_QUALITY);
    return v === 'low' || v === 'high' ? v : 'std';
  });
  // 去广告（HLS 源走 /api/proxy-m3u8 过滤，默认开启，本地持久化）
  const [adFilter, setAdFilter] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(LS_AD_FILTER) !== '0';
  });
  // 音画校准（秒）：+ 声音提前，- 声音延后。作用在音频流 start 上。本地持久化。
  const [syncDelta, setSyncDelta] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const v = Number(window.localStorage.getItem(LS_SYNC_DELTA));
    return Number.isFinite(v) ? Math.max(-10, Math.min(10, v)) : 0;
  });
  // 倍速：服务端 -readrate（画面）+ atempo（声音）联合实现，本地持久化
  const [rate, setRate] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    const v = Number(window.localStorage.getItem(LS_RATE));
    return RATE_ORDER.includes(v) ? v : 1;
  });
  // 音量：对齐正常模式的 0~1 滑杆
  const [volume, setVolume] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    const v = Number(window.localStorage.getItem(LS_VOLUME));
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  });

  useEffect(() => {
    window.localStorage.setItem(LS_QUALITY, quality);
  }, [quality]);
  useEffect(() => {
    window.localStorage.setItem(LS_AD_FILTER, adFilter ? '1' : '0');
  }, [adFilter]);
  useEffect(() => {
    window.localStorage.setItem(LS_SYNC_DELTA, String(syncDelta));
  }, [syncDelta]);
  useEffect(() => {
    window.localStorage.setItem(LS_RATE, String(rate));
  }, [rate]);
  useEffect(() => {
    window.localStorage.setItem(LS_VOLUME, String(volume));
  }, [volume]);

  // onReady / onError / onProgress 用 ref 转发：父组件传的多是内联箭头函数，每次渲染
  // 都是新引用，若直接进 useEffect 依赖数组，父页面任何一次 setState 都会重跑 effect →
  // cleanup() 销毁播放器 → 整条流转码重来，在车机上表现为画面突然黑屏/闪烁。
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  // 音量/静音跟随 state（换流时 audio.src 变化不会重置这两个属性，但重挂载会）
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = muted;
  }, [volume, muted, streamNonce, started]);

  // 去广告：HLS 源经 /api/proxy-m3u8 包裹，由服务端执行去广告规则并递归过滤子播放列表；
  // 非 HLS（直链 mp4 等）没有广告分片的概念，原样播放
  const hlsSource = isHlsSource(src);
  const effectiveSrc =
    hlsSource && adFilter
      ? `/api/proxy-m3u8?url=${encodeURIComponent(src)}${
          sourceName ? `&source=${encodeURIComponent(sourceName)}` : ''
        }`
      : src;

  // -----------------------------------------------------------------------
  // 全屏
  // -----------------------------------------------------------------------

  // 原生全屏状态同步（含 webkit 前缀：车机/旧内核只会派发 webkitfullscreenchange）
  useEffect(() => {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
    };
    const onChange = () =>
      setNativeFullscreen(!!(doc.fullscreenElement || doc.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    onChange();
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  // CSS 网页全屏时锁滚动 + Esc 退出（原生全屏由浏览器自己处理 Esc）
  useEffect(() => {
    if (!cssFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCssFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [cssFullscreen]);

  useEffect(() => {
    return () => {
      if (fsFallbackTimerRef.current != null) {
        window.clearTimeout(fsFallbackTimerRef.current);
      }
    };
  }, []);

  const isFullscreen = nativeFullscreen || cssFullscreen;

  const exitFullscreen = useCallback(() => {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => void;
    };
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      try {
        if (doc.exitFullscreen) {
          void doc.exitFullscreen().catch(() => undefined);
        } else if (doc.webkitExitFullscreen) {
          doc.webkitExitFullscreen();
        }
      } catch {
        // ignore
      }
    }
    setCssFullscreen(false);
  }, []);

  const enterFullscreen = useCallback(() => {
    const el = containerRef.current as
      | (HTMLDivElement & {
          webkitRequestFullscreen?: (...args: never[]) => unknown;
        })
      | null;
    if (!el) return;
    const request:
      | ((...args: never[]) => unknown)
      | undefined =
      el.requestFullscreen?.bind(el) || el.webkitRequestFullscreen?.bind(el);

    // 车机浏览器（以及被策略禁用的环境）常常没有 Fullscreen API，或者调用了也没反应。
    // 这种情况直接用 CSS 网页全屏——和正常模式里 Artplayer 的「网页全屏」是同一套做法，
    // 任何浏览器都能全屏，也是「点了全屏没反应」这个问题的正解。
    if (typeof request !== 'function') {
      setCssFullscreen(true);
      return;
    }

    let settled = false;
    const clearFallback = () => {
      if (fsFallbackTimerRef.current === fallbackTimer) {
        window.clearTimeout(fallbackTimer);
        fsFallbackTimerRef.current = null;
      }
    };
    const fallbackTimer = window.setTimeout(() => {
      fsFallbackTimerRef.current = null;
      const doc = document as Document & {
        webkitFullscreenElement?: Element | null;
      };
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        setNativeFullscreen(true);
        return;
      }
      if (settled) return;
      settled = true;
      setCssFullscreen(true);
    }, 900);
    fsFallbackTimerRef.current = fallbackTimer;

    try {
      const result = request();
      if (result instanceof Promise) {
        result
          .then(() => {
            clearFallback();
            settled = true;
            setNativeFullscreen(true);
            setCssFullscreen(false);
          })
          .catch(() => {
            clearFallback();
            if (settled) return;
            settled = true;
            setCssFullscreen(true);
          });
      }
    } catch {
      clearFallback();
      if (!settled) {
        settled = true;
        setCssFullscreen(true);
      }
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (nativeFullscreen || cssFullscreen) exitFullscreen();
    else enterFullscreen();
  }, [nativeFullscreen, cssFullscreen, exitFullscreen, enterFullscreen]);

  // -----------------------------------------------------------------------
  // 时间轴
  // -----------------------------------------------------------------------

  /** 已播内容时间（不含起播偏移）。画面流没有时钟，用 <audio> 的 currentTime。 */
  const getStreamClock = useCallback((): number => {
    return audioRef.current?.currentTime || 0;
  }, []);

  const getAbsoluteTime = useCallback(
    (): number => offsetRef.current + getStreamClock(),
    [getStreamClock]
  );

  const cleanup = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    const img = imgRef.current;
    if (img) {
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src');
    }
  }, []);

  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    // MJPEG 模式收起加载遮罩的定时器（multipart 流的 load 事件不可靠）
    let loadingTimer: number | null = null;
    // 本轮流是否已就绪（遮罩定时器已触发）
    let streamReady = false;

    const start = async () => {
      // 换集（src 变化）时，回到新一集传入的起播位置，别沿用上一集拖动后的偏移
      if (prevSrcRef.current !== src) {
        prevSrcRef.current = src;
        offsetRef.current = Math.max(0, startTimeRef.current || 0);
        failCountRef.current = 0;
      }
      cleanup();
      setFrozen(false);
      setLoading(true);
      setError('');
      setPlaying(true);

      if (!src) return;

      // 流失败统一处理：
      // 1) 已经成功出过画面 → 中途断流，自动从当前位置整流重试（最多连续 2 次）；
      // 2) 起播即失败且当前不是标清 → 自动回落标清（切换清晰度后起不来的兜底）；
      // 3) 都不行 → 播放器内报错（不炸整个页面），仅起播失败时才通知页面级错误。
      const handleStreamFailure = (reason: string) => {
        if (cancelled) return;
        audioRef.current?.pause();
        if (streamReady) {
          failCountRef.current += 1;
          if (failCountRef.current <= 2) {
            offsetRef.current = getAbsoluteTime();
            setStreamNonce((n) => n + 1);
            return;
          }
        }
        if (quality !== 'std') {
          setQuality('std');
          return;
        }
        const message = `${reason}：片源可能暂时不可用，请稍后重试、换集或换源`;
        setError(message);
        setLoading(false);
        if (!everReadyRef.current) {
          onErrorRef.current?.(message);
        }
      };

      // 起播偏移：拖动进度 / 续播都靠它拼进画面流地址（服务端 -ss 输入定位）；
      // 音画校准 delta 加在音频流上（+ = 声音领先画面）；倍速由服务端 -readrate/atempo 承担
      const offset = Math.floor(offsetRef.current);
      const delta = Math.round(syncDelta * 10) / 10;
      const videoStart = Math.max(0, offset);
      const audioStart = Math.max(0, offset + delta);
      const videoStartQuery = videoStart > 0 ? `&start=${videoStart}` : '';
      const audioStartQuery = audioStart > 0 ? `&start=${audioStart}` : '';
      const qualityQuery = `&q=${quality}`;
      // 1x 时不下发参数，保持和以前完全一致的流地址
      const rateQuery = rate !== 1 ? `&rate=${rate}` : '';

      try {
        const audio = audioRef.current;
        const img = imgRef.current;
        if (!img) return;

        if (audio) {
          // 音频同样走过滤后的播放列表：广告分片必须音画同步剔除，
          // 否则视频跳过了广告、音频还在播，两边会彻底错开
          audio.src = `/api/tesla/audio?url=${encodeURIComponent(
            effectiveSrc
          )}${audioStartQuery}${rateQuery}`;
          audio.volume = volume;
          audio.muted = muted;
          audio.onerror = () => handleStreamFailure('音频流加载失败');
          const playResult = audio.play();
          if (playResult && typeof playResult.catch === 'function') {
            playResult.catch(() => setNeedGesture(true));
          }
        }

        img.onerror = () => handleStreamFailure('画面帧流加载失败');
        img.src = `/api/tesla/mjpeg?url=${encodeURIComponent(
          effectiveSrc
        )}${videoStartQuery}${qualityQuery}${rateQuery}`;

        // multipart 流的 load 事件在车机上不可靠，遮罩定时收起即视为已就绪。
        // 时长随清晰度自适应：1080p 源实测高清档首字节要 ~9.5s（标清 ~4s），
        // 固定 1.5s 会让高清档出现长时间「黑屏假死」，看起来像坏了。
        if (loadingTimer != null) window.clearTimeout(loadingTimer);
        const readyTimeout =
          quality === 'high' ? 10000 : quality === 'std' ? 4000 : 2500;
        loadingTimer = window.setTimeout(() => {
          if (cancelled) return;
          streamReady = true;
          everReadyRef.current = true;
          setLoading(false);
          onReadyRef.current?.();
        }, readyTimeout);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : '初始化 Tesla 画布播放失败';
        if (!cancelled) {
          setError(message);
          setLoading(false);
          onErrorRef.current?.(message);
        }
      }
    };

    void start();
    return () => {
      cancelled = true;
      if (loadingTimer != null) {
        window.clearTimeout(loadingTimer);
        loadingTimer = null;
      }
      cleanup();
    };
    // muted/volume 不重拉流，仅在 state 变化时改 audio 属性；streamNonce 用于「暂停恢复/重试」；
    // seekNonce 用于拖动进度；quality / syncDelta / adFilter / rate 变化都需要整流重启；
    // onError / onReady / onProgress 通过 ref 读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    src,
    cleanup,
    streamNonce,
    seekNonce,
    started,
    quality,
    syncDelta,
    adFilter,
    rate,
  ]);

  // 拉取片源总时长（点播），进度条和续播判断都要用。
  // 服务端探测可能因为慢 CDN 失败，这里按退避重试几次，避免进度条整场缺席。
  useEffect(() => {
    if (!started || isLive || !src) return;
    let cancelled = false;
    const timers: number[] = [];

    const attempt = (index: number) => {
      fetch(`/api/tesla/duration?url=${encodeURIComponent(effectiveSrc)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { duration?: number | null } | null) => {
          if (cancelled) return;
          const value = Number(j?.duration);
          if (Number.isFinite(value) && value > 0) {
            setDuration(value);
            return;
          }
          const next = index + 1;
          if (next < DURATION_RETRY_DELAYS.length) {
            timers.push(
              window.setTimeout(() => attempt(next), DURATION_RETRY_DELAYS[next])
            );
          }
        })
        .catch(() => {
          if (cancelled) return;
          const next = index + 1;
          if (next < DURATION_RETRY_DELAYS.length) {
            timers.push(
              window.setTimeout(() => attempt(next), DURATION_RETRY_DELAYS[next])
            );
          }
        });
    };

    setDuration(0);
    attempt(0);

    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
    // effectiveSrc 随 adFilter 变化，但时长不变，不作为依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, isLive, src]);

  // 进度上报：约每秒一次，把「起播偏移 + 流内时钟」交给外层保存播放记录
  useEffect(() => {
    if (!started || isLive) return;
    const timer = window.setInterval(() => {
      const current = getAbsoluteTime();
      setProgressCurrent(current);
      if (duration > 0) {
        onProgressRef.current?.(Math.min(current, duration), duration);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [started, isLive, duration, getAbsoluteTime]);

  /** 拖动进度 / ±10s：更新偏移并整流重启（服务端 -ss 定位） */
  const commitSeek = (target: number) => {
    const max = duration > 0 ? duration - 1 : target;
    const clamped = Math.max(0, Math.min(target, max));
    offsetRef.current = clamped;
    setProgressCurrent(clamped);
    setScrub(null);
    failCountRef.current = 0;
    setSeekNonce((n) => n + 1);
  };

  const skipBy = (seconds: number) => {
    commitSeek(Math.max(0, getAbsoluteTime() + seconds));
  };

  const togglePlay = () => {
    if (playing) {
      // 真暂停：音频停住，当前帧冻结到 canvas 盖住画面，并断开帧流（服务端 ffmpeg 随之退出）
      const audio = audioRef.current;
      audio?.pause();
      const canvas = canvasRef.current;
      const img = imgRef.current;
      if (canvas && img && img.src) {
        try {
          canvas
            .getContext('2d')
            ?.drawImage(img, 0, 0, canvas.width, canvas.height);
        } catch {
          // ignore
        }
      }
      try {
        imgRef.current?.removeAttribute('src');
      } catch {
        // ignore
      }
      setFrozen(true);
      setPlaying(false);
    } else {
      // 恢复：从当前位置重拉两条流
      offsetRef.current = getAbsoluteTime();
      failCountRef.current = 0;
      setFrozen(false);
      setStreamNonce((n) => n + 1);
      setPlaying(true);
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    const audio = audioRef.current;
    if (audio) audio.muted = next;
    // 从静音恢复但音量是 0 的话，给个可听的默认值，否则「取消静音」看起来还是没声音
    if (!next && volume === 0) {
      setVolume(1);
      if (audio) audio.volume = 1;
    }
  };

  const cycleRate = () => {
    const index = RATE_ORDER.indexOf(rate);
    failCountRef.current = 0;
    // 换档后从当前位置继续，别把进度拨回上次起播点
    offsetRef.current = getAbsoluteTime();
    setRate(RATE_ORDER[(index + 1) % RATE_ORDER.length]);
  };

  const cycleQuality = () => {
    const index = QUALITY_ORDER.indexOf(quality);
    failCountRef.current = 0;
    offsetRef.current = getAbsoluteTime();
    setQuality(QUALITY_ORDER[(index + 1) % QUALITY_ORDER.length]);
  };

  const toggleAdFilter = () => {
    failCountRef.current = 0;
    offsetRef.current = getAbsoluteTime();
    setAdFilter((v) => !v);
  };

  const durationKnown = duration > 0;
  // 进度条在点播下一律显示：以前以「探测到总时长」为显示条件，
  // 探测失败（慢 CDN / 代理包装）时整条进度条消失，看起来像功能被删了。
  const showProgress = started && !isLive;
  const sliderValue = scrub ?? Math.min(progressCurrent, duration || progressCurrent);
  const dims = QUALITY_DIMS[quality];
  const canTapPause = started && !error && !needGesture;

  const controlBtn =
    'flex h-10 min-w-10 items-center justify-center gap-1 rounded-full bg-white/15 px-3 text-xs font-medium text-white backdrop-blur';
  const roundBtn =
    'flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur';

  return (
    <div
      ref={containerRef}
      className={`relative flex h-full w-full flex-col overflow-hidden bg-black ${className} ${
        cssFullscreen ? 'z-[9999]' : 'rounded-xl'
      }`}
      style={
        cssFullscreen
          ? {
              position: 'fixed',
              inset: 0,
              width: '100vw',
              height: '100vh',
              borderRadius: 0,
            }
          : undefined
      }
    >
      {poster && (loading || !started) && (
        <div
          className='absolute inset-0 bg-cover bg-center opacity-40'
          style={{ backgroundImage: `url(${poster})` }}
        />
      )}
      {/* canvas 只用作暂停时的冻结帧；正常播放时隐藏，画面由 <img> 显示 */}
      <canvas
        ref={canvasRef}
        className={`h-full w-full object-contain ${frozen ? '' : 'invisible'}`}
        width={dims.w}
        height={dims.h}
      />
      <img
        key={streamNonce}
        ref={imgRef}
        alt=''
        className={`absolute inset-0 h-full w-full object-contain ${frozen ? 'invisible' : ''}`}
      />
      <audio ref={audioRef} preload='auto' playsInline />

      {/* 点画面 → 播放/暂停，和正常模式（Artplayer）一致 */}
      {canTapPause && (
        <button
          type='button'
          className='absolute inset-0 z-[5] cursor-pointer'
          aria-label={playing ? '暂停' : '播放'}
          onClick={togglePlay}
        />
      )}

      {/* 在手势浮层会盖住画面的场景下，标题挪到左上角，给底部控件腾出一整行 */}
      {title && (
        <div className='pointer-events-none absolute left-3 top-3 z-20 max-w-[70%] truncate rounded-lg bg-black/45 px-2 py-1 text-xs text-white/85'>
          {title}
        </div>
      )}

      {/* 手势起播：点播模式不自动播放，点击后画面/声音同时开始拉流 */}
      {!started && !error && (
        <button
          type='button'
          className='absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/60 text-white'
          onClick={() => setStarted(true)}
        >
          <span className='flex h-16 w-16 items-center justify-center rounded-full bg-white/20 backdrop-blur'>
            <Play className='h-8 w-8' />
          </span>
          <span className='text-lg font-semibold'>点击开始播放</span>
          {initialStartTime > 0 && (
            <span className='text-sm text-white/70'>
              将从上次进度 {formatTime(initialStartTime)} 继续
            </span>
          )}
        </button>
      )}

      {needGesture && started && !error && (
        <button
          type='button'
          className='absolute inset-0 z-30 flex items-center justify-center bg-black/70 text-lg font-semibold text-white'
          onClick={() => {
            const playResult = audioRef.current?.play();
            if (playResult && typeof playResult.then === 'function') {
              playResult
                .then(() => setNeedGesture(false))
                .catch(() => {
                  // 音频起不来（流可能已失效）：整流重启再给一次机会，别让浮层卡死
                  setNeedGesture(false);
                  failCountRef.current = 0;
                  offsetRef.current = getAbsoluteTime();
                  setStreamNonce((n) => n + 1);
                });
            } else {
              setNeedGesture(false);
            }
          }}
        >
          点击开始播放
        </button>
      )}

      {(loading || error) && started && (
        <div className='absolute inset-0 z-10 flex items-center justify-center bg-black/70 px-6 text-center'>
          {error ? (
            <div className='space-y-4 text-white'>
              <p className='text-lg font-semibold'>画布播放失败</p>
              <p className='text-sm text-white/70'>{error}</p>
              <button
                type='button'
                className='rounded-xl bg-emerald-500 px-4 py-2 text-sm font-bold text-black'
                onClick={() => {
                  failCountRef.current = 0;
                  setError('');
                  offsetRef.current = getAbsoluteTime();
                  setStreamNonce((n) => n + 1);
                }}
              >
                重新加载
              </button>
            </div>
          ) : (
            <div className='flex items-center gap-3 text-white'>
              <Loader2 className='h-6 w-6 animate-spin text-emerald-400' />
              <span>正在接收画面帧流…</span>
            </div>
          )}
        </div>
      )}

      <div className='pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-3 pt-8'>
        {/* 进度条：支持拖动定位；总时长还没探测到时置灰但依然可见 */}
        {showProgress && (
          <div className='pointer-events-auto mb-2 flex items-center gap-2'>
            <span className='w-14 shrink-0 text-center text-xs tabular-nums text-white/85'>
              {formatTime(sliderValue)}
            </span>
            <input
              type='range'
              min={0}
              max={durationKnown ? Math.max(1, Math.floor(duration)) : 100}
              step={1}
              value={
                durationKnown
                  ? Math.min(Math.max(0, sliderValue), duration)
                  : 0
              }
              disabled={!durationKnown}
              title={
                durationKnown
                  ? '拖动跳转进度'
                  : '正在获取片长，稍后即可拖动（当前只能看已播时间）'
              }
              aria-label='播放进度'
              className={`${SLIDER_CLASS} min-w-0 flex-1`}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={() => {
                if (scrub != null) commitSeek(scrub);
              }}
              onKeyDown={(e) => {
                if (scrub != null && (e.key === 'Enter' || e.key === ' ')) {
                  commitSeek(scrub);
                }
              }}
            />
            <span className='w-14 shrink-0 text-center text-xs tabular-nums text-white/85'>
              {durationKnown ? formatTime(duration) : '--:--'}
            </span>
          </div>
        )}

        <div className='pointer-events-auto flex flex-wrap items-center gap-2'>
          {/* ±10 秒（对齐正常模式的快进/快退）；直播没有可跳转的时间轴 */}
          {showProgress && (
            <button
              type='button'
              onClick={() => skipBy(-SKIP_SECONDS)}
              className={roundBtn}
              title={`后退 ${SKIP_SECONDS} 秒`}
              aria-label={`后退 ${SKIP_SECONDS} 秒`}
            >
              <RotateCcw className='h-5 w-5' />
            </button>
          )}
          <button
            type='button'
            onClick={togglePlay}
            className='flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur'
            aria-label={playing ? '暂停' : '播放'}
            title={playing ? '暂停（恢复时从当前位置继续）' : '播放'}
          >
            {playing ? <Pause className='h-6 w-6' /> : <Play className='h-6 w-6' />}
          </button>
          {showProgress && (
            <button
              type='button'
              onClick={() => skipBy(SKIP_SECONDS)}
              className={roundBtn}
              title={`前进 ${SKIP_SECONDS} 秒`}
              aria-label={`前进 ${SKIP_SECONDS} 秒`}
            >
              <RotateCw className='h-5 w-5' />
            </button>
          )}

          {/* 音量：静音 + 滑杆 */}
          <div className='flex items-center gap-1 rounded-full bg-white/10 px-2 py-1 backdrop-blur'>
            <button
              type='button'
              onClick={toggleMute}
              className='flex h-7 w-7 items-center justify-center rounded-full text-white hover:bg-white/20'
              aria-label={muted ? '取消静音' : '静音'}
              title={muted ? '取消静音' : '静音'}
            >
              {muted || volume === 0 ? (
                <VolumeX className='h-4 w-4' />
              ) : (
                <Volume2 className='h-4 w-4' />
              )}
            </button>
            <input
              type='range'
              min={0}
              max={100}
              step={1}
              value={Math.round((muted ? 0 : volume) * 100)}
              onChange={(e) => {
                const next = Number(e.target.value) / 100;
                setVolume(next);
                const audio = audioRef.current;
                if (audio) audio.volume = next;
                if (muted && next > 0) {
                  setMuted(false);
                  if (audio) audio.muted = false;
                }
              }}
              className={`${SLIDER_CLASS} w-16 sm:w-24`}
              aria-label='音量'
              title='音量'
            />
          </div>

          {/* 倍速：服务端 -readrate（画面）+ atempo（声音） */}
          <button
            type='button'
            className={controlBtn}
            title='切换播放速度（会重新缓冲）'
            aria-label='切换播放速度'
            onClick={cycleRate}
          >
            {rate}×
          </button>

          {/* 音画校准：+ 声音提前，- 声音延后（改完自动重拉生效） */}
          <div
            className='flex items-center gap-1 rounded-full bg-white/10 px-2 py-1 backdrop-blur'
            title='音画校准：＋= 声音提前，− = 声音延后，每次 0.5 秒'
          >
            <button
              type='button'
              className='h-7 w-7 rounded-full text-sm font-bold text-white/90 hover:bg-white/20'
              aria-label='声音延后 0.5 秒'
              onClick={() =>
                setSyncDelta((d) => Math.max(-10, Math.round((d - 0.5) * 10) / 10))
              }
            >
              −
            </button>
            <span className='w-12 text-center text-xs tabular-nums text-white/85'>
              {syncDelta > 0 ? '+' : ''}
              {syncDelta.toFixed(1)}s
            </span>
            <button
              type='button'
              className='h-7 w-7 rounded-full text-sm font-bold text-white/90 hover:bg-white/20'
              aria-label='声音提前 0.5 秒'
              onClick={() =>
                setSyncDelta((d) => Math.min(10, Math.round((d + 0.5) * 10) / 10))
              }
            >
              ＋
            </button>
          </div>

          <div className='min-w-0 flex-1' />

          {/* 清晰度：重启转码流生效 */}
          {!isLive && (
            <button
              type='button'
              className={controlBtn}
              title='切换清晰度（会重新缓冲，从当前位置继续）'
              aria-label='切换清晰度'
              onClick={cycleQuality}
            >
              {dims.label}
            </button>
          )}
          {/* 去广告：仅 HLS 源有意义，走服务端代理过滤广告分片 */}
          {hlsSource && (
            <button
              type='button'
              className={controlBtn}
              title={
                adFilter
                  ? '去广告已开启（点此关闭并重新缓冲）'
                  : '去广告已关闭（点此开启并重新缓冲）'
              }
              aria-label='切换去广告'
              onClick={toggleAdFilter}
            >
              {adFilter ? (
                <Shield className='h-4 w-4' />
              ) : (
                <ShieldOff className='h-4 w-4' />
              )}
              去广告
            </button>
          )}
          <button
            type='button'
            className={roundBtn}
            title={isFullscreen ? '退出全屏' : '全屏（不支持原生全屏的设备自动用网页全屏）'}
            aria-label={isFullscreen ? '退出全屏' : '全屏'}
            onClick={toggleFullscreen}
          >
            {isFullscreen ? (
              <Minimize className='h-5 w-5' />
            ) : (
              <Maximize className='h-5 w-5' />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
