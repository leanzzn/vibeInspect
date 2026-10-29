import { useState, type ReactNode } from 'react';
import App from './App';
import { testCodeExample } from './data/testCodeExample';
import { loadJSON, saveJSON, sourceFiles } from './lib';
import type { ProjectAnalysis } from './model';
import { ANALYZED_EXT, EXCLUDED_DIRS, LIMITS, ZipError, readProjectZip } from './zip';

interface Project { analysis: ProjectAnalysis; files: Record<string, string> }
const MANUAL: Project = { analysis: testCodeExample, files: sourceFiles };
const SIDE_KEY = 'vibeinspect:v1:sidebar';
const ACTIVE_KEY = 'vibeinspect:v1:active';
const MB = 1024 * 1024;

// 선 아이콘 (참고 화면처럼 단색 외곽선)
const I = (d: ReactNode) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>;
const ICON = {
  panel: I(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>),
  upload: I(<><path d="M12 15V4M7 9l5-5 5 5" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>),
  map: I(<><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" /></>),
  file: I(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>),
  book: I(<><path d="M4 5a2 2 0 0 1 2-2h5v17H6a2 2 0 0 0-2 2z" /><path d="M20 5a2 2 0 0 0-2-2h-5v17h5a2 2 0 0 1 2 2z" /></>),
  shield: I(<><path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z" /></>),
  chev: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m6 15 6-6 6 6" /></svg>,
};

export default function Shell() {
  const [uploads, setUploads] = useState<Project[]>([]);
  // 새로고침해도 보던 메뉴로 돌아온다. 자동 분석 결과는 저장하지 않으므로 그때는 새 분석 화면에서 안내한다.
  const [lastUpload] = useState(() => { const v = loadJSON<string>(ACTIVE_KEY); return v?.startsWith('upload:') ? v.split(':')[1] : null; });
  const [active, setActiveRaw] = useState<string>(() => { const v = loadJSON<string>(ACTIVE_KEY); return v && !v.startsWith('upload:') ? v : 'home'; });
  const setActive = (id: string) => { setActiveRaw(id); saveJSON(ACTIVE_KEY, id); };
  const [narrow, setNarrow] = useState(() => loadJSON<boolean>(SIDE_KEY) ?? false);
  const [listOpen, setListOpen] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // 진행 단계 문구
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

  const toggle = () => setNarrow((n) => { saveJSON(SIDE_KEY, !n); return !n; });
  const project = [MANUAL, ...uploads].find((p) => p.analysis.project.id === active);

  async function onFile(f: File | undefined) {
    if (!f || busy) return;
    setError(null);
    if (!f.name.toLowerCase().endsWith('.zip')) return setError(`ZIP 파일만 올릴 수 있습니다(선택한 것: ${f.name}). 폴더라면 먼저 ZIP으로 압축해 주세요 — Windows: 폴더 오른쪽 클릭 → "압축(ZIP) 파일로 보내기", macOS: 오른쪽 클릭 → "압축".`);
    if (f.size > LIMITS.zipBytes) return setError(`ZIP 파일이 ${LIMITS.zipBytes / MB}MB를 넘습니다(${(f.size / MB).toFixed(1)}MB). node_modules·dist 등을 빼고 다시 압축해 주세요.`);
    setBusy('1/3 ZIP 안의 파일 목록을 읽는 중…');
    try {
      const z = await readProjectZip(new Uint8Array(await f.arrayBuffer()));
      const n = Object.keys(z.files).length;
      if (n === 0) {
        const js = z.excluded.filter((e) => /\.(jsx?|mjs|cjs)$/i.test(e.path)).length;
        throw new ZipError(js
          ? `분석할 .ts/.tsx 파일이 없습니다. JavaScript 파일(.js/.jsx) ${js}개가 있었지만, 지금 버전은 TypeScript(.ts/.tsx) 프로젝트만 분석합니다.`
          : `분석할 .ts/.tsx 파일이 없습니다. ZIP의 파일 ${z.excluded.length}개는 모두 제외 대상이었습니다. 프로젝트 폴더 전체(src 포함)를 압축했는지 확인해 주세요.`);
      }
      // 분석기(TypeScript 컴파일러)는 크기가 커서 처음 업로드할 때만 불러온다
      setBusy(`2/3 분석 도구를 불러오는 중… (.ts/.tsx ${n}개 발견)`);
      const { analyzeProject } = await import('./analyzer');
      setBusy(`3/3 ${n}개 파일의 연결 관계를 읽는 중…`);
      await new Promise((r) => setTimeout(r, 30)); // 진행 문구가 먼저 그려지도록 (분석 중에는 화면이 잠시 멈춘다)
      const id = `upload:${f.name}:${f.size}`;
      const analysis = analyzeProject(z.files, { id, name: z.root || f.name.replace(/\.zip$/i, ''), sourceName: f.name },
        { analyzedFiles: Object.keys(z.files), excluded: z.excluded, entryCount: z.entryCount });
      setUploads((u) => [{ analysis, files: z.files }, ...u.filter((p) => p.analysis.project.id !== id)]);
      setActive(id);
    } catch (e) {
      setError(e instanceof ZipError ? e.message : `분석 중 예상하지 못한 오류가 났습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const item = (id: string, icon: ReactNode, label: string, title = label) => (
    <button key={id} className={`side-item${active === id ? ' on' : ''}`} onClick={() => setActive(id)} title={title} aria-current={active === id ? 'page' : undefined}>
      {icon}<span className="side-label">{label}</span>
    </button>
  );

  return (
    <div className={`shell${narrow ? ' narrow' : ''}`}>
      <aside className="side" aria-label="메뉴">
        <div className="side-top">
          {!narrow && <span className="logo">VibeInspect</span>}
          <button className="icon-btn" onClick={toggle} title={narrow ? '메뉴 펼치기' : '메뉴 접기'} aria-expanded={!narrow}>{ICON.panel}</button>
        </div>
        <nav className="side-nav">
          {item('home', ICON.upload, '새 분석')}
          {item(MANUAL.analysis.project.id, ICON.map, '수동 예제', '수동 예제: test_code')}
          {!narrow && (
            <button className="side-head" onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen}>
              자동 분석 결과 <span className={listOpen ? '' : 'flip'}>{ICON.chev}</span>
            </button>
          )}
          {(narrow || listOpen) && uploads.map((p) => item(p.analysis.project.id, ICON.file, p.analysis.project.sourceName))}
        </nav>
        <div className="side-bottom">
          {item('guide', ICON.book, '이용 안내')}
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <div className="top-title">
            <strong>{project ? project.analysis.project.name : active === 'guide' ? '이용 안내' : '새 분석'}</strong>
            {project && <span className="muted">{project.analysis.project.sourceName}</span>}
          </div>
          {project && (
            <span className="top-chips" title={`${project.analysis.notice} 카드와 선을 움직여도 원본 코드는 바뀌지 않습니다.`}>
              <span className={`chip prov ${project === MANUAL ? 'manual' : 'auto'}`}>{project === MANUAL ? '수동 예제' : '자동 분석'}</span>
              <span className="chip">정적 분석 · 실제 실행 기록 아님</span>
            </span>
          )}
        </header>

        {project ? <App key={project.analysis.project.id} analysis={project.analysis} files={project.files} />
          : active === 'guide' ? <Guide />
          : (
            <main className="home">
              <h1>프로젝트 ZIP을 올려 주세요</h1>
              <label className={`drop${drag ? ' over' : ''}${busy ? ' busy' : ''}`} aria-busy={!!busy} title="React + TypeScript 프로젝트 폴더를 ZIP으로 압축해 올리세요. 브라우저 안에서만 읽고 코드를 실행하지 않습니다."
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0]); }}>
                <span className="drop-icon" aria-hidden>{ICON.upload}</span>
                <strong className="drop-title" aria-live="polite">{busy ?? (drag ? '놓으면 분석을 시작합니다' : 'ZIP 파일을 끌어다 놓거나 선택')}</strong>
                {!busy && <span className="drop-btn">ZIP 파일 선택</span>}
                <input type="file" accept=".zip,application/zip" disabled={!!busy} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
                <span className="drop-meta">.zip · 최대 {LIMITS.zipBytes / MB}MB · .ts/.tsx 분석 · 서버로 보내지 않음</span>
              </label>
              {error && <p className="error" role="alert">{error}</p>}
              {!error && lastUpload && <p className="home-info" role="status">새로고침으로 {lastUpload} 분석 결과가 사라졌습니다. 같은 ZIP을 다시 올리면 화면이 복원됩니다.</p>}
              <button className="link home-alt" onClick={() => setActive(MANUAL.analysis.project.id)}>예제로 둘러보기 →</button>
            </main>
          )}
      </div>
    </div>
  );
}

function Guide() {
  return (
    <main className="guide">
      <h2>화면에 나오는 말</h2>
      <table>
        <tbody>
          <tr><th>정적 분석</th><td>코드를 실행하지 않고 글자(문법)만 읽어서 연결을 찾는 방식입니다. 실제로 그 순서대로 실행됐다는 기록이 아닙니다.</td></tr>
          <tr><th>서비스 전체 지도</th><td>어떤 화면·함수·데이터가 서로 연결되어 있는지 보여 줍니다. 선은 연결 관계이고, 시간 순서가 아닙니다.</td></tr>
          <tr><th>동작 흐름</th><td>한 화면(컴포넌트)에서 시작해 연결을 따라간 단계 목록입니다. 단계 번호는 읽기 순서이며 실제 실행 순서가 아닙니다.</td></tr>
          <tr><th>확인 필요</th><td>코드만으로는 어떤 함수가 불릴지 확정할 수 없는 곳(예: 다른 곳에서 넘겨받은 함수). 사람이 직접 확인해야 합니다.</td></tr>
          <tr><th>분석하지 못함</th><td>이 도구가 지원하지 않는 방식이라 더 따라가지 못한 곳입니다.</td></tr>
          <tr><th>연결 위치 확인 불가</th><td>가리키는 파일·줄이 실제 코드와 맞지 않아 강조하지 않은 경우입니다.</td></tr>
          <tr><th>수동 예제 / 자동 분석</th><td>수동 예제는 사람이 test_code를 읽고 만든 예시이고, 자동 분석은 올린 ZIP을 이 도구가 읽은 결과입니다.</td></tr>
        </tbody>
      </table>
      <h2>업로드 처리 방식</h2>
      <ul>
        <li>ZIP은 브라우저 안에서만 읽습니다. 서버로 보내거나 디스크에 쓰지 않고, 원본 ZIP을 바꾸지 않습니다.</li>
        <li>업로드한 코드를 실행하거나 의존성을 설치하지 않습니다. 분석 결과와 소스는 저장하지 않으며 새로고침하면 사라집니다.</li>
        <li>ZIP 목록(중앙 디렉터리)을 먼저 읽고, 제외 대상은 <b>압축을 풀기 전에</b> 걸러 냅니다.</li>
      </ul>
      <h2>제한값</h2>
      <table>
        <tbody>
          <tr><th>ZIP 파일 크기</th><td>{LIMITS.zipBytes / MB}MB</td></tr>
          <tr><th>ZIP 안의 항목 수 (제외 대상 포함)</th><td>{LIMITS.entries.toLocaleString()}개</td></tr>
          <tr><th>분석 대상 파일 수</th><td>{LIMITS.files.toLocaleString()}개</td></tr>
          <tr><th>분석 대상 파일 하나의 해제 크기</th><td>{LIMITS.fileBytes / MB}MB (넘으면 그 파일만 제외)</td></tr>
          <tr><th>분석 대상 파일 해제 크기 합계</th><td>{LIMITS.totalBytes / MB}MB</td></tr>
        </tbody>
      </table>
      <p className="muted">해제 크기는 ZIP에 적힌 값이 아니라 실제로 풀린 바이트 수로 셉니다. 적힌 크기보다 더 풀리면 압축 폭탄으로 보고 중단합니다.</p>
      <h2>제외 대상</h2>
      <ul>
        <li>폴더: {EXCLUDED_DIRS.join(', ')}</li>
        <li>환경 변수·인증 정보로 보이는 파일: .env*, *.pem, *.key, id_rsa, .npmrc, 이름에 secret·credential·password가 든 파일 등</li>
        <li>위험한 항목: 절대 경로, 상위 폴더로 벗어나는 경로(..), 심볼릭 링크, 같은 경로 중복, 암호화된 항목</li>
        <li>분석 범위 밖 형식: {ANALYZED_EXT.join(', ')} 이외의 모든 파일, 그리고 NUL 바이트가 있거나 UTF-8이 아닌 파일</li>
      </ul>
      <p className="warn-box">제외된 파일이 안전하다는 뜻은 아닙니다. VibeInspect가 그 파일을 확인하지 않았다는 뜻입니다.</p>
      <h2>자동 분석이 읽는 것</h2>
      <ul>
        <li>JSX의 onClick·onChange 등 이벤트에 직접 연결된 함수, 인라인 화살표 함수 안의 직접 호출</li>
        <li>같은 파일 또는 상대 경로 import로 확정할 수 있는 함수 호출 (TypeScript 심볼 해석 기준)</li>
        <li>useState의 setter 호출, 다른 파일의 최상위 값 참조, JSX로 그리는 컴포넌트</li>
        <li>react-router의 &lt;Route path&gt;, &lt;Link&gt;/&lt;NavLink&gt;/&lt;Navigate to&gt;, useNavigate()에 적힌 고정 경로</li>
      </ul>
      <h2>확정하지 않는 것</h2>
      <ul>
        <li>훅·Context에서 꺼낸 함수, props로 받은 함수 → <b>확인 필요</b></li>
        <li>obj[key]() 같은 동적 호출, 식으로 정해지는 경로, fetch 등 외부 서비스, 찾지 못한 import → <b>분석하지 못함</b></li>
        <li>클래스로 만든 컴포넌트, 경로 별칭(@/…, ~/…)으로 가져온 함수 → <b>분석하지 못함</b>(안을 따라가지 않음)</li>
        <li>obj.method() 형태의 외부·내장 메서드 호출, 외부 패키지 내부, .js/.jsx 파일은 표시하지 않습니다.</li>
        <li>문법 오류가 있는 파일은 TypeScript가 최대한 읽지만, 그 파일의 연결은 빠지거나 틀릴 수 있습니다. 분석 범위에 파일과 줄을 표시합니다.</li>
        <li>React의 렌더링·조건 분기·상태 업데이트 순서는 실행해 보지 않고는 알 수 없습니다. 흐름 화면의 단계 순서는 읽기 순서입니다.</li>
      </ul>
    </main>
  );
}
