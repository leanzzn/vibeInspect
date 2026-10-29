import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ask, checkConnection, createAiMiddleware, DEFAULT_BASE_URL, readConfig, status } from '../server/ai';
import { buildMessages, parseAskRequest, requestKey, type AskRequest } from './ai/prompt';
import { checkCitations, parseAnswer, prepareSnippets, redact, relatedLocations, sendAsk } from './ai/context';
import type { CodeLocation } from './model';

const KEY = 'test-canary-key-0000';
const ready = readConfig({ CHATKHU_API_KEY: KEY, CHATKHU_MODEL: 'some-model' });
const loc = (file: string, s: number, e: number, anchor: string): CodeLocation => ({ file, startLine: s, endLine: e, label: 'x', anchor });

const FILES: Record<string, string> = {
  'src/a.ts': Array.from({ length: 40 }, (_, i) => (i === 19 ? 'export function target() { return 1; }' : `const line${i + 1} = ${i + 1};`)).join('\n'),
  'src/other.ts': 'export const unrelated = "보내면 안 됨";',
  'src/config.ts': 'const apiKey = "abcd1234efgh";\nconst token = \'sk-ABCDEFGHIJKLMNOPQRSTUV\';\nconst auth = { headers: { Authorization: "Bearer abc.def.ghijklmnop" } };\nconst mail = "student@khu.ac.kr";\nconst ok = "평범한 값";',
  '.env': 'CHATKHU_API_KEY=real',
};

function okFetch(json: unknown, code = 200) {
  return vi.fn(async () => new Response(JSON.stringify(json), { status: code, headers: { 'Content-Type': 'application/json' } }));
}

