'use client';

import { Loader2, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    JSMpeg?: any;
  }
}

type TeslaCanvasPlayerProps = {
  src: string;
  title?: string;
  isLive?: boolean;
  poster?: string;
  className?: string;
  onError?: (message: string) => void;
};

let jsmpegLoader: Promise<any> | null = null;

function loadJSMpeg(): Promise<any> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('window unavailable'));
  }
  if (window.JSMpeg?.Player) {
    return Promise.resolve(window.JSMpeg);
  }
  if (!jsmpegLoader) {
    jsmpegLoader = new Promise((resolve, reject) => {
      const existing = document.querySelector(
        'script[data-moontv-jsmpeg="1"]'
      ) as HTMLScriptElement | null;
      if (existing) {
        existing.addEventListener('load', () => resolve(window.JSMpeg));
        existing.addEventListener('error', () =>
          reject(new Error('JSMpeg 加载失败'))
        );
        return;
      }
      const script = document.createElement('script');
      script.src = '/vendor/jsmpeg.min.js';
      script.async = true;
      script.dataset.moontvJsmpeg = '1';
      script.onload = () => resolve(window.JSMpeg);
      script.onerror = () => reject(new Error('JSMpeg 加载失败'));
      document.head.appendChild(script);
    });
  }
  return jsmpegLoader;
}

/**
 * Fetch 流式 Source：把 /api/tesla/mpegts 的 chunk 喂给 JSMpeg demuxer。
 * 不经过 <video>，可绕过 Tesla D 档对 video 画面的系统冻结。
 */
function createFetchStreamSource(JSMpeg: any) {
  return class FetchStreamSource {
    url: string;
    options: any;
    destination: any = null;
    streaming = true;
    established = false;
    completed = false;
    progress = 0;
    private abort: AbortController | null = null;

    constructor(url: string, options: any = {}) {
      this.url = url;
      this.options = options;
    }

    connect(destination: any) {
      this.destination = destination;
      void this.start();
    }

    async start() {
      this.abort = new AbortController();
      try {
        const response = await fetch(this.url, {
          signal: this.abort.signal,
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok || !response.body) {
          throw new Error(`视频流转码失败 (${response.status})`);
        }
        this.established = true;
        this.options.onSourceEstablished?.(this);
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.length) {
            this.destination.write(value);
          }
        }
        this.completed = true;
        this.options.onSourceCompleted?.(this);
      } catch (error: any) {
        if (error?.name === 'AbortError') return;
        console.error('[TeslaCanvasPlayer] source error', error);
        this.options.onSourceError?.(error);
      }
    }

    destroy() {
      this.abort?.abort();
      this.abort = null;
      this.destination = null;
    }

    startStreaming?() {
      // JSMpeg 兼容钩子
    }
  };
}

export default function TeslaCanvasPlayer({
  src,
  title,
  isLive = false,
  poster,
  className = '',
  onError,
}: TeslaCanvasPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playerRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');

  const cleanup = useCallback(() => {
    try {
      playerRef.current?.destroy?.();
    } catch {
      // ignore
    }
    playerRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      cleanup();
      setLoading(true);
      setError('');
      setPlaying(true);

      if (!src || !canvasRef.current) return;

      try {
        const JSMpeg = await loadJSMpeg();
        if (cancelled || !canvasRef.current) return;

        const FetchStreamSource = createFetchStreamSource(JSMpeg);
        const videoApi = `/api/tesla/mpegts?url=${encodeURIComponent(src)}`;
        const audioApi = `/api/tesla/audio?url=${encodeURIComponent(src)}`;

        const player = new JSMpeg.Player(videoApi, {
          canvas: canvasRef.current,
          audio: false,
          streaming: true,
          throttled: false,
          disableGl: false,
          videoBufferSize: 1024 * 1024 * 3,
          source: FetchStreamSource,
          onSourceEstablished: () => {
            if (!cancelled) setLoading(false);
          },
          onSourceError: (err: any) => {
            const message =
              err instanceof Error ? err.message : 'Tesla 画布视频流失败';
            if (!cancelled) {
              setError(message);
              setLoading(false);
              onError?.(message);
            }
          },
        });
        playerRef.current = player;

        const audio = audioRef.current;
        if (audio) {
          audio.src = audioApi;
          audio.muted = muted;
          // 音频通常比画面多缓冲几秒，略微延迟启动减轻不同步
          window.setTimeout(() => {
            if (cancelled) return;
            audio.play().catch(() => undefined);
          }, 1800);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : '初始化 Tesla 画布播放失败';
        if (!cancelled) {
          setError(message);
          setLoading(false);
          onError?.(message);
        }
      }
    };

    void start();
    return () => {
      cancelled = true;
      cleanup();
    };
    // muted 不重拉流，仅在按钮里改 audio.muted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, cleanup, onError]);

  const togglePlay = () => {
    const player = playerRef.current;
    const audio = audioRef.current;
    if (!player) return;

    if (playing) {
      try {
        player.pause?.();
      } catch {
        // ignore
      }
      audio?.pause();
      setPlaying(false);
    } else {
      try {
        player.play?.();
      } catch {
        // ignore
      }
      audio?.play()?.catch(() => undefined);
      setPlaying(true);
    }
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    const next = !muted;
    setMuted(next);
    if (audio) audio.muted = next;
  };

  return (
    <div
      className={`relative flex h-full w-full flex-col overflow-hidden rounded-xl bg-black ${className}`}
    >
      {poster && loading && (
        <div
          className='absolute inset-0 bg-cover bg-center opacity-40'
          style={{ backgroundImage: `url(${poster})` }}
        />
      )}
      <canvas
        ref={canvasRef}
        className='h-full w-full object-contain'
        width={960}
        height={540}
      />
      <audio ref={audioRef} preload='auto' playsInline />

      {(loading || error) && (
        <div className='absolute inset-0 z-10 flex items-center justify-center bg-black/70 px-6 text-center'>
          {error ? (
            <div className='space-y-2 text-white'>
              <p className='text-lg font-semibold'>画布播放失败</p>
              <p className='text-sm text-white/70'>{error}</p>
            </div>
          ) : (
            <div className='flex items-center gap-3 text-white'>
              <Loader2 className='h-6 w-6 animate-spin text-emerald-400' />
              <span>正在转码为 Tesla 可用画面…</span>
            </div>
          )}
        </div>
      )}

      <div className='pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 to-transparent p-4'>
        <div className='pointer-events-auto flex items-center gap-3'>
          <button
            type='button'
            onClick={togglePlay}
            className='flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur'
            aria-label={playing ? '暂停' : '播放'}
          >
            {playing ? <Pause className='h-6 w-6' /> : <Play className='h-6 w-6' />}
          </button>
          <button
            type='button'
            onClick={toggleMute}
            className='flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur'
            aria-label={muted ? '取消静音' : '静音'}
          >
            {muted ? <VolumeX className='h-6 w-6' /> : <Volume2 className='h-6 w-6' />}
          </button>
          <div className='min-w-0 flex-1'>
            <div className='truncate text-sm font-medium text-white'>
              {title || 'Tesla 乘客画布播放'}
            </div>
            <div className='text-xs text-emerald-300/90'>
              {isLive ? '直播' : '点播'} · 系统冻结 video 时仍可看画面
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
