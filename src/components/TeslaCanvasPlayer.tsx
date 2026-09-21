'use client';

import { Loader2, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getTeslaPlaybackMode, type TeslaPlaybackMode } from '@/lib/tesla';
import { startTeslaWebCodecs } from '@/lib/tesla-webcodecs';

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
  const [playbackMode, setPlaybackMode] = useState<TeslaPlaybackMode>(() =>
    getTeslaPlaybackMode()
  );

  useEffect(() => {
    setPlaybackMode(getTeslaPlaybackMode());
    const onMode = (event: Event) => {
      const mode = (event as CustomEvent).detail?.mode;
      setPlaybackMode(mode === 'webcodecs' ? 'webcodecs' : 'compat');
    };
    window.addEventListener('moontv:tesla-playback-mode', onMode);
    return () => window.removeEventListener('moontv:tesla-playback-mode', onMode);
  }, []);

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
    // JSMpeg 兼容模式的渲染循环定时器（见 start 内的接管逻辑）
    let jsmpegLoopTimer: number | null = null;
    const stopJsmpegLoop = () => {
      if (jsmpegLoopTimer != null) {
        window.clearInterval(jsmpegLoopTimer);
        jsmpegLoopTimer = null;
      }
    };

    const start = async () => {
      cleanup();
      setLoading(true);
      setError('');
      setPlaying(true);

      if (!src || !canvasRef.current) return;

      try {
        const audioApi = `/api/tesla/audio?url=${encodeURIComponent(src)}`;
        const audio = audioRef.current;
        if (playbackMode === 'webcodecs' && audio) {
          audio.src = audioApi;
          audio.muted = muted;
        }

        if (playbackMode === 'webcodecs') {
          const player = startTeslaWebCodecs({
            src,
            canvas: canvasRef.current,
            audio: audioRef.current,
            onStarted: () => {
              if (!cancelled) setLoading(false);
            },
            onError: (err) => {
              if (!cancelled) {
                setError(err.message);
                setLoading(false);
                onError?.(err.message);
              }
            },
          });
          playerRef.current = player;
          return;
        }

        const JSMpeg = await loadJSMpeg();
        if (cancelled || !canvasRef.current) return;

        const FetchStreamSource = createFetchStreamSource(JSMpeg);
        const videoApi = `/api/tesla/mpegts?url=${encodeURIComponent(src)}`;

        const player = new JSMpeg.Player(videoApi, {
          canvas: canvasRef.current,
          audio: true,
          streaming: true,
          pauseWhenHidden: false,
          maxAudioLag: 1,
          videoBufferSize: 1024 * 1024 * 2,
          audioBufferSize: 128 * 1024,
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
        // 直播默认每个刷新都解一帧，画面会快于声音。音频只留约 0.3 秒缓冲，画面追上播放位置后就停。
        player.updateForStreaming = function updateForStreamingSynced(this: any) {
          const audio = this.audio;
          const audioOut = this.audioOut;
          const video = this.video;
          if (audio && audioOut) {
            let packets = 0;
            while (audioOut.enqueuedTime < 0.3 && packets < 8) {
              if (!audio.decode()) break;
              packets += 1;
            }
          }
          if (video && audio?.canPlay) {
            const audioTime = audio.currentTime || 0;
            let frames = 0;
            while (video.currentTime <= audioTime + 0.05 && frames < 4) {
              if (!video.decode()) break;
              frames += 1;
            }
            return;
          }
          video?.decode?.();
        };
        try {
          player.audioOut?.unlock?.();
        } catch {
          // ignore
        }
        player.volume = muted ? 0 : 1;

        // 关键修复：Tesla D 档会冻结页面的 requestAnimationFrame。
        // JSMpeg 的渲染循环用 rAF 重排自己（play → rAF(update)，update 每帧再排 rAF），
        // 冻结后 update 停摆，画布永远停在最后一帧（音频走 WebAudio 所以还在响）。
        // 这里接管为 setInterval 驱动，绕过 rAF。
        stopJsmpegLoop();
        const cancelPendingRaf = () => {
          if (player.animationId) {
            try {
              window.cancelAnimationFrame(player.animationId);
            } catch {
              // ignore
            }
            player.animationId = null;
          }
        };
        const originalUpdate = player.update.bind(player);
        player.update = () => {
          // 屏蔽 update 内部对 requestAnimationFrame 的重排
          const raf = window.requestAnimationFrame;
          const caf = window.cancelAnimationFrame;
          (window as any).requestAnimationFrame = () => 0;
          (window as any).cancelAnimationFrame = () => undefined;
          try {
            originalUpdate();
          } finally {
            window.requestAnimationFrame = raf;
            window.cancelAnimationFrame = caf;
          }
        };
        const originalPlay = player.play.bind(player);
        player.play = () => {
          player.animationId = null; // 避免 play 因残留 animationId 提前返回
          originalPlay();
          cancelPendingRaf(); // originalPlay 会再排一个（可能被冻结的）rAF，撤掉
          if (jsmpegLoopTimer == null) {
            jsmpegLoopTimer = window.setInterval(() => {
              if (player.paused || !player.wantsToPlay) return;
              try {
                player.update();
              } catch {
                // ignore
              }
            }, 16);
          }
        };
        const originalPause = player.pause.bind(player);
        player.pause = () => {
          originalPause();
          cancelPendingRaf();
          stopJsmpegLoop();
        };
        // streaming 模式下构造函数会自动 play()，先撤掉那个 rAF 并启动 setInterval 循环
        cancelPendingRaf();
        player.play();
        playerRef.current = player;

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
      stopJsmpegLoop();
      cleanup();
    };
    // muted 不重拉流，仅在按钮里改 audio.muted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, cleanup, onError, playbackMode]);

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
    const player = playerRef.current;
    if (playbackMode === 'compat' && player) {
      try {
        player.volume = next ? 0 : 1;
      } catch {
        // ignore
      }
      return;
    }
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
        key={playbackMode}
        ref={canvasRef}
        className='h-full w-full object-contain'
        width={960}
        height={544}
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
              <span>
                {playbackMode === 'webcodecs'
                  ? '正在用 WebCodecs 解码原画…'
                  : '正在转码为 Tesla 可用画面…'}
              </span>
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
              {isLive ? '直播' : '点播'} · {playbackMode === 'webcodecs' ? '高清 WebCodecs' : '兼容转码'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
