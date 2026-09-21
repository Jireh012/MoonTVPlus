import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  isSafeMediaUrl,
  resolveMediaUrl,
  rewritePlaylistThroughProxy,
} from '@/lib/tesla-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UPSTREAM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: '*/*',
};

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const rawUrl = request.nextUrl.searchParams.get('url');
  if (!rawUrl || !isSafeMediaUrl(rawUrl)) {
    return NextResponse.json({ error: 'missing url' }, { status: 400 });
  }

  try {
    const target = resolveMediaUrl(rawUrl, request.nextUrl.origin);
    const upstream = await fetch(target, {
      headers: UPSTREAM_HEADERS,
      redirect: 'follow',
      signal: request.signal,
      cache: 'no-store',
    });
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `upstream ${upstream.status}` },
        { status: upstream.status }
      );
    }

    const contentType = upstream.headers.get('content-type') || '';
    const looksLikePlaylist =
      /mpegurl|m3u8/i.test(contentType) ||
      /\.m3u8?(\?|$)/i.test(target);

    if (looksLikePlaylist) {
      const text = await upstream.text();
      if (!text.includes('#EXTM3U')) {
        return new NextResponse(text, {
          headers: {
            'Content-Type': contentType || 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-store',
          },
        });
      }
      const rewritten = rewritePlaylistThroughProxy(text, upstream.url || target);
      return new NextResponse(rewritten, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response(upstream.body, {
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[tesla/proxy]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'proxy failed' },
      { status: 502 }
    );
  }
}
