import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import Canvas, { type CanvasEdge, type CardData } from './Canvas';
import CodePanel from './CodePanel';
import AiPanel, { AiBoundary } from './AiPanel';
import type { CodeLocation, FlowRelationKind, NodeKind, ProjectAnalysis, Provenance, StructureRelationKind, Verification } from './model';
import { UI_KEY, loadJSON, resolveLocation, saveJSON, viewKey } from './lib';
import { buildOutline, parseSummary, subAnalysis } from './ai/mapGuide';
import { sendMap } from './ai/context';

const PROVENANCE: Record<Provenance, string> = { 'manual-example': '수동 예제', 'static-analysis': '정적 분석', 'ai-inferred': 'AI 추정' };
const KIND: Record<NodeKind, { label: string; col: number }> = {
  module: { label: '파일 최상위', col: 0 }, routing: { label: '주소·접근', col: 0 }, page: { label: '화면', col: 1 }, ui: { label: '화면 조각', col: 2 },
  event: { label: '버튼 동작', col: 3 }, state: { label: '정보 보관', col: 4 }, logic: { label: '계산·처리', col: 5 },
  data: { label: '데이터', col: 6 }, gap: { label: '추적 끊김', col: 6 },
};
// 단조로운 색: 종류는 선 모양으로 구분하고, 끊긴 지점만 강조색을 쓴다
const INK = '#252525', GREY = '#8a857f', LIGHT = '#bdb7b0', RED = '#c0060f';
type EdgeStyle = { label: string; color: string; dash?: string };
const MAP_EDGE: Record<StructureRelationKind, EdgeStyle> = {
  navigate: { label: '화면 이동', color: INK },
  call: { label: '기능 실행', color: GREY },
  event: { label: '이벤트 연결', color: INK, dash: '8 3' },
  setState: { label: '상태 변경', color: GREY, dash: '8 3' },
  data: { label: '정보 사용', color: GREY, dash: '2 3' },
  render: { label: '화면에 표시', color: LIGHT },
  unresolved: { label: '확인 필요 · 분석하지 못함', color: RED, dash: '4 4' },
};
const FLOW_EDGE: Record<FlowRelationKind, EdgeStyle> = {
  precondition: { label: '선행 조건', color: INK },
  feeds: { label: '값 전달', color: GREY },
  rerender: { label: '다시 그림·다시 계산', color: GREY, dash: '6 4' },
  call: MAP_EDGE.call, event: MAP_EDGE.event, setState: MAP_EDGE.setState, navigate: MAP_EDGE.navigate,
  data: MAP_EDGE.data, render: MAP_EDGE.render, gap: MAP_EDGE.unresolved,
};

const MAP_HINT = '선은 서로 이어져 있다는 뜻이고, 시간 순서는 아닙니다. 빨간 점선은 코드만으로 확실히 알 수 없는 곳입니다.';
const svg = (d: ReactNode) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>;
const ICON = {
  map: svg(<><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" /></>),
  files: svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>),
};

interface UiState { panelWidth: number; collapsed: boolean; tab?: 'code' | 'ai' }
/** 보던 화면(지도/흐름)과 단계는 프로젝트마다 따로 저장한다 */
interface ViewState { view: string; step: number }
type Sel = { id: string; type: 'node' | 'edge' } | null;

