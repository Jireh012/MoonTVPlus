const TESLA_PASSENGER_MODE_KEY = 'moontv_tesla_passenger_mode';
const TESLA_PLAYBACK_MODE_KEY = 'moontv_tesla_playback_mode';
const TESLA_FORCE_KEY = 'moontv_force_tesla';

/**
 * 旧车机 UA 带 Tesla / QtCarBrowser。
 * 2026.20 的 Model Y 浏览器不再附带这些字样，只保留未精简的 Chromium 构建号
 * Chrome/140.0.7339.x。桌面 Chrome 在 Linux 上会报 Chrome/140.0.0.0。
 */
const TESLA_BROWSER_UA = /Tesla|QtCarBrowser|TeslaBrowser/i;
const TESLA_CHROMIUM_BUILD_UA =
  /X11;\s*Linux[^)]*\)[\s\S]*Chrome\/140\.0\.7339\.\d+/i;

export type TeslaPlaybackMode = 'mjpeg' | 'compat' | 'webcodecs';

export function isTeslaUserAgent(userAgent: string): boolean {
  return TESLA_BROWSER_UA.test(userAgent) || TESLA_CHROMIUM_BUILD_UA.test(userAgent);
}

let prototypePatched = false;
let originalPause: (() => void) | null = null;

export function isTeslaBrowser(userAgent?: string): boolean {
  if (typeof window !== 'undefined') {
    try {
      if (localStorage.getItem(TESLA_FORCE_KEY) === '1') return true;
      if (new URLSearchParams(window.location.search).get('tesla') === '1') {
        localStorage.setItem(TESLA_FORCE_KEY, '1');
        return true;
      }
    } catch {
      // ignore
    }
  }
  const ua = userAgent || (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  if (!ua) return false;
  return isTeslaUserAgent(ua);
}

export function getTeslaPassengerMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const saved = localStorage.getItem(TESLA_PASSENGER_MODE_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch {
    // ignore
  }
  // 默认：检测到 Tesla 时开启乘客模式
  return isTeslaBrowser();
}

export function isTeslaWebCodecsSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof (window as Window & { VideoDecoder?: unknown }).VideoDecoder === 'function';
}

export function getTeslaPlaybackMode(): TeslaPlaybackMode {
  if (typeof window === 'undefined') return 'mjpeg';
  try {
    const saved = localStorage.getItem(TESLA_PLAYBACK_MODE_KEY);
    if (saved === 'mjpeg') return 'mjpeg';
    if (saved === 'webcodecs' && isTeslaWebCodecsSupported()) return 'webcodecs';
    if (saved === 'compat') return 'compat';
  } catch {
    // ignore
  }
  // 默认极简 MJPEG：<img> 收 JPEG 帧流，不依赖 JS 定时器，D 档最抗冻结
  return 'mjpeg';
}

export function setTeslaPlaybackMode(mode: TeslaPlaybackMode): void {
  if (typeof window === 'undefined') return;
  const next: TeslaPlaybackMode =
    mode === 'webcodecs' && !isTeslaWebCodecsSupported() ? 'mjpeg' : mode;
  try {
    localStorage.setItem(TESLA_PLAYBACK_MODE_KEY, next);
  } catch {
    // ignore
  }
  window.dispatchEvent(
    new CustomEvent('moontv:tesla-playback-mode', { detail: { mode: next } })
  );
}

