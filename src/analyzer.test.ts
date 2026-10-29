import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeProject } from './analyzer';
import { resolveLocation } from './lib';
import type { ProjectAnalysis } from './model';
import { LIMITS, ZipError, readProjectZip } from './zip';

// ── 테스트용 ZIP 만들기 (위험한 항목을 일부러 넣기 위해 직접 만든다) ──
interface E { name: string; data?: string | Uint8Array; store?: boolean; symlink?: boolean; declared?: number }
function makeZip(entries: E[]): Uint8Array {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = typeof e.data === 'string' ? Buffer.from(e.data) : Buffer.from(e.data ?? '');
    const body = e.store ? raw : deflateRawSync(raw);
    const usize = e.declared ?? raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(e.store ? 0 : 8, 8);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.symlink ? 0x0314 : 0x0014, 4); ch.writeUInt16LE(e.store ? 0 : 8, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(e.symlink ? (0o120777 << 16) >>> 0 : 0, 38); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

function readDir(root: string, dir = root, out: Record<string, string> = {}) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) readDir(root, p, out);
    else out[p.slice(root.length + 1).replace(/\\/g, '/')] = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  }
  return out;
}

/** from → to 관계 하나를 찾는다. 노드 id에는 파일과 선언 줄이 들어 있다. */
function find(a: ProjectAnalysis, from: string, to: string, kind: string) {
  return a.relations.find((r) => r.from === from && r.to === to && r.kind === kind);
}
const lines = (r: { locations: { file: string; startLine: number }[] } | undefined) => r?.locations.map((l) => `${l.file}:${l.startLine}`);

describe('ZIP 읽기: 제외·위험 항목', () => {
  const src = 'export const a = 1;\n';
  it('최상위 폴더를 벗기고, 제외 폴더·인증 정보·다른 형식은 풀지 않고 사유를 남긴다', async () => {
    const z = await readProjectZip(makeZip([
      { name: 'proj/package.json', data: '{}' },
      { name: 'proj/src/a.ts', data: src },
      { name: 'proj/node_modules/x/index.ts', data: src },
      { name: 'proj/dist/b.ts', data: src },
      { name: 'proj/build/c.ts', data: src },
      { name: 'proj/.git/HEAD', data: 'ref' },
      { name: 'proj/src/.cache/d.ts', data: src },
      { name: 'proj/.env', data: 'KEY=1' },
      { name: 'proj/.env.local', data: 'KEY=1' },
      { name: 'proj/src/secrets.ts', data: src },
      { name: 'proj/logo.png', data: new Uint8Array([137, 80, 78, 71, 0]) },
      { name: 'proj/src/app.js', data: src },
    ]));
    expect(z.root).toBe('proj');
    expect(Object.keys(z.files)).toEqual(['src/a.ts']);
    const why = Object.fromEntries(z.excluded.map((e) => [e.path, e.reason]));
    expect(why['node_modules/x/index.ts']).toBe('제외 폴더 (node_modules)');
    expect(why['dist/b.ts']).toBe('제외 폴더 (dist)');
    expect(why['build/c.ts']).toBe('제외 폴더 (build)');
    expect(why['.git/HEAD']).toBe('제외 폴더 (.git)');
    expect(why['src/.cache/d.ts']).toBe('제외 폴더 (.cache)');
    expect(why['.env']).toMatch(/인증 정보/);
    expect(why['.env.local']).toMatch(/인증 정보/);
    expect(why['src/secrets.ts']).toMatch(/인증 정보/);
    expect(why['logo.png']).toMatch(/분석 범위 밖/);
    expect(why['src/app.js']).toMatch(/분석 범위 밖/);
  });

  it('경로 순회·절대 경로·심볼릭 링크·중복 경로는 풀지 않는다', async () => {
    const z = await readProjectZip(makeZip([
      { name: 'src/ok.ts', data: src },
      { name: '../evil.ts', data: src },
      { name: 'src/../../evil2.ts', data: src },
      { name: '/etc/abs.ts', data: src },
      { name: 'C:/win.ts', data: src },
      { name: 'src\\..\\..\\back.ts', data: src },
      { name: 'src/link.ts', data: '/etc/passwd', symlink: true },
      { name: 'src/dup.ts', data: src },
      { name: 'src/DUP.ts', data: 'export const b = 2;' },
    ]));
    expect(Object.keys(z.files)).toEqual(['src/ok.ts']);
    const why = Object.fromEntries(z.excluded.map((e) => [e.path, e.reason]));
    expect(why['../evil.ts']).toMatch(/상위 폴더/);
    expect(why['src/../../evil2.ts']).toMatch(/상위 폴더/);
    expect(why['/etc/abs.ts']).toMatch(/절대 경로/);
    expect(why['C:/win.ts']).toMatch(/절대 경로/);
    expect(why['src\\..\\..\\back.ts']).toMatch(/상위 폴더/);
    expect(why['src/link.ts']).toBe('심볼릭 링크');
    expect(why['src/dup.ts']).toBe('중복 경로');
    expect(why['src/DUP.ts']).toBe('중복 경로');
  });

  it('NUL이 든 .ts(바이너리)는 제외한다', async () => {
    const z = await readProjectZip(makeZip([{ name: 'src/video.ts', data: new Uint8Array([0x47, 0, 0x11, 0x10]) }]));
    expect(z.files).toEqual({});
    expect(z.excluded[0].reason).toMatch(/바이너리/);
  });

  it('압축 폭탄: 실제 해제 크기가 기록된 크기를 넘으면 중단한다', async () => {
    const bomb = makeZip([{ name: 'src/a.ts', data: 'a'.repeat(5_000_000), declared: 100 }]);
    expect(bomb.length).toBeLessThan(20_000);
    await expect(readProjectZip(bomb)).rejects.toThrow(/압축 폭탄/);
  });

  it('크기·개수 제한을 넘으면 이유와 함께 거부한다', async () => {
    const two = makeZip([{ name: 'src/a.ts', data: 'x'.repeat(600) }, { name: 'src/b.ts', data: 'y'.repeat(600) }]);
    await expect(readProjectZip(two, { ...LIMITS, totalBytes: 1000 })).rejects.toThrow(/해제 크기 합/);
    await expect(readProjectZip(two, { ...LIMITS, entries: 1 })).rejects.toThrow(/항목이 2개/);
    await expect(readProjectZip(two, { ...LIMITS, files: 1 })).rejects.toThrow(/분석 대상 파일이 2개/);
    await expect(readProjectZip(two, { ...LIMITS, zipBytes: 100 })).rejects.toThrow(/ZIP 파일이/);
    const big = await readProjectZip(two, { ...LIMITS, fileBytes: 500 });
    expect(big.excluded.map((e) => e.reason)).toEqual(['파일 하나 크기 제한(0MB) 초과', '파일 하나 크기 제한(0MB) 초과']);
  });

  it('ZIP이 아니면 거부한다', async () => {
    await expect(readProjectZip(new TextEncoder().encode('not a zip at all'.repeat(10)))).rejects.toBeInstanceOf(ZipError);
  });
});

