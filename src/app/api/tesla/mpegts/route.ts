import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  createFfmpegReadableStream,
  resolveFfmpegPath,
  resolveMediaUrl,
} from '@/lib/tesla-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  if (!resolveFfmpegPath()) {
    return NextResponse.json(
      { error: 'ffmpeg unavailable' },
      { status: 503 }
    );
  }

  const rawUrl = request.nextUrl.searchParams.get('url');
  if (!rawUrl) {
    return NextResponse.json({ error: 'missing url' }, { status: 400 });
  }

  try {
    const inputUrl = resolveMediaUrl(rawUrl, request.nextUrl.origin);
    const stream = createFfmpegReadableStream(
      'mpegts',
      inputUrl,
      request.signal
    );

    return new Response(stream, {
      headers: {
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    console.error('[tesla/mpegts]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'stream failed' },
      { status: 400 }
    );
  }
}
