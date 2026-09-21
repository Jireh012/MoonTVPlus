import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { resolveFfmpegPath } from '@/lib/tesla-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const ffmpeg = resolveFfmpegPath();
  return NextResponse.json({
    ok: true,
    ffmpeg: Boolean(ffmpeg),
    canvasPlayback: Boolean(ffmpeg),
  });
}
