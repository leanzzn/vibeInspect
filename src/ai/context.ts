// 브라우저 쪽: 선택한 항목의 코드 위치에서 보낼 코드 조각을 고르고, 민감해 보이는 값을 가리고,
// 동의한 요청만 VibeInspect 서버로 보낸다. AI 답변의 근거 위치를 보낸 범위와 대조한다.
import type { CodeLocation } from '../model';
import { resolveLocation } from '../lib';
import { isSensitiveName } from '../zip';
import { ASK_LIMITS, requestKey, type AskRequest, type AskResult, type Snippet } from './prompt';

const PAD = 3;

// ── 가림 처리 ──
// ponytail: 정규식 기반 탐지라 형식이 특이한 비밀 값은 놓친다. 필요하면 엔트로피 검사를 추가
const TOKEN = /\b(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
const ASSIGN = /((?:api[_-]?key|apikey|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|client[_-]?secret|authorization|credential)\w*["']?\s*[:=]\s*)(["'`])(?!\[가림)([^"'`\n]{4,})\2/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/g;

/** 줄 수를 그대로 유지하면서 민감해 보이는 값을 [가림]으로 바꾼다. */
export function redact(code: string): { code: string; count: number } {
  let count = 0;
  let inKey = false;
  const hit = (s: string) => { count++; return s; };
  const lines = code.split('\n').map((line) => {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) inKey = true;
    if (inKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) inKey = false;
      return hit('[가림: 개인 키]');
    }
    return line
      .replace(TOKEN, () => hit('[가림: 토큰]'))
      .replace(ASSIGN, (_, pre, q) => hit(`${pre}${q}[가림]${q}`))
      .replace(BEARER, (_, pre) => hit(`${pre}[가림]`))
      .replace(EMAIL, () => hit('[가림: 이메일]'));
  });
  return { code: lines.join('\n'), count };
}

// ── 보낼 코드 고르기 ──
export interface Prepared {
  snippets: Snippet[];
  excluded: { label: string; reason: string }[];
  redacted: number;
}

/** 선택한 항목의 코드 위치만, 위아래 몇 줄의 문맥을 붙여 준비한다. 위치가 확인되지 않으면 보내지 않는다. */
export function prepareSnippets(locations: CodeLocation[], files: Record<string, string>): Prepared {
  const excluded: Prepared['excluded'] = [];
  const ranges: { file: string; s: number; e: number }[] = [];
  for (const loc of locations) {
    const label = `${loc.file}:${loc.startLine}-${loc.endLine}`;
    if (isSensitiveName(loc.file)) { excluded.push({ label, reason: '환경 변수·인증 정보로 보이는 파일이라 보내지 않음' }); continue; }
    const r = resolveLocation(loc, files);
    if (!r.ok) { excluded.push({ label, reason: `코드 위치 확인 불가: ${r.reason}` }); continue; }
    const s = Math.max(1, loc.startLine - PAD);
    let e = Math.min(r.lines.length, loc.endLine + PAD);
    if (e - s + 1 > ASK_LIMITS.snippetLines) {
      e = s + ASK_LIMITS.snippetLines - 1;
      excluded.push({ label, reason: `${ASK_LIMITS.snippetLines}줄이 넘어 ${e + 1}줄 이후는 보내지 않음` });
    }
    ranges.push({ file: loc.file, s, e });
  }
  // 같은 파일에서 겹치거나 붙은 범위는 합친다
  ranges.sort((a, b) => a.file.localeCompare(b.file) || a.s - b.s);
  const merged: typeof ranges = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && last.file === r.file && r.s <= last.e + 1 && Math.max(last.e, r.e) - last.s + 1 <= ASK_LIMITS.snippetLines) last.e = Math.max(last.e, r.e);
    else merged.push({ ...r });
  }
  const snippets: Snippet[] = [];
  let redacted = 0, chars = 0;
  for (const r of merged) {
    const label = `${r.file}:${r.s}-${r.e}`;
    if (snippets.length >= ASK_LIMITS.snippets) { excluded.push({ label, reason: `코드 조각은 ${ASK_LIMITS.snippets}개까지만 보냄` }); continue; }
    const { code, count } = redact(files[r.file].split('\n').slice(r.s - 1, r.e).join('\n'));
    if (chars + code.length > ASK_LIMITS.codeChars) { excluded.push({ label, reason: `전체 ${ASK_LIMITS.codeChars}자 제한을 넘어 보내지 않음` }); continue; }
    chars += code.length;
    redacted += count;
    snippets.push({ file: r.file, startLine: r.s, endLine: r.e, code });
  }
  return { snippets, excluded, redacted };
}

// ── 답변 해석 ──
export const SECTIONS = ['쉬운 설명', '코드에서 확인한 내용', '추정', '확인하지 못한 부분'] as const;
const squash = (s: string) => s.replace(/[\s*_#:.\d)]/g, '');

/** 네 제목으로 나눈다. 제목을 하나도 찾지 못하면 null (원문을 그대로 보여 준다). */
export function parseAnswer(text: string): Partial<Record<(typeof SECTIONS)[number], string>> | null {
  const parts = text.split(/^\s*#{1,6}\s*(.+?)\s*$/m);
  const out: Partial<Record<(typeof SECTIONS)[number], string>> = {};
  for (let i = 1; i < parts.length; i += 2) {
    const h = SECTIONS.find((k) => squash(parts[i]) === squash(k));
    if (h) out[h] = [out[h], parts[i + 1].trim()].filter(Boolean).join('\n');
  }
  return Object.keys(out).length ? out : null;
}

export interface Citation { ref: string; file: string; start: number; end: number; ok: boolean; reason?: string; lines?: { n: number; text: string }[] }

/** 답변에 적힌 "파일:줄" 근거를 이번 요청에서 실제로 보낸 범위와 대조한다. */
export function checkCitations(text: string, snippets: Snippet[]): Citation[] {
  const out = new Map<string, Citation>();
  for (const m of text.matchAll(/([A-Za-z0-9_@./-]+\.(?:tsx?|jsx?|json|css|html)):(\d+)(?:\s*[-–~]\s*(\d+))?/g)) {
    const [ref, file] = m;
    const start = Number(m[2]), end = Number(m[3] ?? m[2]);
    if (out.has(ref)) continue;
    const inFile = snippets.filter((s) => s.file === file);
    const s = inFile.find((x) => start >= x.startLine && end <= x.endLine && end >= start);
    if (s) {
      const lines = s.code.split('\n').slice(start - s.startLine, end - s.startLine + 1).map((t, i) => ({ n: start + i, text: t }));
      out.set(ref, { ref, file, start, end, ok: true, lines });
    } else {
      out.set(ref, { ref, file, start, end, ok: false, reason: inFile.length ? '이번에 보낸 줄 범위 밖' : '이번 요청에 보내지 않은 파일' });
    }
  }
  return [...out.values()];
}

// ── 서버 호출 ──
type Fetch = typeof fetch;

async function call<T>(path: string, body: unknown, fetchImpl: Fetch, signal?: AbortSignal): Promise<T | { ok: false; kind: string; message: string }> {
  try {
    const r = await fetchImpl(path, body === undefined ? { signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const j = await r.json().catch(() => null);
    if (!j || typeof j !== 'object') return { ok: false, kind: 'bad-response', message: `VibeInspect 서버 응답을 해석하지 못했습니다(HTTP ${r.status}). 개발 서버가 실행 중인지 확인하세요.` };
    return j as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { ok: false, kind: 'aborted', message: '요청을 취소했습니다.' };
    return { ok: false, kind: 'network', message: 'VibeInspect 서버에 연결하지 못했습니다. npm run dev로 실행 중인지 확인하세요.' };
  }
}

export interface AiStatus { state: 'ready' | 'mock' | 'no-key' | 'no-model' | 'bad-base-url'; model?: string; baseHost?: string; message: string }
export type CheckResult = { ok: boolean; kind: string; message: string };

export const getStatus = (fetchImpl: Fetch = fetch) => call<AiStatus>('/api/ai/status', undefined, fetchImpl);
export const checkConnection = (fetchImpl: Fetch = fetch) => call<CheckResult>('/api/ai/check', {}, fetchImpl);
export const pingModel = (fetchImpl: Fetch = fetch) => call<CheckResult>('/api/ai/ping', {}, fetchImpl);

/** 사용자가 미리 본 그 요청(consentKey)일 때만 보낸다. 다르면 네트워크 요청을 하지 않는다. */
export async function sendAsk(req: AskRequest, consentKey: string | null, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<AskResult> {
  if (consentKey === null || consentKey !== requestKey(req)) {
    return { ok: false, kind: 'no-consent', message: '보낼 내용을 확인하고 동의한 뒤에만 보낼 수 있습니다.' };
  }
  const r = await call<AskResult>('/api/ai/ask', req, fetchImpl, signal);
  if (r.ok && (typeof (r as { text?: unknown }).text !== 'string' || !['chatkhu', 'mock'].includes((r as { source?: string }).source ?? ''))) {
    return { ok: false, kind: 'bad-response', message: '서버 응답 형식이 올바르지 않습니다.' };
  }
  return r as AskResult;
}

// ── 끊긴 지점 추적용 관련 코드 찾기 ──
const NOT_NAMES = new Set(['import', 'fetch', 'navigate', 'props', 'this']);

/**
 * 끊긴 지점 이름(label의 마지막 식별자)이 선언되거나 props로 넘겨지는 줄을 다른 곳에서 찾는다.
 * AI가 정적 분석이 확정하지 못한 연결을 추정할 재료로만 쓴다.
 * ponytail: 단순 문자열 검색이라 같은 이름의 다른 코드가 섞일 수 있다. 필요하면 TypeScript 심볼 검색으로 바꿀 것
 */
export function relatedLocations(gap: CodeLocation[], files: Record<string, string>, max = 4): CodeLocation[] {
  const names = new Set(gap.map((l) => (l.label.match(/[A-Za-z_$][\w$]*/g) ?? []).pop()).filter((n): n is string => !!n && n.length > 2 && !NOT_NAMES.has(n)));
  const out: CodeLocation[] = [];
  for (const n of names) {
    const N = n.replace(/\$/g, '\\$');
    const decl = new RegExp(`\\b(?:function|const|let|var|class|interface|type)\\s+${N}\\b|\\b${N}\\s*(?::|=)\\s*(?:async\\b|\\(|function\\b|use[A-Z]|\\{)|\\b${N}\\s*\\([^)]*\\)\\s*\\{`);
    let perName = 0;
    for (const [file, text] of Object.entries(files)) {
      if (isSensitiveName(file)) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && perName < 2 && out.length < max; i++) {
        if (!decl.test(lines[i]) || gap.some((g) => g.file === file && i + 1 >= g.startLine && i + 1 <= g.endLine)) continue;
        out.push({ file, startLine: i + 1, endLine: Math.min(lines.length, i + 11), label: `${n} 관련 코드`, anchor: lines[i].trim() });
        perName++;
      }
    }
  }
  return out;
}
