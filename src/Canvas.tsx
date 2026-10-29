import { useEffect, useRef, useState } from 'react';
import {
  Background, Controls, Handle, MarkerType, Panel, Position, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges,
  useReactFlow, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { CanvasLayout } from './model';
import { autoLayout, layoutKey, loadJSON, mergeLayout, saveJSON } from './lib';

// 글자가 읽히는 범위에서만 축소한다. 처음에는 100% 크기로 왼쪽 위(지도·흐름의 시작)부터 보여 준다.
const MIN_ZOOM = 0.5, START = { x: 40, y: 40, zoom: 1 };

export interface CardData extends Record<string, unknown> {
  title: string;
  chip: string;
  chipClass: string;
  summary?: string;
  badge?: string;
  warn?: string;
  step?: number;
}
export interface CanvasEdge { id: string; from: string; to: string; label: string; color: string; dash?: string; animated?: boolean }

interface Props {
  projectId: string;
  view: string;
  items: { id: string; data: CardData }[];
  edges: CanvasEdge[];
  layoutEdges: { from: string; to: string }[];
  columnOf?: (id: string) => number;
  showEdgeLabels: boolean;
  selectedId: string | null;
  focusId: string | null;
  onSelect: (id: string, type: 'node' | 'edge') => void;
}

function Card({ data, selected }: NodeProps<Node<CardData>>) {
  return (
    <div className={`card${selected ? ' selected' : ''}${data.warn ? ' warn' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="card-top">
        {data.step !== undefined && <span className="step-no">{data.step}</span>}
        <span className={`chip ${data.chipClass}`}>{data.chip}</span>
        {data.badge && <span className="chip feature">{data.badge}</span>}
      </div>
      <strong className="card-title">{data.title}</strong>
      {data.summary && <p className="card-summary">{data.summary}</p>}
      {data.warn && <p className="card-warn">⚠ {data.warn}</p>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { card: Card };

function toEdge(e: CanvasEdge, showLabel: boolean, selected: boolean): Edge {
  return {
    id: e.id, source: e.from, target: e.to, selected, animated: e.animated,
    label: showLabel || selected ? e.label : undefined,
    style: { stroke: e.color, strokeDasharray: e.dash, strokeWidth: selected ? 3 : 1.6 },
    markerEnd: { type: MarkerType.ArrowClosed, color: e.color },
    labelStyle: { fontSize: 11, fill: '#252525' },
    labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
  };
}

function Inner(p: Props) {
  const key = layoutKey(p.projectId, p.view);
  const rf = useReactFlow();
  const [saved] = useState(() => loadJSON<CanvasLayout>(key));
  // 예전 버전에서 너무 작게 저장된 화면 위치는 쓰지 않는다
  const savedVp = saved?.viewport && saved.viewport.zoom >= MIN_ZOOM ? saved.viewport : undefined;
  const layout = useRef<CanvasLayout>({ positions: {}, viewport: savedVp });
  const auto = () => autoLayout(p.items.map((i) => i.id), p.layoutEdges, p.columnOf);

  const [nodes, setNodes] = useState<Node<CardData>[]>(() => {
    const pos = mergeLayout(auto(), saved);
    return p.items.map((i) => ({ id: i.id, type: 'card', position: pos[i.id], data: i.data, ariaLabel: i.data.title }));
  });
  const [edges, setEdges] = useState<Edge[]>([]);

  // 데이터/선택 변화 반영 (좌표는 유지)
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: p.items.find((i) => i.id === n.id)?.data ?? n.data, selected: n.id === p.selectedId })));
    setEdges(p.edges.map((e) => toEdge(e, p.showEdgeLabels, e.id === p.selectedId)));
  }, [p.items, p.edges, p.selectedId, p.showEdgeLabels]);

  // 좌표가 바뀌면 (드래그·키보드 이동·자동 배치) 잠시 후 저장
  useEffect(() => {
    const t = setTimeout(() => {
      layout.current.positions = Object.fromEntries(nodes.map((n) => [n.id, n.position]));
      saveJSON(key, layout.current);
    }, 250);
    return () => clearTimeout(t);
  }, [nodes, key]);

  useEffect(() => {
    if (!p.focusId) return;
    const n = rf.getNode(p.focusId);
    if (!n) return;
    const w = n.measured?.width ?? 220, h = n.measured?.height ?? 100;
    rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: rf.getZoom(), duration: 300 });
  }, [p.focusId, rf]);

  const onNodesChange = (changes: NodeChange<Node<CardData>>[]) => {
    for (const c of changes) if (c.type === 'select' && c.selected) p.onSelect(c.id, 'node');
    // 선택 해제는 무시: 선택은 다른 항목을 고를 때만 바뀐다
    setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'select'), ns));
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    for (const c of changes) if (c.type === 'select' && c.selected) p.onSelect(c.id, 'edge');
    setEdges((es) => applyEdgeChanges(changes.filter((c) => c.type !== 'select' && c.type !== 'remove'), es));
  };

  const relayout = () => {
    const pos = auto();
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos[n.id] })));
    rf.setViewport(START, { duration: 300 });
  };

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onMoveEnd={(_, vp) => { layout.current.viewport = vp; saveJSON(key, layout.current); }}
      defaultViewport={savedVp ?? START}
      minZoom={MIN_ZOOM}
      maxZoom={2}
      nodesConnectable={false}
      deleteKeyCode={null}
      ariaLabelConfig={{ 'node.a11yDescription.default': '화살표 키로 카드를 옮길 수 있습니다. Enter로 선택합니다.' }}
    >
      <Background gap={20} color="#e2ddd6" />
      <Controls showInteractive={false} position="bottom-left" aria-label="확대·축소 도구" />
      <Panel position="top-right" className="canvas-tools">
        <button className="icon-btn" onClick={() => rf.fitView({ padding: 0.1, minZoom: MIN_ZOOM, duration: 300 })} title="전체 보기" aria-label="전체 보기">⤢</button>
        <button className="icon-btn" onClick={relayout} title="자동 배치 (직접 옮긴 위치 초기화 · 코드는 바뀌지 않음)" aria-label="자동 배치">↻</button>
      </Panel>
    </ReactFlow>
  );
}

/** view가 바뀌면 key로 새로 마운트해 그 보기의 저장된 배치·화면 위치를 복원한다. */
export default function Canvas(p: Props) {
  return (
    <ReactFlowProvider key={`${p.projectId}:${p.view}`}>
      <Inner {...p} />
    </ReactFlowProvider>
  );
}