export default function App({ analysis: base, files }: { analysis: ProjectAnalysis; files: Record<string, string> }) {
  const manual = base.provenance === 'manual-example';
  // ── AI 구조 지도 (올린 프로젝트일 때). 정적 분석은 재료로만 쓰고, 화면에는 AI가 정리한 두 단계 지도를 보여 준다 ──
  // 1단계 큰 주제 → 두 번 누르면 2단계 작은 주제(그때 AI에 요청). 결과는 같은 ZIP을 다시 올릴 때를 위해 저장한다.
  const auto = !manual;
  const cacheKey = `vibeinspect:v1:aimap:${base.project.id}`;
  const [ai, setAi] = useState<{ top?: ProjectAnalysis; details: Record<string, ProjectAnalysis> }>(() => (auto && loadJSON(cacheKey)) || { details: {} });
  useEffect(() => { if (ai.top) saveJSON(cacheKey, ai); }, [ai, cacheKey]);
  const [topic, setTopic] = useState<string | null>(null);
  const [rawMap, setRawMap] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [mapErr, setMapErr] = useState<string | null>(null);
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const mapAbort = useRef<AbortController | null>(null);
  useEffect(() => () => mapAbort.current?.abort(), []);
  const outline = useMemo(() => (auto ? buildOutline(base) : null), [auto, base]);
  const aiMode = auto && !rawMap;
  const a = !aiMode ? base : (topic && ai.details[topic]) || ai.top || base;
  const level = aiMode && ai.top ? (topic ? 2 : 1) : 0;

  const runMap = async (src: ProjectAnalysis, o: { text: string; ids: string[] }, lv: 'top' | 'detail', suffix: string, what: string) => {
    mapAbort.current = new AbortController();
    setBusy(what); setMapErr(null);
    const r = await sendMap(o.text, lv, mapAbort.current.signal);
    const s = r.ok ? parseSummary(r.text, src, o.ids, suffix) : r.message;
    setBusy(null);
    if (typeof s === 'string') { setMapErr(s); return null; }
    return s;
  };
  const startMap = async () => {
    const s = outline && await runMap(base, outline, 'top', 'ai', 'AI가 프로젝트 구조를 읽는 중입니다. 보통 10~30초 걸립니다.');
    if (s) setAi({ top: s, details: {} });
  };
  const openTopic = async (id: string) => {
    if (level !== 1 || busy) return;
    const t = ai.top!.nodes.find((n) => n.id === id);
    if (!t?.members) return;
    if (!ai.details[id]) {
      const sub = subAnalysis(base, t.members);
      const s = await runMap(sub, buildOutline(sub), 'detail', `ai:${id}`, `${t.title} 안을 자세히 정리하는 중입니다.`);
      if (!s) return;
      setAi((x) => ({ ...x, details: { ...x.details, [id]: s } }));
    }
    setTopic(id); setSel(null);
  };
  const hasValid = (locs: CodeLocation[]) => locs.some((l) => resolveLocation(l, files).ok);
  const [ui, setUi] = useState<UiState>(() => {
    const { panelWidth = 520, collapsed = false, tab } = loadJSON<UiState>(UI_KEY) ?? {};
    return { panelWidth, collapsed, tab };
  });
  const [vs, setVs] = useState<ViewState>(() => ({ view: 'map', step: 0, ...loadJSON<ViewState>(viewKey(a.project.id)) }));
  const patch = (p: Partial<UiState & ViewState>) => {
    const { view, step, ...rest } = p;
    if (view !== undefined || step !== undefined) setVs((v) => ({ view: view ?? v.view, step: step ?? v.step }));
    if (Object.keys(rest).length) setUi((u) => ({ ...u, ...rest }));
  };
  useEffect(() => { saveJSON(UI_KEY, ui); }, [ui]);
  useEffect(() => { saveJSON(viewKey(a.project.id), vs); }, [vs, a.project.id]);

  const flow = a.flows.find((f) => f.id === vs.view);
  const view = flow ? flow.id : 'map';
  const step = flow ? Math.min(Math.max(vs.step, 0), flow.steps.length - 1) : 0;
  const [sel, setSel] = useState<Sel>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  // ── 캔버스 데이터 ──
  const mapItems = useMemo(() => a.nodes.map((n) => {
    const feature = a.features.find((f) => f.entryNodeId === n.id);
    const data: CardData = {
      title: n.title, chip: level === 1 ? '큰 주제' : KIND[n.kind].label, chipClass: n.kind, summary: n.summary,
      badge: level === 1 ? '두 번 눌러 자세히' : feature ? (manual ? `기능: ${feature.title}` : '흐름 있음') : undefined,
      warn: n.kind === 'gap' ? '추적 끊김' : hasValid(n.locations) ? undefined : '연결 위치 확인 불가',
    };
    return { id: n.id, data };
  }), [a, files, level]);
  const mapEdges = useMemo<CanvasEdge[]>(() => a.relations.map((r) => ({ id: r.id, from: r.from, to: r.to, ...MAP_EDGE[r.kind], label: r.label })), [a]);
  const flowItems = useMemo(() => flow?.steps.map((s, i) => ({
    id: s.id,
    data: {
      title: s.title, chip: '단계', chipClass: 'step', step: i + 1,
      warn: s.verification.status === 'unconfirmed' ? (manual ? '연결 위치 확인 불가' : '확인 필요') : hasValid(s.locations) ? undefined : '연결 위치 확인 불가',
    } as CardData,
  })) ?? [], [flow, files]);
  const flowEdges = useMemo<CanvasEdge[]>(() => flow?.relations.map((r) => ({
    id: r.id, from: r.from, to: r.to, ...FLOW_EDGE[r.kind], label: r.label, animated: r.kind === 'rerender',
  })) ?? [], [flow]);

  const nodeTitle = (id: string) => a.nodes.find((n) => n.id === id)?.title ?? id;
  const tab = ui.tab ?? 'code';
  // ── 선택된 항목 → 코드 패널 ──
  let panel: { key: string; title: string; desc: string; explain?: string; note?: string; action?: ReactNode; locations: CodeLocation[]; verification?: Verification } | null = null;
  if (flow) {
    const s = flow.steps[step];
    panel = { key: s.id, title: `${step + 1}. ${s.title}`, desc: `흐름 '${flow.title}'의 ${step + 1}단계. ${s.explanation}`, note: `${PROVENANCE[s.provenance]} · ${s.explanation}`, locations: s.locations, verification: s.verification };
  } else if (sel?.type === 'node') {
    const n = a.nodes.find((x) => x.id === sel.id);
    const f = n && a.features.find((x) => x.entryNodeId === n.id && x.flowId);
    if (n) panel = {
      key: n.id, title: n.title, desc: `${KIND[n.kind].label}. ${n.summary}`, explain: n.summary, note: `${KIND[n.kind].label} · ${PROVENANCE[n.provenance]} · ${n.summary}`,
      action: f && <button className="primary sm" onClick={() => openFlow(f.flowId!)}>▶ 동작 흐름 보기</button>,
      locations: n.locations, verification: n.verification,
    };
  } else if (sel?.type === 'edge') {
    const r = a.relations.find((x) => x.id === sel.id);
    // 그릴 때 실행되는 관계인지, 이벤트 같은 계기가 있어야 일어나는 관계인지 구분한다
    const when = manual || !r || r.kind === 'render' ? '' : r.trigger ? ` · 계기: ${r.trigger}` : ' · 화면을 그릴 때';
    if (r) panel = { key: r.id, title: level > 0 ? r.label : `${MAP_EDGE[r.kind].label}: ${r.label}`, desc: `${nodeTitle(r.from)} → ${nodeTitle(r.to)} 연결선. ${r.label}`,
      explain: `${nodeTitle(r.from)} 다음에 ${nodeTitle(r.to)} 쪽이 이어집니다.`,
      note: `${nodeTitle(r.from)} → ${nodeTitle(r.to)}${when}`, locations: r.locations };
  }

  const goStep = (i: number) => {
    if (!flow) return;
    const n = Math.min(Math.max(i, 0), flow.steps.length - 1);
    patch({ step: n });
    setFocusId(flow.steps[n].id);
  };
  const openFlow = (flowId: string) => { setPlaying(false); patch({ view: flowId, step: 0 }); setFocusId(null); };
  const backToMap = () => { setPlaying(false); patch({ view: 'map' }); setFocusId(null); };

  // 재생: 읽기 순서대로 단계를 넘긴다 (실제 실행 기록 아님)
  useEffect(() => {
    if (!playing || !flow) return;
    if (step >= flow.steps.length - 1) { setPlaying(false); return; }
    const t = setTimeout(() => goStep(step + 1), 3500);
    return () => clearTimeout(t);
  });

  // ── 패널 너비 조절 ──
  const mainRef = useRef<HTMLDivElement>(null);
  const clampW = (w: number) => Math.round(Math.min(Math.max(w, 320), (mainRef.current?.clientWidth ?? 1200) - 360));
  const dragging = useRef(false);
  const onDrag = (e: RPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const right = mainRef.current!.getBoundingClientRect().right;
    patch({ panelWidth: clampW(right - e.clientX) });
  };

  // 실제로 쓰인 선 종류만 범례에 보여 준다
  const usedKinds = new Set<string>(flow ? flow.relations.map((r) => r.kind) : a.relations.map((r) => r.kind));
  const legend = Object.entries(flow ? FLOW_EDGE : MAP_EDGE).filter(([k]) => usedKinds.has(k)).map(([, v]) => v);

  return (
    <div className="app">
      {!!a.scope?.parseErrors?.length && (
        <div className="notice-bar warn" role="status">
          ⚠ 문법 오류 파일 {a.scope.parseErrors.length}개 — 그 파일의 연결은 빠졌거나 틀렸을 수 있습니다.
        </div>
      )}

      <div className={`main${ui.collapsed ? ' collapsed' : ''}`} ref={mainRef} style={{ ['--panel-w' as string]: `${ui.collapsed ? 44 : ui.panelWidth}px` }}>
        <div className="map-side">
          <nav className="crumbs" aria-label="현재 위치">
            {flow ? (
              <>
                <button className="icon-btn" onClick={backToMap} title="전체 지도로 돌아가기" aria-label="전체 지도로 돌아가기">{ICON.map}</button>
                <strong>{flow.title}</strong>
                <span className="caveat-i" tabIndex={0} title={flow.caveat} aria-label={flow.caveat}>ⓘ</span>
                <span className="step-nav" aria-live="polite">
                  <button className="icon-btn" onClick={() => goStep(step - 1)} disabled={step === 0} title="이전 단계" aria-label="이전 단계">‹</button>
                  <span className="muted">{step + 1} / {flow.steps.length}</span>
                  <button className="icon-btn" onClick={() => goStep(step + 1)} disabled={step === flow.steps.length - 1} title="다음 단계" aria-label="다음 단계">›</button>
                  <button className="icon-btn" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}
                    title={playing ? '멈춤' : '순서대로 보기 (읽기 순서, 실행 기록 아님)'} aria-label={playing ? '멈춤' : '순서대로 보기'}>{playing ? '❚❚' : '▶'}</button>
                </span>
              </>
            ) : (
              <>
                {level === 2 && <button className="icon-btn" onClick={() => { setTopic(null); setSel(null); }} title="전체 구조로 돌아가기" aria-label="전체 구조로 돌아가기">{ICON.map}</button>}
                <strong>{level === 2 ? ai.top!.nodes.find((n) => n.id === topic)?.title : level === 1 ? '전체 구조' : '서비스 전체 지도'}</strong>
                <span className="caveat-i" tabIndex={0} title={MAP_HINT} aria-label={MAP_HINT}>ⓘ</span>
                {a.flows.length > 0 && (
                  <select className="flow-pick" value="" aria-label="동작 흐름 열기" onChange={(e) => e.target.value && openFlow(e.target.value)}>
                    <option value="">▶ 동작 흐름 열기</option>
                    {a.features.filter((f) => f.flowId).map((f) => <option key={f.id} value={f.flowId}>{f.title}</option>)}
                  </select>
                )}
                {auto && rawMap && <button className="sm" onClick={() => { setRawMap(false); setSel(null); }}>AI 정리 보기</button>}
                {level > 0 && <span className="chip prov auto" title={a.notice}>AI가 정리함, 틀릴 수 있음</span>}
              </>
            )}
            <span className="legend" aria-label="연결선 범례">
              {legend.map((l) => (
                <span key={l.label}><svg width="26" height="8" aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke={l.color} strokeWidth="2" strokeDasharray={l.dash} /></svg>{l.label}</span>
              ))}
            </span>
            {a.scope && (
              <details className="pop">
                <summary className="icon-btn" title="분석 범위 (읽은 파일·제외한 파일)" aria-label="분석 범위">{ICON.files}</summary>
                <div className="pop-body"><Scope scope={a.scope} /></div>
              </details>
            )}
          </nav>

          {level > 0 && (busy || mapErr) && (
            <div className="ai-box ai-row" role="status">
              {busy ? <><span>{busy}</span><button className="sm" onClick={() => mapAbort.current?.abort()}>멈추기</button></>
                : <><span className="ai-bad">{mapErr}</span><button className="sm" onClick={() => setMapErr(null)}>닫기</button></>}
            </div>
          )}

          <div className="canvas-wrap">
            {aiMode && !ai.top ? (
              <div className="empty canvas-empty ai-start" role="region" aria-label="AI 구조 정리">
                {busy ? <><strong role="status">{busy}</strong><button className="sm" onClick={() => mapAbort.current?.abort()}>멈추기</button></> : <>
                  <strong>AI가 이 프로젝트의 구조를 쉽게 정리해 드립니다</strong>
                  <p className="muted">코드 내용은 보내지 않고, 파일 위치와 이름 목록만 외부 AI 서비스 ChatKHU로 보냅니다. 큰 주제를 펼칠 때도 그 주제에 속한 목록만 보냅니다. 쓸 때마다 크레딧이 조금 차감됩니다.</p>
                  {outline?.truncated && <p className="ai-bad">프로젝트가 커서 목록의 일부만 보냅니다.</p>}
                  {mapErr && <p className="ai-bad" role="alert">{mapErr}</p>}
                  <div className="ai-row">
                    <button className="primary" onClick={startMap}>AI로 구조 정리하기</button>
                    <button onClick={() => setRawMap(true)}>AI 없이 기본 지도 보기</button>
                  </div>
                  <details><summary>보낼 목록 보기</summary><pre className="ai-pre">{outline?.text}</pre></details>
                </>}
              </div>
            ) : !flow && a.nodes.length === 0 ? (
              <div className="empty canvas-empty" role="status">
                <strong>지도에 표시할 연결을 찾지 못했습니다.</strong>
                <p className="muted">지원하는 패턴(JSX 이벤트, 함수 호출, useState, 화면 이동)이 없었습니다. 오른쪽 위 분석 범위 아이콘에서 읽은 파일을 확인하세요.</p>
              </div>
            ) : flow ? (
              <Canvas projectId={a.project.id} view={view} items={flowItems} edges={flowEdges}
                layoutEdges={flow.relations.filter((r) => r.kind !== 'rerender')} showEdgeLabels
                selectedId={flow.steps[step].id} focusId={focusId}
                onSelect={(id, type) => { if (type === 'node') patch({ step: flow.steps.findIndex((s) => s.id === id) }); }} />
            ) : (
              <Canvas projectId={a.project.id} view="map" items={mapItems} edges={mapEdges}
                layoutEdges={a.relations} columnOf={(id) => KIND[a.nodes.find((n) => n.id === id)!.kind].col} showEdgeLabels={false}
                selectedId={sel?.id ?? null} focusId={focusId} onSelect={(id, type) => setSel({ id, type })}
                onOpen={level === 1 ? openTopic : undefined} />
            )}
          </div>
        </div>

        {!ui.collapsed && (
          <div className="divider" role="separator" aria-orientation="vertical" aria-label="코드 패널 너비 조절" tabIndex={0}
            aria-valuenow={ui.panelWidth} aria-valuemin={320}
            onPointerDown={(e) => { dragging.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 캡처 실패해도 드래그는 동작 */ } }}
            onPointerMove={onDrag} onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') patch({ panelWidth: clampW(ui.panelWidth + 32) });
              if (e.key === 'ArrowRight') patch({ panelWidth: clampW(ui.panelWidth - 32) });
            }} />
        )}

        <aside className={`code-side${ui.collapsed ? ' collapsed' : ''}`}>
          <div className="side-bar">
            {!ui.collapsed && (
              <div className="side-tabs" role="tablist" aria-label="오른쪽 패널">
                <button role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'on' : ''} onClick={() => patch({ tab: 'code' })}>{level > 0 ? '설명' : '코드'}</button>
                <button role="tab" aria-selected={tab === 'ai'} className={tab === 'ai' ? 'on' : ''} onClick={() => patch({ tab: 'ai' })}>AI</button>
              </div>
            )}
            <button className="icon-btn collapse" onClick={() => patch({ collapsed: !ui.collapsed })} aria-expanded={!ui.collapsed}
              title={ui.collapsed ? '코드 패널 펼치기' : '코드 패널 접기'} aria-label={ui.collapsed ? '코드 패널 펼치기' : '코드 패널 접기'}>
              {ui.collapsed ? '‹' : '›'}
            </button>
          </div>
          {!ui.collapsed && tab === 'code' && (panel
            ? level > 0 && codeFor !== panel.key
              // AI 지도에서는 쉬운 설명을 먼저 보여 주고, 코드는 원할 때만 연다
              ? <div className="ai-pad explain">
                  <h3>{panel.title}</h3>
                  <p>{panel.explain}</p>
                  <div className="ai-row">
                    {level === 1 && sel?.type === 'node' && <button className="primary sm" disabled={!!busy} onClick={() => openTopic(sel.id)}>자세히 보기</button>}
                    <button className="sm" onClick={() => setCodeFor(panel!.key)}>실제 코드 보기</button>
                  </div>
                </div>
              : <CodePanel key={panel.key} title={panel.title} note={panel.note} action={panel.action} locations={panel.locations} verification={panel.verification} files={files} />
            : <div className="empty">카드를 선택하면 코드가 열립니다.</div>)}
          {/* 탭을 바꿔도 답변이 사라지지 않게 숨기기만 한다. 선택 항목이 바뀌면 새로 시작한다(다시 동의 필요). */}
          {!ui.collapsed && (
            <div className="ai-wrap" hidden={tab !== 'ai'}>
              <AiBoundary>
                <AiPanel key={panel?.key ?? 'none'} target={panel && { title: panel.title, description: panel.desc, locations: panel.locations, gap: panel.verification?.status === 'unconfirmed' }} files={files} />
              </AiBoundary>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Scope({ scope }: { scope: NonNullable<ProjectAnalysis['scope']> }) {
  const byReason: Record<string, number> = {};
  for (const e of scope.excluded) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  return (
    <div className="scope">
      <h3>분석 범위</h3>
      <p className="muted">제외한 파일은 확인하지 않았다는 뜻이며, 안전하다는 뜻이 아닙니다.</p>
      {!!scope.parseErrors?.length && (
        <div className="warn-box">
          문법 오류 파일 {scope.parseErrors.length}개
          <ul className="file-list">{scope.parseErrors.map((e) => <li key={e.file}><code>{e.file}:{e.line}</code> <span className="muted">{e.message}</span></li>)}</ul>
        </div>
      )}
      <details>
        <summary>분석한 파일 {scope.analyzedFiles.length}개</summary>
        <ul className="file-list">{scope.analyzedFiles.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
      </details>
      {scope.excluded.length > 0 && (
        <details>
          <summary>제외한 파일 {scope.excluded.length}개 — {Object.entries(byReason).map(([r, n]) => `${r} ${n}`).join(' · ')}</summary>
          <ul className="file-list">
            {scope.excluded.slice(0, 300).map((e, i) => <li key={i}><code>{e.path}</code> <span className="muted">{e.reason}</span></li>)}
            {scope.excluded.length > 300 && <li className="muted">… 외 {scope.excluded.length - 300}개</li>}
          </ul>
        </details>
      )}
    </div>
  );
}
