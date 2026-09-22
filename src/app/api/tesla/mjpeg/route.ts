import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  createFfmpegReadableStream,
  createMjpegMultipartStream,
  parseQuality,
  parseStartSeconds,
  resolveFfmpegPath,
  resolveMediaUrl,
} from '@/lib/tesla-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// MJPEG 长连接，等首帧需要时间
export const maxDuration = 3600;

/**
 * Tesla 极简兜底模式：ffmpeg 转 JPEG 帧 + multipart/x-mixed-replace。
 * 车机端用 <img> 直接收流，零 JS 定时器参与，是 D 档下最抗冻结的渲染路径。
 */
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
    const jpegStream = createFfmpegReadableStream(
      'mjpeg',
      inputUrl,
      request.signal,
      parseStartSeconds(request.nextUrl.searchParams.get('start')),
      parseQuality(request.nextUrl.searchParams.get('q'))
    );
    const stream = jpegStream.pipeThrough(createMjpegMultipartStream());

    return new Response(stream, {
      headers: {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    console.error('[tesla/mjpeg]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'stream failed' },
      { status: 400 }
    );
  }
}
