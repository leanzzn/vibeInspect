// VibeInspect 자체 백엔드: 브라우저 → (이 미들웨어) → ChatKHU API Gateway.
// API 키는 이 Node 프로세스의 환경 변수에만 있고, 브라우저로 보내지 않는다.
// 키·Authorization 헤더·요청 본문은 로그에 남기지 않는다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildMessages, parseAskRequest, type AskRequest, type AskResult } from '../src/ai/prompt';
import { buildMapMessages, parseMapRequest, type MapLevel } from '../src/ai/mapGuide';

export const DEFAULT_BASE_URL = 'https://factchat-cloud.mindlogic.ai/v1/gateway';
const TIMEOUT_MS = 60_000;
const MAX_BODY = 64 * 1024;

export interface AiConfig { baseUrl: string; apiKey: string; model: string; mock: boolean }
type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;
type Fail = { ok: false; kind: string; message: string };

export function readConfig(env: Env): AiConfig {
  return {
    baseUrl: (env.CHATKHU_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: env.CHATKHU_API_KEY?.trim() ?? '',
    model: env.CHATKHU_MODEL?.trim() ?? '',
    mock: env.CHATKHU_MOCK === '1',
  };
}

const httpsHost = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.host : null; } catch { return null; } };

/** 설정 상태만 본다(네트워크 요청 없음). */
export function status(cfg: AiConfig) {
  const baseHost = httpsHost(cfg.baseUrl) ?? undefined;
  if (cfg.mock) return { state: 'mock', model: 'mock', baseHost, message: '모의 응답 모드입니다(CHATKHU_MOCK=1). 실제 AI를 부르지 않고 정해진 예시 답변을 돌려줍니다.' } as const;
  if (!baseHost) return { state: 'bad-base-url', message: 'CHATKHU_BASE_URL이 https 주소가 아닙니다. 비워 두면 기본 주소를 씁니다.' } as const;
  if (!cfg.apiKey) return { state: 'no-key', baseHost, message: 'ChatKHU API 키가 설정되지 않았습니다. 프로젝트 폴더의 .env 파일에 CHATKHU_API_KEY를 적고 개발 서버를 다시 시작하세요.' } as const;
  if (!cfg.model) return { state: 'no-model', baseHost, message: '사용할 모델이 설정되지 않았습니다. .env 파일에 CHATKHU_MODEL로 모델 ID를 정확히 적고 개발 서버를 다시 시작하세요.' } as const;
  return { state: 'ready', model: cfg.model, baseHost, message: `설정됨 · 모델 ${cfg.model}` } as const;
}

/** 서버 시작 때 찍는 한 줄. 키 값은 절대 포함하지 않는다. */
export const describeConfig = (cfg: AiConfig) => `[VibeInspect AI] ${status(cfg).message}`;

/** Gateway 오류를 사용자용 안내로 바꾼다. 응답 본문의 메시지는 키를 지우고 짧게 자른다. */
export function classify(code: number, body: unknown, cfg: AiConfig, retryAfter?: string | null): Fail {
  const d = (body as { detail?: unknown } | null)?.detail;
  let detail = typeof d === 'string' ? d : (d as { message?: unknown } | undefined)?.message;
  detail = typeof detail === 'string' ? detail.split(cfg.apiKey || '\u0000').join('[가림]').slice(0, 200) : '';
  const tail = detail ? ` (Gateway 메시지: ${detail})` : '';
  // JSON이 아닌 403 = Gateway 앞단 방화벽이 막은 것(예: Cloudflare Workers에서 보낸 요청). 키·모델 문제가 아니다
  if (code === 403 && body === null) return { ok: false, kind: 'blocked', message: 'ChatKHU 방화벽이 이 서버에서 보낸 요청을 막았습니다. 키·모델 문제가 아닙니다. 로컬(npm run dev)에서는 동작합니다.' };
  const m: Record<number, [string, string]> = {
    400: ['bad-request', '요청이 거절되었습니다. 이 모델이 텍스트 생성용이 아닐 수 있습니다.'],
    401: ['auth', 'API 키 인증에 실패했습니다. 키가 정확한지, 폐기되거나 비활성화되지 않았는지 확인하세요.'],
    402: ['credits', '크레딧이 부족합니다. ChatKHU 개발자 설정에서 잔액을 확인하세요.'],
    403: ['model-access', '이 모델을 쓸 권한이 없습니다. 조직에서 허용되지 않았거나 Gateway API로 제공되지 않는 모델일 수 있습니다.'],
    404: ['not-found', '모델을 찾지 못했습니다. CHATKHU_MODEL의 모델 ID가 정확한지 확인하세요.'],
    413: ['too-large', '요청이 너무 큽니다.'],
    429: ['rate-limit', `요청이 너무 많습니다. ${retryAfter ? `${retryAfter}초 뒤에` : '잠시 뒤에'} 다시 시도하세요.`],
    503: ['unavailable', 'ChatKHU 서비스가 점검 중이거나 일시적으로 사용할 수 없습니다.'],
  };
  const [kind, message] = m[code] ?? (code >= 500 ? ['upstream', 'ChatKHU 쪽 서버 오류입니다. 잠시 뒤에 다시 시도하세요.'] : ['http', `예상하지 못한 응답입니다(HTTP ${code}).`]);
  return { ok: false, kind, message: message + tail };
}