export function setTeslaPassengerMode(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(TESLA_PASSENGER_MODE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
  applyTeslaDocumentHints();
  if (enabled) {
    installTeslaPassengerPatch();
  }
  window.dispatchEvent(
    new CustomEvent('moontv:tesla-passenger-mode', { detail: { enabled } })
  );
}

export function applyTeslaDocumentHints(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const tesla = isTeslaBrowser();
  const passenger = getTeslaPassengerMode();
  root.classList.toggle('tesla-browser', tesla);
  root.classList.toggle('tesla-passenger-mode', tesla && passenger);
  root.dataset.tesla = tesla ? '1' : '0';
  root.dataset.teslaPassenger = passenger ? '1' : '0';
}

export function markUserInitiatedMediaPause(media?: HTMLMediaElement | null): void {
  if (!media) return;
  (media as any).__moontvUserPause = true;
  window.setTimeout(() => {
    (media as any).__moontvUserPause = false;
  }, 800);
}

/**
 * 拦截系统级 pause（D 档常见），乘客主动暂停仍可通过 markUserInitiatedMediaPause 放行。
 */
export function installTeslaPassengerPatch(): void {
  if (typeof HTMLMediaElement === 'undefined' || prototypePatched) return;
  originalPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function patchedPause(this: HTMLMediaElement) {
    const allowUserPause = !!(this as any).__moontvUserPause;
    if (getTeslaPassengerMode() && !allowUserPause) {
      // Tesla D 档会强制 pause；忽略后立刻恢复
      const resume = () => {
        const playResult = this.play?.();
        if (playResult && typeof (playResult as Promise<void>).catch === 'function') {
          (playResult as Promise<void>).catch(() => undefined);
        }
      };
      resume();
      window.setTimeout(resume, 50);
      window.setTimeout(resume, 250);
      return;
    }
    return originalPause?.call(this);
  };
  prototypePatched = true;
}

export function uninstallTeslaPassengerPatch(): void {
  if (!prototypePatched || !originalPause) return;
  HTMLMediaElement.prototype.pause = originalPause;
  prototypePatched = false;
  originalPause = null;
}

export type TeslaPlayerGuard = {
  destroy: () => void;
};

/**
 * 绑定到 Artplayer / HTMLVideoElement：心跳续播、忽略可见性导致的暂停。
 */
export function attachTeslaPassengerGuard(
  artOrVideo: any,
  options?: { preferWebFullscreen?: boolean }
): TeslaPlayerGuard {
  const video: HTMLVideoElement | null =
    artOrVideo?.video instanceof HTMLVideoElement
      ? artOrVideo.video
      : artOrVideo instanceof HTMLVideoElement
        ? artOrVideo
        : null;

  if (!video) {
    return { destroy: () => undefined };
  }

  applyTeslaDocumentHints();
  if (getTeslaPassengerMode()) {
    installTeslaPassengerPatch();
  }

  let destroyed = false;
  let heartbeat: number | null = null;
  let wakeLock: { release?: () => Promise<void>; addEventListener?: (type: string, listener: () => void) => void } | null =
    null;

  const tryPlay = () => {
    if (destroyed || !getTeslaPassengerMode()) return;
    if ((video as any).__moontvUserPause) return;
    if (!video.paused) return;
    video.play()?.catch(() => undefined);
  };

  const onPause = () => {
    if (!getTeslaPassengerMode() || (video as any).__moontvUserPause) return;
    tryPlay();
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      tryPlay();
      void requestWakeLock();
    }
  };

  const requestWakeLock = async () => {
    try {
      if (!('wakeLock' in navigator)) return;
      wakeLock = await (navigator as any).wakeLock.request('screen');
      wakeLock?.addEventListener?.('release', () => {
        wakeLock = null;
      });
    } catch {
      // 车机可能不支持
    }
  };

  video.addEventListener('pause', onPause);
  document.addEventListener('visibilitychange', onVisibility);

  // Artplayer：用户点暂停时打标，避免被乘客模式立刻恢复
  if (artOrVideo && typeof artOrVideo.on === 'function') {
    const wrapControl = (fnName: 'pause' | 'toggle') => {
      if (typeof artOrVideo[fnName] !== 'function') return;
      const original = artOrVideo[fnName].bind(artOrVideo);
      artOrVideo[fnName] = (...args: any[]) => {
        if (fnName === 'pause' || (fnName === 'toggle' && !video.paused)) {
          markUserInitiatedMediaPause(video);
        }
        return original(...args);
      };
    };
    wrapControl('pause');
    wrapControl('toggle');
  }

  heartbeat = window.setInterval(() => {
    if (!getTeslaPassengerMode()) return;
    tryPlay();
  }, 1000);

  void requestWakeLock();

  if (options?.preferWebFullscreen && artOrVideo?.fullscreenWeb === false) {
    try {
      artOrVideo.fullscreenWeb = true;
    } catch {
      // ignore
    }
  }

  // 车机性能：关闭远程投放、保持 inline
  video.setAttribute('playsinline', 'true');
  video.setAttribute('webkit-playsinline', 'true');
  video.disableRemotePlayback = true;

  return {
    destroy: () => {
      destroyed = true;
      video.removeEventListener('pause', onPause);
      document.removeEventListener('visibilitychange', onVisibility);
      if (heartbeat != null) {
        window.clearInterval(heartbeat);
        heartbeat = null;
      }
      void wakeLock?.release?.().catch?.(() => undefined);
      wakeLock = null;
    },
  };
}

export function shouldPreferTeslaCanvasPlayback(): boolean {
  return isTeslaBrowser() && getTeslaPassengerMode();
}

export async function fetchTeslaCanvasAvailability(): Promise<boolean> {
  // 高清 WebCodecs 模式直接解 HLS 原流，不依赖服务端 ffmpeg，
  // 同样能绕过 D 档对 <video> 的画面冻结。
  if (getTeslaPlaybackMode() === 'webcodecs' && isTeslaWebCodecsSupported()) {
    return true;
  }
  try {
    const response = await fetch('/api/tesla/status', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const data = await response.json();
    return Boolean(data?.canvasPlayback);
  } catch {
    return false;
  }
}
