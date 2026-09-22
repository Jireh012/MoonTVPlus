import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  extractUpstreamPlaylistUrl,
  fetchHlsDuration,
  probeMediaDuration,
  resolveMediaUrl,
} from '@/lib/tesla-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 简单的进程内缓存：同一部影片起播 / 拖动进度时会被反复请求，没必要每次都探测
const cache = new Map<string, { value: number | null; at: number }>();
const CACHE_TTL = 10 * 60 * 1000;
// 探测失败只短缓存：片源抖动/慢 CDN 恢复后，前端重试应该能拿到真实时长
const FAILURE_TTL = 15 * 1000;
const CACHE_MAX = 200;

function remember(key: string, value: number | null) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, at: Date.now() });
}

/**
 * 依次尝试多个探测地址，任一成功即返回。
 * 先拆掉站内代理包装（去广告开关打开时源会被包成 /api/proxy-m3u8?url=...），
 * 那个包装对"求总时长"没有帮助，却要多走一趟 Next 路由——实测直连 4.8s vs 包装后 50s。
 */
async function detectDuration(targets: string[]): Promise<number | null> {
  for (const target of targets) {
    const fromPlaylist = await fetchHlsDuration(target);
    if (fromPlaylist && fromPlaylist > 0) return fromPlaylist;
  }
  for (const target of targets) {
    const fromProbe = await probeMediaDuration(target);
    if (fromProbe && fromProbe > 0) return fromProbe;
  }
  return null;
}

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const rawUrl = request.nextUrl.searchParams.get('url');
  if (!rawUrl) {
    return NextResponse.json({ error: 'missing url' }, { status: 400 });
  }

  let resolved: string;
  try {
    resolved = resolveMediaUrl(rawUrl, request.nextUrl.origin);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'bad url' },
      { status: 400 }
    );
  }

  // 上游真实地址优先；拿不到就退回原地址（原地址也可能本来就是上游）
  const upstream = extractUpstreamPlaylistUrl(resolved);
  const targets = upstream ? [upstream, resolved] : [resolved];
  const cacheKey = targets[0];

  const cached = cache.get(cacheKey);
  if (cached) {
    const ttl = cached.value === null ? FAILURE_TTL : CACHE_TTL;
    if (Date.now() - cached.at < ttl) {
      return NextResponse.json({ duration: cached.value });
    }
  }

  let duration: number | null = null;
  try {
    duration = await detectDuration(targets);
  } catch (error) {
    console.error('[tesla/duration]', error);
    duration = null;
  }

  remember(cacheKey, duration);

  return NextResponse.json({ duration });
}