// ── test_code.zip: 사람이 코드를 읽고 확인한 기준 관계와 비교 ──
describe('test_code.zip 자동 분석', () => {
  let a: ProjectAnalysis;
  let files: Record<string, string>;
  beforeAll(async () => {
    const z = await readProjectZip(new Uint8Array(readFileSync('test_code.zip')));
    files = z.files;
    a = analyzeProject(z.files, { id: 't', name: 't', sourceName: 'test_code.zip' }, { analyzedFiles: Object.keys(z.files), excluded: z.excluded, entryCount: z.entryCount });
  });

  it('기본 제한값으로 읽히고 node_modules·dist는 풀지 않는다', () => {
    expect(Object.keys(files)).toContain('src/pages/ScholarshipsPage.tsx');
    expect(Object.keys(files).some((f) => /node_modules|dist\//.test(f))).toBe(false);
    for (const [f, text] of Object.entries(files)) expect(text, f).toBe(readFileSync(`samples/test_code/${f}`, 'utf8').replace(/\r\n/g, '\n'));
  });

  const NAV = 'fn:src/components/Nav.tsx#Nav@4', LOGOUT_H = 'fn:src/components/Nav.tsx#handleLogout@8';
  const LOGIN = 'fn:src/pages/LoginPage.tsx#LoginPage@7', START = 'fn:src/pages/LoginPage.tsx#start@12', FILE = 'fn:src/pages/LoginPage.tsx#handleFile@18';
  const SCH = 'fn:src/pages/ScholarshipsPage.tsx#ScholarshipsPage@12', RES = 'fn:src/pages/ResultPage.tsx#ResultPage@24';
  const RECOMMEND = 'fn:src/logic/scholarship.ts#recommendScholarships@46';

  it.each([
    // [설명, from, to, kind, 기대 위치]
    ['JSX onClick → handleLogout', NAV, LOGOUT_H, 'event', 'src/components/Nav.tsx:21'],
    ['handleLogout → /login 이동', LOGOUT_H, 'route:/login', 'navigate', 'src/components/Nav.tsx:10'],
    ['JSX onClick → start', LOGIN, START, 'event', 'src/pages/LoginPage.tsx:48'],
    ['JSX onChange → handleFile', LOGIN, FILE, 'event', 'src/pages/LoginPage.tsx:43'],
    ['handleFile → start (같은 파일 직접 호출)', FILE, START, 'call', 'src/pages/LoginPage.tsx:27'],
    ['start → 샘플 학생 데이터 참조', START, 'data:src/data/sampleStudent.ts#sampleStudent', 'data', 'src/pages/LoginPage.tsx:13'],
    ['장학금 화면 → 학생 정보 훅 호출', SCH, 'fn:src/state/StudentContext.tsx#useRequiredStudent@43', 'call', 'src/pages/ScholarshipsPage.tsx:13'],
    ['장학금 화면 → recommendScholarships (렌더링 중)', SCH, RECOMMEND, 'call', 'src/pages/ScholarshipsPage.tsx:17'],
    ['장학금 화면 → 장학금 목록 참조', SCH, 'data:src/data/scholarships.ts#scholarships', 'data', 'src/pages/ScholarshipsPage.tsx:17'],
    ['결과 화면 → recommendScholarships (렌더링 중)', RES, RECOMMEND, 'call', 'src/pages/ResultPage.tsx:27'],
    ['recommendScholarships → evaluateScholarship', RECOMMEND, 'fn:src/logic/scholarship.ts#evaluateScholarship@9', 'call', 'src/logic/scholarship.ts:47'],
    ['recommendScholarships → sortResults', RECOMMEND, 'fn:src/logic/scholarship.ts#sortResults@38', 'call', 'src/logic/scholarship.ts:47'],
    ['onChange → setSortKey (정렬 상태)', SCH, 'state:src/pages/ScholarshipsPage.tsx#sortKey@14', 'setState', 'src/pages/ScholarshipsPage.tsx:29'],
    ['onChange → setFilter (필터 상태)', SCH, 'state:src/pages/ScholarshipsPage.tsx#filter@15', 'setState', 'src/pages/ScholarshipsPage.tsx:33'],
    ['장학금 화면 → ScholarshipCard 렌더', SCH, 'fn:src/components/ScholarshipCard.tsx#ScholarshipCard@4', 'render', 'src/pages/ScholarshipsPage.tsx:42'],
    ['NavLink → /scholarships', NAV, 'route:/scholarships', 'navigate', 'src/components/Nav.tsx:19'],
    ['<Route path="/scholarships"> → 화면', 'route:/scholarships', SCH, 'render', 'src/App.tsx:31'],
  ])('%s', (_, from, to, kind, at) => {
    const r = find(a, from, to, kind);
    expect(r, `${from} → ${to}`).toBeDefined();
    expect(lines(r)).toContain(at);
  });

  it('정렬·필터 변경은 onChange 계기로 기록되고, 추천 계산은 렌더링 중 호출로 기록된다', () => {
    expect(find(a, SCH, 'state:src/pages/ScholarshipsPage.tsx#sortKey@14', 'setState')?.trigger).toBe('onChange');
    expect(find(a, SCH, RECOMMEND, 'call')?.trigger).toBeUndefined();
  });

  it('useStudent()에서 꺼낸 logout은 확정하지 않고 "확인 필요"로 남긴다 (같은 이름의 StudentProvider 안 logout에 잘못 연결하지 않음)', () => {
    expect(a.relations.some((r) => r.from === LOGOUT_H && r.to === 'fn:src/state/StudentContext.tsx#logout@28')).toBe(false);
    const gap = a.relations.find((r) => r.from === LOGOUT_H && r.kind === 'unresolved');
    expect(gap?.label).toBe('logout()');
    expect(a.nodes.find((n) => n.id === gap!.to)?.verification.status).toBe('unconfirmed');
  });

  it('장학금 화면 흐름에 렌더링 중 계산, 상태 변경, 다시 그림 관계가 함께 있다', () => {
    const f = a.flows.find((x) => x.id === `flow:${SCH}`)!;
    const ids = f.steps.map((s) => s.id);
    expect(ids).toContain(RECOMMEND);
    expect(ids).toContain('fn:src/logic/scholarship.ts#evaluateScholarship@9');
    expect(f.relations.filter((r) => r.kind === 'rerender').map((r) => r.from).sort())
      .toEqual(['state:src/pages/ScholarshipsPage.tsx#filter@15', 'state:src/pages/ScholarshipsPage.tsx#sortKey@14']);
  });

  it('모든 자동 분석 위치가 실제 파일·줄과 맞는다', () => {
    const locs = [...a.nodes.flatMap((n) => n.locations), ...a.relations.flatMap((r) => r.locations)];
    expect(locs.length).toBeGreaterThan(0);
    for (const l of locs) {
      const r = resolveLocation(l, files);
      expect(r.ok, `${l.file}:${l.startLine} ${r.ok ? '' : r.reason}`).toBe(true);
    }
  });

  it('줄을 한 칸 밀거나 파일 범위를 넘긴 위치는 거부된다', () => {
    const l = find(a, SCH, RECOMMEND, 'call')!.locations[0];
    expect(resolveLocation({ ...l, startLine: l.startLine + 1, endLine: l.endLine + 1 }, files).ok).toBe(false);
    expect(resolveLocation({ ...l, startLine: 999, endLine: 999 }, files).ok).toBe(false);
    expect(resolveLocation({ ...l, file: 'src/없는파일.tsx' }, files).ok).toBe(false);
  });

  it('관계는 존재하는 노드만 가리킨다', () => {
    const ids = new Set(a.nodes.map((n) => n.id));
    for (const r of a.relations) expect(ids.has(r.from) && ids.has(r.to), r.id).toBe(true);
    for (const f of a.flows) {
      const steps = new Set(f.steps.map((s) => s.id));
      for (const r of f.relations) expect(steps.has(r.from) && steps.has(r.to), r.id).toBe(true);
    }
  });
});

// ── 두 번째 픽스처: 파일명·함수명·구조가 다른 프로젝트 ──
describe('fixtures/shop 자동 분석', () => {
  const files = readDir('fixtures/shop');
  const a = analyzeProject(files, { id: 's', name: 's', sourceName: 'shop' });
  const CART = 'fn:src/views/CartView.tsx#CartView@10';

  it('ZIP을 거쳐도 같은 파일을 읽는다', async () => {
    const z = await readProjectZip(makeZip(Object.entries(files).map(([name, data]) => ({ name: `shop/${name}`, data }))));
    expect(z.root).toBe('shop');
    expect(z.files).toEqual(Object.fromEntries(Object.entries(files).filter(([f]) => f.endsWith('.ts') || f.endsWith('.tsx'))));
    expect(z.excluded).toEqual([{ path: 'package.json', reason: '분석 범위 밖 형식 (.ts/.tsx만 분석)' }]);
  });

  it.each([
    ['onClick → 같은 컴포넌트 안 함수 checkout', CART, 'fn:src/views/CartView.tsx#checkout@15', 'event', 'src/views/CartView.tsx:28'],
    ['namespace import 호출 api.submitOrder', 'fn:src/views/CartView.tsx#checkout@15', 'fn:src/lib/api.ts#submitOrder@1', 'call', 'src/views/CartView.tsx:16'],
    ['useNavigate 변수 이름이 달라도(go) 이동 인식', 'fn:src/views/CartView.tsx#checkout@15', 'route:/shop/receipt', 'navigate', 'src/views/CartView.tsx:17'],
    ['중첩 Route 경로 /shop + receipt', 'route:/shop/receipt', 'fn:src/views/Receipt.tsx#Receipt@3', 'render', 'src/Shell.tsx:11'],
    ['인라인 onChange → setQty', CART, 'state:src/views/CartView.tsx#qty@11', 'setState', 'src/views/CartView.tsx:27'],
    ['import한 format은 lib/format.ts의 것', CART, 'fn:src/lib/format.ts#format@2', 'call', 'src/views/CartView.tsx:26'],
    ['pricing 안의 format은 같은 파일의 것', 'fn:src/lib/pricing.ts#totalPrice@6', 'fn:src/lib/pricing.ts#format@2', 'call', 'src/lib/pricing.ts:7'],
    ['다른 파일 상수 참조', CART, 'data:src/lib/catalog.ts#CATALOG', 'data', 'src/views/CartView.tsx:13'],
  ])('%s', (_, from, to, kind, at) => {
    expect(lines(find(a, from, to, kind))).toContain(at);
  });

  it('같은 이름 format을 서로 바꿔 연결하지 않는다', () => {
    expect(find(a, CART, 'fn:src/lib/pricing.ts#format@2', 'call')).toBeUndefined();
    expect(find(a, 'fn:src/lib/pricing.ts#totalPrice@6', 'fn:src/lib/format.ts#format@2', 'call')).toBeUndefined();
  });

  it('동적 호출·props 함수·외부 서비스는 추측하지 않고 끊긴 지점으로 남긴다', () => {
    const gap = (from: string) => a.relations.filter((r) => r.from === from && r.kind === 'unresolved').map((r) => a.nodes.find((n) => n.id === r.to)!);
    expect(gap('fn:src/views/CartView.tsx#runAction@20').map((n) => n.title)).toEqual(['handlers[kind]() — 분석하지 못함']);
    expect(gap('fn:src/views/Receipt.tsx#close@6').map((n) => n.title)).toEqual(['onDone() — 확인 필요']);
    expect(gap('fn:src/lib/api.ts#submitOrder@1').map((n) => n.title)).toEqual(['fetch() — 분석하지 못함']);
    // 동적 호출 대상 후보(handlers 안의 함수)와 연결하지 않는다
    expect(a.relations.filter((r) => r.from === 'fn:src/views/CartView.tsx#runAction@20').map((r) => r.kind)).toEqual(['unresolved']);
  });

  it('위치가 모두 실제 코드와 맞는다', () => {
    for (const l of a.relations.flatMap((r) => r.locations)) expect(resolveLocation(l, files).ok, `${l.file}:${l.startLine}`).toBe(true);
  });

  it('import 대상 파일이 빠지면 다른 파일로 대신 연결하지 않고 "분석하지 못함"으로 표시한다', () => {
    const { ['src/lib/format.ts']: _, ...rest } = files;
    const b = analyzeProject(rest, { id: 's2', name: 's2', sourceName: 'shop' });
    expect(b.relations.some((r) => r.from === CART && r.to.includes('format') && r.kind === 'call')).toBe(false);
    const g = b.relations.find((r) => r.from === CART && r.kind === 'unresolved' && r.label === 'format()');
    expect(b.nodes.find((n) => n.id === g?.to)?.summary).toMatch(/import 대상/);
  });
});

// ── 세 번째 픽스처: router 없음, Context·useReducer·useCallback, 경로 별칭, 클래스 컴포넌트, 문법 오류, .jsx ──
describe('fixtures/notes 자동 분석 (구조가 다른 프로젝트)', () => {
  const all = readDir('fixtures/notes');
  let a: ProjectAnalysis;
  let files: Record<string, string>;
  let excluded: { path: string; reason: string }[];
  beforeAll(async () => {
    const z = await readProjectZip(makeZip(Object.entries(all).map(([name, data]) => ({ name: `notes/${name}`, data }))));
    files = z.files; excluded = z.excluded;
    a = analyzeProject(files, { id: 'n', name: 'n', sourceName: 'notes' }, { analyzedFiles: Object.keys(files), excluded, entryCount: z.entryCount });
  });
  const ED = 'fn:app/features/notes/Editor.tsx#Editor@5', LIST = 'fn:app/features/notes/NoteList.tsx#NoteList@6', ROOT = 'fn:app/Root.tsx#Root@7';
  const gapsOf = (from: string) => a.relations.filter((r) => r.from === from && r.kind === 'unresolved').map((r) => `${a.nodes.find((n) => n.id === r.to)!.title} @${r.locations[0].startLine}`);

  it('.jsx는 분석 범위 밖으로 제외하고 사유를 남긴다', () => {
    expect(excluded).toContainEqual({ path: 'app/legacy/helper.jsx', reason: '분석 범위 밖 형식 (.ts/.tsx만 분석)' });
    expect(Object.keys(files)).not.toContain('app/legacy/helper.jsx');
  });

  it.each([
    ['onSubmit 인라인 → save', ED, 'fn:app/features/notes/Editor.tsx#save@8', 'call', 'app/features/notes/Editor.tsx:14'],
    ['onChange 인라인 → setText', ED, 'state:app/features/notes/Editor.tsx#text@6', 'setState', 'app/features/notes/Editor.tsx:15'],
    ['save → countWords (상위 폴더 import)', 'fn:app/features/notes/Editor.tsx#save@8', 'fn:app/utils.ts#countWords@1', 'call', 'app/features/notes/Editor.tsx:9'],
    ['커스텀 훅 호출 useNotes', LIST, 'fn:app/features/notes/store.tsx#useNotes@18', 'call', 'app/features/notes/NoteList.tsx:7'],
    ['default export 화살표 컴포넌트 렌더', ROOT, LIST, 'render', 'app/Root.tsx:14'],
    ['파일 최상위에서 그리는 Root', 'mod:app/index.tsx', ROOT, 'render', 'app/index.tsx:4'],
  ])('%s', (_, from, to, kind, at) => {
    expect(lines(find(a, from, to, kind))).toContain(at);
  });

  it('props로 넘긴 인라인 함수 안의 setTab은 onClick과 다른 계기(onSaved)로 기록한다', () => {
    const byTrigger = (t: string) => a.relations.find((r) => r.from === ROOT && r.kind === 'setState' && r.trigger === t);
    expect(lines(byTrigger('onClick'))).toEqual(['app/Root.tsx:12', 'app/Root.tsx:13']);
    expect(lines(byTrigger('onSaved'))).toEqual(['app/Root.tsx:14']);
  });

  it('Context·props·useCallback 변수·경로 별칭·클래스 컴포넌트는 추측하지 않고 끊긴 지점으로 남긴다', () => {
    expect(gapsOf('fn:app/features/notes/Editor.tsx#save@8')).toEqual(['dispatch() — 확인 필요 @10', 'onSaved() — 확인 필요 @11']);
    expect(gapsOf(LIST).sort()).toEqual(['dispatch() — 확인 필요 @11', 'remove() — 분석하지 못함 @17', 'summarize() — 분석하지 못함 @16']);
    expect(gapsOf(ROOT)).toEqual(['<OldBanner> — 분석하지 못함 @11']);
    // dispatch를 store.tsx의 reducer에 임의로 연결하지 않는다
    expect(a.relations.some((r) => r.to.includes('#reducer@'))).toBe(false);
  });

  it('문법 오류 파일을 알리고, 그 파일의 카드에 경고를 붙인다', () => {
    expect(a.scope?.parseErrors).toEqual([{ file: 'app/legacy/broken.tsx', line: 4, message: "')' expected." }]);
    expect(a.nodes.find((n) => n.id === 'fn:app/legacy/broken.tsx#Broken@3')?.summary).toMatch(/문법 오류/);
    expect(a.nodes.find((n) => n.id === ED)?.summary).not.toMatch(/문법 오류/);
  });

  it('위치가 모두 실제 코드와 맞는다', () => {
    for (const l of [...a.relations, ...a.nodes].flatMap((r) => r.locations)) expect(resolveLocation(l, files).ok, `${l.file}:${l.startLine}`).toBe(true);
  });
});

describe('경계 입력', () => {
  it('관계가 없는 파일만 있으면 빈 결과를 돌려준다(오류 없이)', () => {
    const a = analyzeProject({ 'src/types.ts': 'export type A = { x: number };\n' }, { id: 'e', name: 'e', sourceName: 'e' });
    expect(a.nodes).toEqual([]);
    expect(a.flows).toEqual([]);
  });

  it('큰 파일(약 900KB)도 분석하고 위치가 맞는다', () => {
    const body = Array.from({ length: 20000 }, (_, i) => `export function f${i}() { return g(); }`).join('\n');
    const files = { 'src/big.ts': `function g() { return 1; }\n${body}\n` };
    expect(files['src/big.ts'].length).toBeLessThan(LIMITS.fileBytes);
    const t = performance.now();
    const a = analyzeProject(files, { id: 'b', name: 'b', sourceName: 'b' });
    console.log(`큰 파일 분석 ${Math.round(performance.now() - t)}ms (이 기기 측정값, 기준값 아님)`);
    expect(a.relations.filter((r) => r.kind === 'call')).toHaveLength(20000);
    expect(a.relations.every((r) => r.locations.every((l) => resolveLocation(l, files).ok))).toBe(true);
  }, 20000);
});
