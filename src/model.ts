// 분석 결과 형식. 수동 예제와 이후 자동 분석이 같은 형식을 채운다.

/** 이 항목을 누가/어떻게 만들었는가 */
export type Provenance = 'manual-example' | 'static-analysis' | 'ai-inferred';

export interface Verification {
  status: 'confirmed' | 'unconfirmed';
  /** unconfirmed일 때 사람이 읽을 사유 */
  reason?: string;
}

/** 분석 대상 프로젝트 루트 기준 상대 경로 + 1부터 시작하는 줄 범위(양 끝 포함) */
export interface CodeLocation {
  file: string;
  startLine: number;
  endLine: number;
  label: string;
  /** 범위 안에 반드시 있어야 하는 코드 조각. 원본이 바뀌어 줄이 어긋나면 연결 불가로 처리된다. */
  anchor: string;
}

export type NodeKind = 'routing' | 'page' | 'ui' | 'state' | 'logic' | 'data'
  /** 자동 분석 전용: JSX 이벤트에 연결된 함수 / 파일 최상위 코드 / 추적이 끊긴 지점 */
  | 'event' | 'module' | 'gap';

/** 전체 지도의 구성요소 카드 */
export interface MapNode {
  id: string;
  title: string;
  kind: NodeKind;
  summary: string;
  locations: CodeLocation[];
  provenance: Provenance;
  verification: Verification;
}

/** 구조 관계: 시간 순서가 아니다 */
export type StructureRelationKind = 'navigate' | 'call' | 'data' | 'render'
  /** 자동 분석 전용: JSX 이벤트 연결 / React 상태 변경 호출 / 대상을 확정하지 못한 호출 */
  | 'event' | 'setState' | 'unresolved';

export interface StructureRelation {
  id: string;
  from: string;
  to: string;
  kind: StructureRelationKind;
  label: string;
  locations: CodeLocation[];
  provenance: Provenance;
  /** 그릴 때가 아니라 이 이벤트/효과 안에서 일어나는 관계 (예: 'onChange', 'useEffect') */
  trigger?: string;
}

export interface Feature {
  id: string;
  title: string;
  summary: string;
  entryNodeId: string;
  /** 상세 흐름이 아직 구성되지 않은 기능은 비워 둔다 */
  flowId?: string;
}

export interface FlowStep {
  id: string;
  title: string;
  explanation: string;
  locations: CodeLocation[];
  provenance: Provenance;
  verification: Verification;
}

/** 흐름 안의 단계 관계: 읽기 순서 후보이지 실행 기록이 아니다 */
export type FlowRelationKind = 'precondition' | 'feeds' | 'rerender'
  /** 자동 분석 흐름: 구조 관계를 그대로 옮긴 것 */
  | 'call' | 'event' | 'setState' | 'navigate' | 'data' | 'render' | 'gap';

export interface FlowRelation {
  id: string;
  from: string;
  to: string;
  kind: FlowRelationKind;
  label: string;
}

export interface Flow {
  id: string;
  featureId: string;
  title: string;
  caveat: string;
  /** 배열 순서 = 이전/다음 버튼의 읽기 순서 */
  steps: FlowStep[];
  relations: FlowRelation[];
}

export interface ProjectAnalysis {
  project: { id: string; name: string; sourceName: string; stack: string; description: string };
  provenance: Provenance;
  notice: string;
  nodes: MapNode[];
  relations: StructureRelation[];
  features: Feature[];
  flows: Flow[];
  /** 자동 분석일 때: 실제로 읽은 파일과 제외한 파일 */
  scope?: {
    analyzedFiles: string[]; excluded: { path: string; reason: string }[]; entryCount: number;
    /** 문법 오류가 난 파일(파일당 첫 오류). 이 파일에서 찾은 관계는 불완전할 수 있다 */
    parseErrors?: { file: string; line: number; message: string }[];
  };
}

/** 캔버스 배치: 프로젝트 × 보기(지도/흐름)별로 따로 저장 */
export interface CanvasLayout {
  positions: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
}
