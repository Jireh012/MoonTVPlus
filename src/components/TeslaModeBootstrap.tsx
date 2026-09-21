'use client';

import { useEffect, useState } from 'react';
import { Car, X } from 'lucide-react';

import {
  applyTeslaDocumentHints,
  getTeslaPassengerMode,
  installTeslaPassengerPatch,
  isTeslaBrowser,
  setTeslaPassengerMode,
} from '@/lib/tesla';

/**
 * 全局引导：识别 Tesla 浏览器、应用样式类、按需安装 pause 补丁。
 */
export function TeslaModeBootstrap() {
  useEffect(() => {
    applyTeslaDocumentHints();
    if (isTeslaBrowser() && getTeslaPassengerMode()) {
      installTeslaPassengerPatch();
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key === 'moontv_tesla_passenger_mode') {
        applyTeslaDocumentHints();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return null;
}

type TeslaPassengerBarProps = {
  className?: string;
};

/**
 * 播放页/直播页顶部提示条：乘客模式开关。
 */
export function TeslaPassengerBar({ className = '' }: TeslaPassengerBarProps) {
  const [visible, setVisible] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const tesla = isTeslaBrowser();
    setVisible(tesla);
    setEnabled(getTeslaPassengerMode());
    applyTeslaDocumentHints();

    const onMode = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (typeof detail?.enabled === 'boolean') {
        setEnabled(detail.enabled);
      } else {
        setEnabled(getTeslaPassengerMode());
      }
    };
    window.addEventListener('moontv:tesla-passenger-mode', onMode);
    return () => window.removeEventListener('moontv:tesla-passenger-mode', onMode);
  }, []);

  if (!visible || dismissed) return null;

  return (
    <div
      className={`tesla-passenger-bar pointer-events-auto fixed left-1/2 top-3 z-[80] flex max-w-[min(92vw,42rem)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-emerald-400/40 bg-black/80 px-4 py-3 text-sm text-white shadow-lg backdrop-blur-md ${className}`}
      role='status'
    >
      <Car className='h-5 w-5 shrink-0 text-emerald-400' />
      <div className='min-w-0 flex-1'>
        <div className='font-semibold'>Tesla 乘客模式 {enabled ? '已开启' : '已关闭'}</div>
        <div className='text-xs text-white/70'>
          D 档画面冻结时将改用画布转码播放（不经 video）。请仅供副驾/后排观看。
        </div>
      </div>
      <button
        type='button'
        className={`shrink-0 rounded-xl px-3 py-2 text-xs font-bold ${
          enabled ? 'bg-emerald-500 text-black' : 'bg-white/15 text-white'
        }`}
        onClick={() => {
          const next = !enabled;
          setTeslaPassengerMode(next);
          setEnabled(next);
        }}
      >
        {enabled ? '关闭' : '开启'}
      </button>
      <button
        type='button'
        aria-label='关闭提示'
        className='shrink-0 rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white'
        onClick={() => setDismissed(true)}
      >
        <X className='h-4 w-4' />
      </button>
    </div>
  );
}
