import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import Canvas, { type CanvasEdge, type CardData } from './Canvas';
import CodePanel from './CodePanel';
import ChatPanel, { AiBoundary } from './ChatPanel';
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

interface UiState { panelWidth: number; collapsed: boolean }
/** 보던 화면(지도/흐름)과 단계는 프로젝트마다 따로 저장한다 */
interface ViewState { view: string; step: number }
type Sel = { id: string; type: 'node' | 'edge' } | null;

export default function App({ analysis: base, files }: { analysis: ProjectAnalysis; files: Record<string, string> }) {
  const manual = base.provenance === 'manual-example';
  // ── AI 구조 지도 (올린 프로젝트일 때). 정적 분석은 재료로만 쓰고(화면에 보이지 않음), 올리자마자 AI가 정리한 지도를 보여 준다 ──
  // 카드를 두 번 누르면 그 카드에 묶인 세부 항목으로 "세부 구조" 지도를 만든다(그때 AI에 요청).
  // 결과는 같은 ZIP을 다시 올릴 때를 위해 저장한다.
  const auto = !manual;
  const cacheKey = `vibeinspect:v4:aimap:${base.project.id}`;
  const [ai, setAi] = useState<ProjectAnalysis | null>(() => (auto && loadJSON<ProjectAnalysis>(cacheKey)) || null);
  useEffect(() => { if (ai) saveJSON(cacheKey, ai); }, [ai, cacheKey]);
  const [details, setDetails] = useState<Record<string, ProjectAnalysis>>(() => (auto && loadJSON(`${cacheKey}:detail`)) || {});
  useEffect(() => { saveJSON(`${cacheKey}:detail`, details); }, [details, cacheKey]);
  const [topic, setTopic] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  useEffect(() => () => detailAbort.current?.abort(), []);
  const [rawMap, setRawMap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mapErr, setMapErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const mapAbort = useRef<AbortController | null>(null);
  const aiMode = auto && !rawMap;
  const a = !aiMode ? base : (topic && details[topic]) || ai || base;
  const topLevel = aiMode && !!ai && !topic;

  const openTopic = async (id: string) => {
    if (!topLevel || detailBusy) return;
    const t = ai!.nodes.find((n) => n.id === id);
    if (!t?.members) return;
    if (!details[id]) {
      const sub = subAnalysis(base, t.members), o = buildOutline(sub);
      const c = new AbortController();
      detailAbort.current = c;
      setDetailBusy(`'${t.title}' 안의 세부 구조를 정리하는 중입니다.`); setDetailErr(null);
      const r = await sendMap(o.text, 'detail', c.signal);
      setDetailBusy(null);
      if (c.signal.aborted) return;
      const s = r.ok ? parseSummary(r.text, sub, o.ids, `ai:${id}`) : r.message;
      if (typeof s === 'string') { setDetailErr(s); return; }
      setDetails((d) => ({ ...d, [id]: s }));
    }
    setTopic(id); setSel(null);
  };

  useEffect(() => {
    if (!auto || ai) return;
    const c = new AbortController();
    mapAbort.current = c;
    (async () => {
      const o = buildOutline(base);
      setBusy(true); setMapErr(null);
      const r = await sendMap(o.text, 'top', c.signal);
      if (c.signal.aborted) return; // 화면을 떠났거나 멈추기를 눌렀다
      const s = r.ok ? parseSummary(r.text, base, o.ids) : r.message;
      setBusy(false);
      if (typeof s === 'string') setMapErr(s); else setAi(s);
    })();
    return () => c.abort();
  }, [auto, base, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const stopMap = () => { mapAbort.current?.abort(); setBusy(false); setMapErr('요청을 취소했습니다.'); };
  const [chatOpen, setChatOpen] = useState(false);
  const hasValid = (locs: CodeLocation[]) => locs.some((l) => resolveLocation(l, files).ok);
  const [ui, setUi] = useState<UiState>(() => {
    const { panelWidth = 520, collapsed = false } = loadJSON<UiState>(UI_KEY) ?? {};
    return { panelWidth, collapsed };
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
      title: n.title, chip: KIND[n.kind].label, chipClass: n.kind, summary: n.summary, intro: n.intro,
      badge: feature ? (manual ? `기능: ${feature.title}` : '흐름 있음') : undefined,
      warn: n.kind === 'gap' ? '추적 끊김' : hasValid(n.locations) ? undefined : '연결 위치 확인 불가',
    };
    return { id: n.id, data };
  }), [a, files]);
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
  // ── 선택된 항목 → 코드 패널 ──
  let panel: { key: string; title: string; note?: string; action?: ReactNode; locations: CodeLocation[]; verification?: Verification } | null = null;
  if (flow) {
    const s = flow.steps[step];
    panel = { key: s.id, title: `${step + 1}. ${s.title}`, note: `${PROVENANCE[s.provenance]} · ${s.explanation}`, locations: s.locations, verification: s.verification };
  } else if (sel?.type === 'node') {
    const n = a.nodes.find((x) => x.id === sel.id);
    const f = n && a.features.find((x) => x.entryNodeId === n.id && x.flowId);
    if (n) panel = {
      key: n.id, title: n.title, note: `${n.intro ? `${n.intro} · ` : ''}${KIND[n.kind].label} · ${PROVENANCE[n.provenance]} · ${n.summary}`,
      action: f ? <button className="primary sm" onClick={() => openFlow(f.flowId!)}>▶ 동작 흐름 보기</button>
        : topLevel && n.members ? <button className="primary sm" disabled={!!detailBusy} onClick={() => openTopic(n.id)}>세부 구조 보기</button> : undefined,
      locations: n.locations, verification: n.verification,
    };
  } else if (sel?.type === 'edge') {
    const r = a.relations.find((x) => x.id === sel.id);
    // 그릴 때 실행되는 관계인지, 이벤트 같은 계기가 있어야 일어나는 관계인지 구분한다
    const when = manual || !r || r.kind === 'render' || r.provenance === 'ai-inferred' ? '' : r.trigger ? ` · 계기: ${r.trigger}` : ' · 화면을 그릴 때';
    if (r) panel = { key: r.id, title: `${MAP_EDGE[r.kind].label}: ${r.label}`, note: `${nodeTitle(r.from)} → ${nodeTitle(r.to)}${when}`, locations: r.locations };
  }
  const mapSummary = useMemo(() => [
    ...a.nodes.slice(0, 40).map((n) => `- ${n.title}: ${n.summary}`),
    ...a.relations.slice(0, 40).map((r) => `- ${nodeTitle(r.from)} → ${nodeTitle(r.to)}: ${r.label}`),
  ].join('\n'), [a]); // eslint-disable-line react-hooks/exhaustive-deps

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

      <div className="work">
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
                {aiMode && topic && <button className="icon-btn" onClick={() => { setTopic(null); setSel(null); }} title="전체 지도로 돌아가기" aria-label="전체 지도로 돌아가기">{ICON.map}</button>}
                <strong>{aiMode && topic ? `${ai?.nodes.find((n) => n.id === topic)?.title ?? ''} 세부 구조` : '서비스 전체 지도'}</strong>
                <span className="caveat-i" tabIndex={0} title={MAP_HINT} aria-label={MAP_HINT}>ⓘ</span>
                {a.flows.length > 0 && (
                  <select className="flow-pick" value="" aria-label="동작 흐름 열기" onChange={(e) => e.target.value && openFlow(e.target.value)}>
                    <option value="">▶ 동작 흐름 열기</option>
                    {a.features.filter((f) => f.flowId).map((f) => <option key={f.id} value={f.flowId}>{f.title}</option>)}
                  </select>
                )}
                {auto && rawMap && <button className="sm" onClick={() => { setRawMap(false); setSel(null); }}>AI 정리 보기</button>}
                {aiMode && ai && <span className="chip prov auto" title={a.notice}>AI가 정리함, 틀릴 수 있음</span>}
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

          {(detailBusy || detailErr) && (
            <div className="ai-box ai-row" role="status">
              {detailBusy ? <><span>{detailBusy}</span><button className="sm" onClick={() => { detailAbort.current?.abort(); setDetailBusy(null); }}>멈추기</button></>
                : <><span className="ai-bad">{detailErr}</span><button className="sm" onClick={() => setDetailErr(null)}>닫기</button></>}
            </div>
          )}

          <div className="canvas-wrap">
            {aiMode && !ai ? (
              <div className="empty canvas-empty ai-start" role="region" aria-label="AI 구조 정리">
                {busy ? <>
                  <strong role="status">AI가 코드 흐름 분석 결과를 정리하는 중입니다. 보통 10~30초 걸립니다.</strong>
                  <p className="muted">코드 내용은 보내지 않고, 정적 분석으로 찾은 이름·위치 목록만 외부 AI 서비스 ChatKHU로 보냅니다.</p>
                  <div className="ai-row"><button className="sm" onClick={stopMap}>멈추기</button></div>
                </> : <>
                  <strong>AI 정리를 하지 못했습니다</strong>
                  {mapErr && <p className="ai-bad" role="alert">{mapErr}</p>}
                  <div className="ai-row">
                    <button className="primary" onClick={() => setAttempt((n) => n + 1)}>다시 시도</button>
                    <button onClick={() => setRawMap(true)}>AI 없이 기본 지도 보기</button>
                  </div>
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
                onOpen={topLevel ? openTopic : undefined} />
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
            {!ui.collapsed && <span className="side-tabs muted">연결된 코드</span>}
            <button className="icon-btn collapse" onClick={() => patch({ collapsed: !ui.collapsed })} aria-expanded={!ui.collapsed}
              title={ui.collapsed ? '코드 패널 펼치기' : '코드 패널 접기'} aria-label={ui.collapsed ? '코드 패널 펼치기' : '코드 패널 접기'}>
              {ui.collapsed ? '‹' : '›'}
            </button>
          </div>
          {!ui.collapsed && (panel
            ? <CodePanel key={panel.key} title={panel.title} note={panel.note} action={panel.action} locations={panel.locations} verification={panel.verification} files={files} />
            : <div className="empty">카드를 선택하면 코드가 열립니다.</div>)}
        </aside>
      </div>
      {/* 크롬의 사이드 패널처럼 오른쪽에 열린다. 닫아도 대화는 남는다 */}
      <div className="chat-slot" hidden={!chatOpen}>
        <AiBoundary>
          <ChatPanel mapSummary={mapSummary} target={panel && { title: panel.title, locations: panel.locations }} files={files} onClose={() => setChatOpen(false)} />
        </AiBoundary>
      </div>
      </div>
      {!chatOpen && <button className="chat-fab" onClick={() => setChatOpen(true)} title="AI에게 물어보기" aria-label="AI 채팅 열기">💬</button>}
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
