import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  probeMediaDuration,
  resolveFfprobePath,
  resolveMediaUrl,
} from '@/lib/tesla-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 简单的进程内缓存：同一部影片起播 / 拖动进度时会被反复请求，没必要每次都 ffprobe
const cache = new Map<string, { value: number | null; at: number }>();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 200;

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  if (!resolveFfprobePath()) {
    return NextResponse.json(
      { error: 'ffprobe unavailable' },
      { status: 503 }
    );
  }

  const rawUrl = request.nextUrl.searchParams.get('url');
  if (!rawUrl) {
    return NextResponse.json({ error: 'missing url' }, { status: 400 });
  }

  let inputUrl: string;
  try {
    inputUrl = resolveMediaUrl(rawUrl, request.nextUrl.origin);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'bad url' },
      { status: 400 }
    );
  }

  const cached = cache.get(inputUrl);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return NextResponse.json({ duration: cached.value });
  }

  const duration = await probeMediaDuration(inputUrl);

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(inputUrl, { value: duration, at: Date.now() });

  return NextResponse.json({ duration });
}
