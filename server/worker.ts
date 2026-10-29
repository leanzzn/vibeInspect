// Cloudflare Worker 배포용: 화면 파일(dist)은 ASSETS가 주고, /api/ai/* 만 여기서 처리한다.
// 로컬 미들웨어(ai.ts의 createAiMiddleware)와 같은 함수를 쓴다. 키는 Worker secret에만 있다.
// 주의: 공개 주소라 주소를 아는 누구나 이 키의 크레딧으로 AI를 부를 수 있다(사용자 결정, 프로젝트 종료 후 키 제거 예정).
import { ask, checkConnection, ping, readConfig, status, summarize } from './ai';
import { parseAskRequest } from '../src/ai/prompt';
import { parseMapRequest } from '../src/ai/mapGuide';

interface Env { ASSETS: { fetch: typeof fetch }; [k: string]: unknown }

const json = (body: unknown, code = 200) => Response.json(body, { status: code, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/ai/')) return env.ASSETS.fetch(req);
    const cfg = readConfig(env as Record<string, string | undefined>);
    const origin = req.headers.get('origin');
    if (req.method === 'GET' && url.pathname === '/api/ai/status') return origin && origin !== url.origin ? json({ ok: false, kind: 'forbidden', message: '허용되지 않은 출처입니다.' }, 403) : json(status(cfg));
    if (req.method !== 'POST') return json({ ok: false, kind: 'method', message: '허용되지 않은 요청 방식입니다.' }, 405);
    if (origin !== url.origin) return json({ ok: false, kind: 'forbidden', message: '허용되지 않은 출처입니다. VibeInspect 화면에서만 사용할 수 있습니다.' }, 403);
    if (!req.headers.get('content-type')?.startsWith('application/json')) return json({ ok: false, kind: 'content-type', message: 'JSON 요청만 받습니다.' }, 415);
    const text = await req.text();
    if (text.length > 64 * 1024) return json({ ok: false, kind: 'bad-request', message: '요청 본문을 읽지 못했습니다.' }, 413);
    let body: unknown;
    try { body = JSON.parse(text || 'null'); } catch { return json({ ok: false, kind: 'bad-request', message: '요청 본문을 읽지 못했습니다.' }, 400); }

    if (url.pathname === '/api/ai/check') return json(await checkConnection(cfg));
    if (url.pathname === '/api/ai/ping') return json(await ping(cfg));
    if (url.pathname === '/api/ai/ask') {
      const parsed = parseAskRequest(body);
      return typeof parsed === 'string' ? json({ ok: false, kind: 'bad-request', message: parsed }, 400) : json(await ask(cfg, parsed, fetch, req.signal));
    }
    if (url.pathname === '/api/ai/map') {
      const outline = parseMapRequest(body);
      return outline ? json(await summarize(cfg, outline, fetch, req.signal)) : json({ ok: false, kind: 'bad-request', message: '요약할 목록이 비었거나 너무 깁니다.' }, 400);
    }
    return json({ ok: false, kind: 'not-found', message: '없는 경로입니다.' }, 404);
  },
};