/** Gateway 호출. 주소는 항상 서버 설정(cfg.baseUrl)에서만 만든다. */
async function gateway(cfg: AiConfig, path: string, init: RequestInit, fetchImpl: Fetch, signal?: AbortSignal): Promise<{ ok: true; json: unknown } | Fail> {
  const st = status(cfg);
  if (st.state !== 'ready') return { ok: false, kind: st.state, message: st.message };
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'manual', // 다른 주소로 넘어가며 키가 따라가지 않게 한다(3xx는 오류로 처리됨). Workers는 'error'를 지원하지 않는다
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) return classify(r.status, json, cfg, r.headers.get('retry-after'));
    return { ok: true, json };
  } catch (e) {
    if (timeout.aborted) return { ok: false, kind: 'timeout', message: `${TIMEOUT_MS / 1000}초 안에 응답이 없어 중단했습니다.` };
    if (signal?.aborted) return { ok: false, kind: 'aborted', message: '요청을 취소했습니다.' };
    return { ok: false, kind: 'network', message: `ChatKHU(${httpsHost(cfg.baseUrl)})에 연결하지 못했습니다. 인터넷 연결을 확인하세요.` };
  }
}

/** 연결 확인: 모델 목록만 조회한다. 소스 코드는 보내지 않는다. */
export async function checkConnection(cfg: AiConfig, fetchImpl: Fetch = fetch) {
  if (cfg.mock) return { ok: true, kind: 'mock', message: '모의 응답 모드라 실제 연결은 확인하지 않았습니다.' };
  const r = await gateway(cfg, '/models/?type=llm', { method: 'GET' }, fetchImpl);
  if (!r.ok) return r;
  const ids = ((r.json as { data?: { id?: unknown }[] })?.data ?? []).map((m) => m?.id).filter((x): x is string => typeof x === 'string');
  return ids.includes(cfg.model)
    ? { ok: true, kind: 'listed', message: `키가 인증되었고, 모델 목록(${ids.length}개)에 ${cfg.model}이 있습니다. 실제 답변 생성까지 된다는 뜻은 아닙니다.` }
    : { ok: false, kind: 'not-listed', message: `키는 인증되었지만 모델 목록(${ids.length}개)에 ${cfg.model}이 없습니다. 모델 ID를 확인하세요.` };
}

const pickText = (json: unknown) => {
  const t = (json as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  return typeof t === 'string' && t.trim() ? t : null;
};

/** 짧은 생성 테스트: 고정된 한 문장만 보낸다(소스 코드 없음). 크레딧이 차감될 수 있다. */
export async function ping(cfg: AiConfig, fetchImpl: Fetch = fetch) {
  if (cfg.mock) return { ok: true, kind: 'mock', message: '모의 응답 모드라 실제 생성은 하지 않았습니다.' };
  const r = await gateway(cfg, '/chat/completions/', {
    method: 'POST', body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: '연결 확인입니다. "확인"이라고만 답하세요.' }], stream: false }),
  }, fetchImpl);
  if (!r.ok) return r;
  return pickText(r.json) !== null
    ? { ok: true, kind: 'generated', message: `모델 ${cfg.model}이 답변을 생성했습니다.` }
    : { ok: false, kind: 'bad-response', message: '응답은 왔지만 답변 텍스트(choices[0].message.content)가 없습니다.' };
}

function mockAnswer(req: AskRequest): string {
  const s = req.snippets[0];
  return `## 쉬운 설명
[모의 응답] 실제 AI가 만든 답이 아닙니다. 화면과 근거 확인을 시험하기 위한 고정 문장입니다.
## 코드에서 확인한 내용
- 보낸 첫 코드 조각의 위치입니다. 근거: ${s.file}:${s.startLine}-${s.endLine}
## 추정
없음
## 확인하지 못한 부분
- 보내지 않은 위치의 예시입니다. 근거: ${s.file}:${s.endLine + 1000}`;
}

export const ask = (cfg: AiConfig, req: AskRequest, fetchImpl: Fetch = fetch, signal?: AbortSignal) =>
  generate(cfg, buildMessages(req), () => mockAnswer(req), fetchImpl, signal);

