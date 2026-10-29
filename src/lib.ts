import type { CanvasLayout, CodeLocation } from './model';

// ── 분석 대상 소스 ─────────────────────────────────────────────
// samples/test_code 는 test_code.zip에서 src만 풀어 둔 읽기 전용 사본이다.
// ?raw 로 문자열로만 가져오므로 번들에 포함돼도 실행되지 않는다.
const raw = import.meta.glob('/samples/test_code/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** 프로젝트 루트 기준 상대 경로 → 원문 */
export const sourceFiles: Record<string, string> = Object.fromEntries(
  Object.entries(raw).map(([k, v]) => [k.replace('/samples/test_code/', ''), v.replace(/\r\n/g, '\n')]),
);

export type ResolvedLocation =
  | { ok: true; loc: CodeLocation; lines: string[] }
  | { ok: false; loc: CodeLocation; reason: string };

// 같은 파일을 카드마다 다시 나누지 않도록 프로젝트(files 객체)별로 줄 배열을 기억한다
const splitCache = new WeakMap<Record<string, string>, Map<string, string[]>>();

/** 연결 위치가 실제 파일·줄과 맞는지 확인. 맞지 않으면 절대 강조하지 않는다. */
export function resolveLocation(loc: CodeLocation, files: Record<string, string> = sourceFiles): ResolvedLocation {
  const text = Object.prototype.hasOwnProperty.call(files, loc.file) ? files[loc.file] : undefined;
  if (text === undefined) return { ok: false, loc, reason: `파일을 찾을 수 없습니다: ${loc.file}` };
  let cache = splitCache.get(files);
  if (!cache) splitCache.set(files, (cache = new Map()));
  let lines = cache.get(loc.file);
  if (!lines) cache.set(loc.file, (lines = text.split('\n')));
  const { startLine: s, endLine: e } = loc;
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s || e > lines.length) {
    return { ok: false, loc, reason: `줄 범위 ${s}–${e}가 파일 범위(1–${lines.length})를 벗어났습니다.` };
  }
  if (!lines.slice(s - 1, e).join('\n').includes(loc.anchor)) {
    return { ok: false, loc, reason: '해당 줄에서 기대한 코드를 찾지 못했습니다. 원본이 바뀌었을 수 있습니다.' };
  }
  return { ok: true, loc, lines };
}

// ── 자동 배치 ─────────────────────────────────────────────────
type XY = { x: number; y: number };
const COL_W = 300, ROW_H = 170; // 카드 높이는 CSS에서 줄 수를 묶어 이 안에 들어가게 한다

/** 열 번호가 주어지면 그대로, 없으면 엣지를 따라 가장 긴 경로 깊이로 열을 정한다(순환은 무시). */
export function autoLayout(ids: string[], edges: { from: string; to: string }[], columnOf?: (id: string) => number, maxRows = 8): Record<string, XY> {
  const col: Record<string, number> = {};
  for (const id of ids) col[id] = columnOf ? columnOf(id) : 0;
  if (!columnOf) {
    // ponytail: 벨만-포드식 반복, 노드가 수백 개를 넘으면 위상 정렬로 교체
    for (let i = 0; i < ids.length; i++) {
      for (const { from, to } of edges) if (col[from] !== undefined && col[to] !== undefined && col[to] < col[from] + 1) col[to] = col[from] + 1;
    }
    for (const id of ids) col[id] = Math.min(col[id], ids.length);
  }
  // 한 열이 maxRows를 넘으면 옆 칸으로 접어서 지도가 세로로만 길어지지 않게 한다
  const count: Record<number, number> = {};
  for (const id of ids) count[col[id]] = (count[col[id]] ?? 0) + 1;
  const offset: Record<number, number> = {};
  let x = 0;
  for (const c of Object.keys(count).map(Number).sort((a, b) => a - b)) { offset[c] = x; x += Math.ceil(count[c] / maxRows); }
  const rows: Record<number, number> = {};
  const out: Record<string, XY> = {};
  for (const id of ids) {
    const r = (rows[col[id]] = (rows[col[id]] ?? -1) + 1);
    out[id] = { x: (offset[col[id]] + Math.floor(r / maxRows)) * COL_W, y: (r % maxRows) * ROW_H };
  }
  return out;
}

// ── 화면 상태 저장 ─────────────────────────────────────────────
// 소스 코드나 학생 데이터는 저장하지 않는다. 카드 좌표·화면 위치·패널 상태만 저장.
const PREFIX = 'vibeinspect:v1';
export const layoutKey = (projectId: string, view: string) => `${PREFIX}:layout:${projectId}:${view}`;
export const UI_KEY = `${PREFIX}:ui`;
export const viewKey = (projectId: string) => `${PREFIX}:view:${projectId}`;

export function loadJSON<T>(key: string, storage: Pick<Storage, 'getItem'> = localStorage): T | null {
  try {
    const v = storage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

export function saveJSON(key: string, value: unknown, storage: Pick<Storage, 'setItem'> = localStorage) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장소를 쓸 수 없어도 화면은 동작해야 한다
  }
}

/** 저장된 좌표 중 현재 노드에 해당하는 것만 쓰고, 나머지는 자동 배치 좌표로 채운다. */
export function mergeLayout(auto: Record<string, XY>, saved: CanvasLayout | null): Record<string, XY> {
  const out = { ...auto };
  for (const id of Object.keys(auto)) {
    const p = saved?.positions?.[id];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out[id] = { x: p.x, y: p.y };
  }
  return out;
}