describe('설정 상태', () => {
  it('API 키가 없으면 no-key, 모델이 없으면 no-model', () => {
    expect(status(readConfig({})).state).toBe('no-key');
    expect(status(readConfig({ CHATKHU_API_KEY: KEY })).state).toBe('no-model');
    expect(status(ready).state).toBe('ready');
    expect(readConfig({}).baseUrl).toBe(DEFAULT_BASE_URL);
  });
  it('https가 아닌 Base URL은 쓰지 않는다', () => {
    expect(status(readConfig({ CHATKHU_BASE_URL: 'http://evil.example', CHATKHU_API_KEY: KEY, CHATKHU_MODEL: 'm' })).state).toBe('bad-base-url');
  });
  it('상태 메시지에 키 값이 들어가지 않는다', () => {
    expect(JSON.stringify(status(ready))).not.toContain(KEY);
  });
  it('키·모델이 없으면 Gateway를 호출하지 않는다', async () => {
    const f = okFetch({});
    const r = await ask(readConfig({}), { target: 't', question: 'q', snippets: [{ file: 'a.ts', startLine: 1, endLine: 1, code: 'x' }] }, f);
    expect(r).toMatchObject({ ok: false, kind: 'no-key' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('Gateway 호출', () => {
  const req: AskRequest = { target: 't', question: 'q', snippets: [{ file: 'src/a.ts', startLine: 18, endLine: 22, code: 'a\nb\nc\nd\ne' }] };
  it('설정한 Base URL과 모델로 chat/completions/를 부르고 choices[0].message.content를 쓴다', async () => {
    const f = okFetch({ choices: [{ message: { content: '## 쉬운 설명\n안녕' } }] });
    const r = await ask(ready, req, f);
    expect(r).toEqual({ ok: true, source: 'chatkhu', model: 'some-model', text: '## 쉬운 설명\n안녕' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_BASE_URL}/chat/completions/`);
    expect(JSON.parse(init.body as string)).toEqual({ model: 'some-model', messages: buildMessages(req), stream: false });
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });
  it.each([[401, 'auth'], [402, 'credits'], [403, 'model-access'], [404, 'not-found'], [429, 'rate-limit'], [500, 'upstream']])('HTTP %i → %s, 키는 메시지에 없다', async (code, kind) => {
    const r = await ask(ready, req, okFetch({ detail: { code: 1, message: `bad key ${KEY}` } }, code));
    expect(r).toMatchObject({ ok: false, kind });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
  it('네트워크 실패도 예외 없이 결과로 돌려준다', async () => {
    const r = await ask(ready, req, vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(r).toMatchObject({ ok: false, kind: 'network' });
  });
  it('응답에 답변 텍스트가 없으면 bad-response', async () => {
    expect(await ask(ready, req, okFetch({ choices: [] }))).toMatchObject({ ok: false, kind: 'bad-response' });
  });
  it('연결 확인은 모델 목록만 조회하고 코드를 보내지 않는다', async () => {
    const f = okFetch({ data: [{ id: 'some-model' }, { id: 'other' }] });
    expect(await checkConnection(ready, f)).toMatchObject({ ok: true, kind: 'listed' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_BASE_URL}/models/?type=llm`);
    expect(init.body).toBeUndefined();
    expect(await checkConnection(ready, okFetch({ data: [{ id: 'other' }] }))).toMatchObject({ ok: false, kind: 'not-listed' });
  });
  it('모의 응답은 source=mock 이고 Gateway를 부르지 않는다. 실제 응답은 source=chatkhu', async () => {
    const f = okFetch({ choices: [{ message: { content: 'x' } }] });
    const mock = await ask(readConfig({ CHATKHU_MOCK: '1' }), req, f);
    expect(mock).toMatchObject({ ok: true, source: 'mock' });
    expect(f).not.toHaveBeenCalled();
    expect(await ask(ready, req, f)).toMatchObject({ ok: true, source: 'chatkhu' });
  });
});

// ── 미들웨어: 가짜 요청/응답 ──
async function hit(mw: ReturnType<typeof createAiMiddleware>, opts: { method?: string; url: string; headers?: Record<string, string>; body?: unknown }) {
  const req = Readable.from(opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]) as unknown as IncomingMessage;
  Object.assign(req, { method: opts.method ?? 'POST', url: opts.url, headers: { host: 'localhost:5180', ...opts.headers } });
  let code = 0, out = '';
  const r = { statusCode: 0, writableEnded: false, setHeader() {}, on() {}, end(s: string) { code = r.statusCode; out = s; r.writableEnded = true; } };
  const res = r as unknown as ServerResponse;
  let nexted = false;
  await mw(req, res, () => { nexted = true; });
  return { code, json: out ? JSON.parse(out) : null, nexted };
}

describe('서버 보호 조치', () => {
  const self = { origin: 'http://localhost:5180', 'content-type': 'application/json' };
  const body = { target: 't', question: 'q', snippets: [{ file: 'src/a.ts', startLine: 1, endLine: 1, code: 'x' }] };

  it('다른 사이트(Origin)에서 온 POST는 Gateway를 부르지 않고 거절한다', async () => {
    const f = okFetch({});
    const mw = createAiMiddleware(ready, f);
    for (const origin of ['https://evil.example', 'http://localhost:5173', 'null']) {
      expect((await hit(mw, { url: '/api/ai/ask', headers: { ...self, origin }, body })).code).toBe(403);
    }
    expect((await hit(mw, { url: '/api/ai/ask', headers: { 'content-type': 'application/json' }, body })).code).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });
  it('localhost가 아닌 Host(DNS 리바인딩·외부 접속)는 거절한다', async () => {
    const r = await hit(createAiMiddleware(ready, okFetch({})), { url: '/api/ai/ask', headers: { ...self, host: 'evil.example:5180', origin: 'http://evil.example:5180' }, body });
    expect(r.code).toBe(403);
  });
  it('JSON이 아닌 본문(폼 전송)은 거절한다', async () => {
    expect((await hit(createAiMiddleware(ready, okFetch({})), { url: '/api/ai/ask', headers: { ...self, 'content-type': 'text/plain' }, body })).code).toBe(415);
  });
  it('브라우저가 보낸 baseUrl·model·messages 필드는 무시되고 서버 설정 주소로만 간다', async () => {
    const f = okFetch({ choices: [{ message: { content: 'x' } }] });
    const r = await hit(createAiMiddleware(ready, f), {
      url: '/api/ai/ask', headers: self,
      body: { ...body, baseUrl: 'https://evil.example', model: 'evil', messages: [{ role: 'system', content: 'leak' }] },
    });
    expect(r.json).toMatchObject({ ok: true, source: 'chatkhu' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith(DEFAULT_BASE_URL)).toBe(true);
    expect(JSON.parse(init.body as string).model).toBe('some-model');
    expect(init.body).not.toContain('leak');
  });
  it('상태 조회는 응답에 키를 포함하지 않고, /api/ai/ 밖은 통과시킨다', async () => {
    const mw = createAiMiddleware(ready, okFetch({}));
    const s = await hit(mw, { method: 'GET', url: '/api/ai/status' });
    expect(s.json.state).toBe('ready');
    expect(JSON.stringify(s.json)).not.toContain(KEY);
    expect((await hit(mw, { method: 'GET', url: '/index.html' })).nexted).toBe(true);
  });
  it('요청 형식 검사: 줄 수가 범위와 다르거나 비어 있으면 거절', () => {
    expect(typeof parseAskRequest({ ...body, snippets: [{ file: 'a', startLine: 1, endLine: 3, code: 'x' }] })).toBe('string');
    expect(typeof parseAskRequest({ ...body, question: '  ' })).toBe('string');
    expect(typeof parseAskRequest({ ...body, snippets: [] })).toBe('string');
  });
  it('로그에 키·Authorization·요청 본문이 남지 않는다', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await hit(createAiMiddleware(ready, okFetch({ choices: [{ message: { content: 'x' } }] })), { url: '/api/ai/ask', headers: self, body: { ...body, question: '비밀질문' } });
    const logged = spy.mock.calls.flat().join(' ');
    spy.mockRestore();
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('Bearer');
    expect(logged).not.toContain('비밀질문');
  });
});

describe('보낼 코드 준비', () => {
  it('선택한 위치와 위아래 3줄만 담고 다른 파일은 담지 않는다', () => {
    const p = prepareSnippets([loc('src/a.ts', 20, 20, 'function target')], FILES);
    expect(p.snippets).toHaveLength(1);
    expect(p.snippets[0]).toMatchObject({ file: 'src/a.ts', startLine: 17, endLine: 23 });
    expect(p.snippets[0].code.split('\n')).toHaveLength(7);
    const user = buildMessages({ target: 't', question: 'q', snippets: p.snippets })[1].content;
    expect(user).toContain('20| export function target()');
    expect(user).not.toContain('line1 ');
    expect(user).not.toContain('unrelated');
  });
  it('확인되지 않는 위치(없는 파일·어긋난 줄)는 보내지 않고 사유를 남긴다', () => {
    const p = prepareSnippets([loc('src/none.ts', 1, 1, 'x'), loc('src/a.ts', 5, 5, 'function target')], FILES);
    expect(p.snippets).toHaveLength(0);
    expect(p.excluded).toHaveLength(2);
  });
  it('.env 같은 인증 정보 파일은 위치가 맞아도 보내지 않는다', () => {
    const p = prepareSnippets([loc('.env', 1, 1, 'CHATKHU')], FILES);
    expect(p.snippets).toHaveLength(0);
    expect(p.excluded[0].reason).toContain('인증 정보');
  });
  it('키·토큰·Bearer·이메일로 보이는 값은 가리고 줄 수는 유지한다', () => {
    const p = prepareSnippets([loc('src/config.ts', 1, 5, 'apiKey')], FILES);
    const code = p.snippets[0].code;
    for (const s of ['abcd1234efgh', 'sk-ABCDEFGHIJKLMNOPQRSTUV', 'abc.def.ghijklmnop', 'student@khu.ac.kr']) expect(code).not.toContain(s);
    expect(code).toContain('평범한 값');
    expect(code.split('\n')).toHaveLength(5);
    expect(p.redacted).toBe(4);
  });
  it('개인 키 블록은 줄 전체를 가린다', () => {
    const r = redact('a\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJ\n-----END RSA PRIVATE KEY-----\nb');
    expect(r.code).toBe('a\n[가림: 개인 키]\n[가림: 개인 키]\n[가림: 개인 키]\nb');
  });
});

describe('동의', () => {
  const p = prepareSnippets([loc('src/a.ts', 20, 20, 'function target')], FILES);
  const req: AskRequest = { target: 't', question: '이 단계를 쉽게 설명해 줘.', snippets: p.snippets };
  it('동의 전에는 네트워크 요청을 보내지 않는다', async () => {
    const f = okFetch({ ok: true, source: 'chatkhu', model: 'm', text: 'x' });
    expect(await sendAsk(req, null, f)).toMatchObject({ ok: false, kind: 'no-consent' });
    expect(f).not.toHaveBeenCalled();
  });
  it('미리 본 뒤 질문이나 코드가 바뀌면 다시 동의가 필요하다', async () => {
    const f = okFetch({ ok: true, source: 'chatkhu', model: 'm', text: 'x' });
    const key = requestKey(req);
    expect(await sendAsk({ ...req, question: '다른 질문' }, key, f)).toMatchObject({ kind: 'no-consent' });
    expect(await sendAsk({ ...req, snippets: [{ ...req.snippets[0], code: req.snippets[0].code + ' ' }] }, key, f)).toMatchObject({ kind: 'no-consent' });
    expect(f).not.toHaveBeenCalled();
    expect(await sendAsk(req, key, f)).toMatchObject({ ok: true });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('서버가 꺼져 있어도 예외 없이 실패 결과를 돌려준다(지도·코드 탐색은 영향 없음)', async () => {
    const r = await sendAsk(req, requestKey(req), vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(r).toMatchObject({ ok: false, kind: 'network' });
  });
});

describe('답변 해석과 근거 대조', () => {
  const snippets = [{ file: 'src/a.ts', startLine: 17, endLine: 23, code: FILES['src/a.ts'].split('\n').slice(16, 23).join('\n') }];
  it('보낸 범위 안 위치만 유효, 범위 밖·보내지 않은 파일·없는 파일은 근거 확인 불가', () => {
    const c = checkCitations('근거: src/a.ts:20 그리고 src/a.ts:20-22, src/a.ts:30-31, src/other.ts:1, src/ghost.tsx:5', snippets);
    expect(c.map((x) => [x.ref, x.ok])).toEqual([
      ['src/a.ts:20', true], ['src/a.ts:20-22', true], ['src/a.ts:30-31', false], ['src/other.ts:1', false], ['src/ghost.tsx:5', false],
    ]);
    expect(c[0].lines).toEqual([{ n: 20, text: 'export function target() { return 1; }' }]);
  });
  it('네 제목으로 나누고, 형식을 따르지 않으면 null', () => {
    const a = parseAnswer('## 쉬운 설명\n쉬움\n## 코드에서 확인한 내용\n- 사실\n### 4. 확인하지 못한 부분\n모름');
    expect(a).toEqual({ '쉬운 설명': '쉬움', '코드에서 확인한 내용': '- 사실', '확인하지 못한 부분': '모름' });
    expect(parseAnswer('그냥 문장')).toBeNull();
  });
});

describe('키가 번들·저장소에 들어가지 않음', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  it('브라우저 코드(src)는 CHATKHU_ 환경 변수·process.env·server 모듈을 참조하지 않는다', () => {
    for (const f of walk('src').filter((p) => /\.(ts|tsx)$/.test(p) && !p.endsWith('.test.ts'))) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/CHATKHU_|process\.env|from ['"]\.\.\/server/);
    }
    expect(readFileSync('vite.config.ts', 'utf8')).not.toMatch(/envPrefix\s*:|define\s*:/);
  });
  it('.env는 Git에서 제외되고 .env.example에는 값이 비어 있다', () => {
    const ignore = readFileSync('.gitignore', 'utf8').split(/\r?\n/);
    expect(ignore).toContain('.env');
    for (const l of readFileSync('.env.example', 'utf8').split(/\r?\n/).filter((x) => /^CHATKHU_/.test(x))) expect(l).toMatch(/^CHATKHU_\w+=$/);
  });
});

describe('끊긴 지점 관련 코드 찾기', () => {
  it('Context에서 꺼낸 함수의 선언을 다른 파일에서 찾고, 끊긴 지점 자신과 .env는 뺀다', () => {
    const files = {
      'src/Nav.tsx': 'const { logout } = useStudent();\nlogout();',
      'src/Ctx.tsx': 'type S = {\n  logout: () => void;\n};\nconst logout = () => {\n  clear();\n};',
      '.env': 'const logout = () => {}',
    };
    const r = relatedLocations([{ file: 'src/Nav.tsx', startLine: 2, endLine: 2, label: 'logout()', anchor: 'logout()' }], files);
    expect(r.map((l) => `${l.file}:${l.startLine}`)).toEqual(['src/Ctx.tsx:2', 'src/Ctx.tsx:4']);
    expect(prepareSnippets(r, files).snippets).toHaveLength(1); // 위치가 실제 코드와 맞아 전송 대상이 된다
  });
});

describe('AI 핵심 요약 지도 검사', () => {
  it('실제 항목이 없는 카드와 코드 근거가 없는 연결선은 버린다', async () => {
    const { buildOutline, parseSummary } = await import('./ai/mapGuide');
    const node = (id: string) => ({ id, title: id, kind: 'logic' as const, summary: '', provenance: 'static-analysis' as const, verification: { status: 'confirmed' as const }, locations: [] });
    const base = { project: { id: 'p', name: 'p', sourceName: 'p', stack: '', description: '' }, provenance: 'static-analysis' as const, notice: '', features: [], flows: [],
      nodes: [node('A'), node('B'), node('C')],
      relations: [{ id: 'r', from: 'A', to: 'B', kind: 'call' as const, label: 'x', locations: [], provenance: 'static-analysis' as const }] };
    const o = buildOutline(base);
    const ai = JSON.stringify({ cards: [{ id: 'c1', title: '가', kind: 'page', members: ['n0'] }, { id: 'c2', title: '나', kind: 'zzz', members: ['n1'] }, { id: 'c3', title: '다', members: ['n2'] }, { id: 'c4', title: '가짜', members: ['n99'] }],
      links: [{ from: 'c1', to: 'c2', label: '근거 있음' }, { from: 'c2', to: 'c3', label: '근거 없음' }] });
    const s = parseSummary(`설명 앞말 ${ai} 뒷말`, base, o.ids);
    if (typeof s === 'string') throw new Error(s);
    expect(s.nodes.map((n) => n.title)).toEqual(['가', '나', '다']);
    expect(s.nodes[1].kind).toBe('logic');
    expect(s.relations.map((r) => r.label)).toEqual(['근거 있음']);
    expect(parseSummary('JSON 아님', base, o.ids)).toBeTypeOf('string');
  });
});