/** 요약 지도: 세부 목록(이름·위치)만 보내고 JSON 답을 받는다. 검사는 브라우저(parseSummary)가 한다. */
export const summarize = (cfg: AiConfig, { outline, level }: { outline: string; level: MapLevel }, fetchImpl: Fetch = fetch, signal?: AbortSignal) =>
  generate(cfg, buildMapMessages(outline, level), () => {
    const n = [...outline.matchAll(/^(n\d+) \|/gm)].slice(0, 3).map((m) => m[1]);
    return JSON.stringify({ cards: n.map((id, i) => ({ id: `c${i}`, title: `[모의 응답] 카드 ${i + 1}`, kind: 'page', summary: '실제 AI가 만든 카드가 아닙니다.', members: [id] })), links: [] });
  }, fetchImpl, signal);

async function generate(cfg: AiConfig, messages: { role: string; content: string }[], mock: () => string, fetchImpl: Fetch, signal?: AbortSignal): Promise<AskResult> {
  if (cfg.mock) return { ok: true, source: 'mock', model: 'mock', text: mock() };
  const r = await gateway(cfg, '/chat/completions/', {
    method: 'POST', body: JSON.stringify({ model: cfg.model, messages, stream: false }),
  }, fetchImpl, signal);
  if (!r.ok) return r;
  const text = pickText(r.json);
  return text === null
    ? { ok: false, kind: 'bad-response', message: '응답은 왔지만 답변 텍스트가 없습니다.' }
    : { ok: true, source: 'chatkhu', model: cfg.model, text };
}

// ── HTTP 미들웨어 (Vite 개발·미리보기 서버에 붙인다) ──
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostname = (host: string) => host.replace(/:\d+$/, '').toLowerCase();

function send(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('too-large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

/**
 * 보호 조치:
 * - Host가 localhost가 아니면 거절 (DNS 리바인딩, 외부 접속 차단)
 * - POST는 Origin이 이 페이지 자신(http://{Host})일 때만 허용, JSON 본문만 허용
 * - CORS 허용 헤더를 절대 보내지 않는다 → 다른 사이트는 응답을 읽을 수 없다
 */
export function createAiMiddleware(cfg: AiConfig, fetchImpl: Fetch = fetch) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/ai/')) return next();
    const route = url.split('?')[0];
    const t0 = Date.now();
    const log = (result: string) => console.info(`[VibeInspect AI] ${req.method} ${route} → ${result} (${Date.now() - t0}ms)`);

    const host = req.headers.host ?? '';
    if (!LOCAL.has(hostname(host))) { log('거절: 로컬 주소 아님'); return send(res, 403, { ok: false, kind: 'forbidden', message: '로컬 주소(localhost)로만 사용할 수 있습니다.' }); }
    if (req.method === 'GET' && route === '/api/ai/status') { const origin = req.headers.origin; if (origin && origin !== `http://${host}`) return send(res, 403, { ok: false, kind: 'forbidden', message: '허용되지 않은 출처입니다.' }); return send(res, 200, status(cfg)); }
    if (req.method !== 'POST') return send(res, 405, { ok: false, kind: 'method', message: '허용되지 않은 요청 방식입니다.' });
    if (req.headers.origin !== `http://${host}`) { log('거절: 출처 불일치'); return send(res, 403, { ok: false, kind: 'forbidden', message: '허용되지 않은 출처입니다. VibeInspect 화면에서만 사용할 수 있습니다.' }); }
    if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { ok: false, kind: 'content-type', message: 'JSON 요청만 받습니다.' });

    let body: unknown;
    try { body = await readBody(req); } catch (e) {
      return send(res, (e as Error).message === 'too-large' ? 413 : 400, { ok: false, kind: 'bad-request', message: '요청 본문을 읽지 못했습니다.' });
    }

    if (route === '/api/ai/check') { const r = await checkConnection(cfg, fetchImpl); log(r.kind); return send(res, 200, r); }
    if (route === '/api/ai/ping') { const r = await ping(cfg, fetchImpl); log(r.kind); return send(res, 200, r); }
    if (route === '/api/ai/ask') {
      // 본문의 알려진 필드만 쓴다. 브라우저가 주소·모델·지침을 바꾸는 필드를 보내도 무시된다.
      const parsed = parseAskRequest(body);
      if (typeof parsed === 'string') { log('거절: 형식'); return send(res, 400, { ok: false, kind: 'bad-request', message: parsed }); }
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      const r = await ask(cfg, parsed, fetchImpl, abort.signal);
      log(r.ok ? r.source : r.kind);
      return send(res, 200, r);
    }
    if (route === '/api/ai/map') {
      const m = parseMapRequest(body);
      if (!m) { log('거절: 형식'); return send(res, 400, { ok: false, kind: 'bad-request', message: '요약할 목록이 비었거나 너무 깁니다.' }); }
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      const r = await summarize(cfg, m, fetchImpl, abort.signal);
      log(r.ok ? r.source : r.kind);
      return send(res, 200, r);
    }
    send(res, 404, { ok: false, kind: 'not-found', message: '없는 경로입니다.' });
  };
}
