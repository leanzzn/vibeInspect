import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testCodeExample as a } from './data/testCodeExample';
import { autoLayout, layoutKey, loadJSON, mergeLayout, resolveLocation, saveJSON, sourceFiles } from './lib';
import type { CodeLocation } from './model';

const allLocations: CodeLocation[] = [
  ...a.nodes.flatMap((n) => n.locations),
  ...a.relations.flatMap((r) => r.locations),
  ...a.flows.flatMap((f) => f.steps.flatMap((s) => s.locations)),
];

describe('수동 예제 ↔ 실제 소스', () => {
  it('src 파일을 읽어 왔다', () => {
    expect(Object.keys(sourceFiles)).toContain('src/pages/ScholarshipsPage.tsx');
  });

  it('번들된 소스가 압축 해제한 원본 파일과 같다', () => {
    for (const [file, text] of Object.entries(sourceFiles)) {
      const disk = readFileSync(`samples/test_code/${file}`, 'utf8').replace(/\r\n/g, '\n');
      expect(text, file).toBe(disk);
    }
  });

  it.each(allLocations.map((l) => [`${l.file}:${l.startLine}-${l.endLine} ${l.label}`, l] as const))('%s 가 실제 코드와 일치', (_, l) => {
    const r = resolveLocation(l);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
  });

  it('관계와 기능이 존재하는 id만 가리킨다', () => {
    const ids = new Set(a.nodes.map((n) => n.id));
    for (const r of a.relations) expect(ids.has(r.from) && ids.has(r.to), r.id).toBe(true);
    for (const f of a.features) expect(ids.has(f.entryNodeId), f.id).toBe(true);
    for (const flow of a.flows) {
      const steps = new Set(flow.steps.map((s) => s.id));
      for (const r of flow.relations) expect(steps.has(r.from) && steps.has(r.to), r.id).toBe(true);
      expect(a.features.some((f) => f.flowId === flow.id)).toBe(true);
    }
  });

  it('위치가 없는 단계는 미확인 사유를 갖는다', () => {
    for (const s of a.flows.flatMap((f) => f.steps)) {
      if (s.locations.length === 0) expect(s.verification.status === 'unconfirmed' && !!s.verification.reason, s.id).toBe(true);
    }
  });
});

describe('resolveLocation 거부 사례', () => {
  const files = { 'src/a.ts': 'one\ntwo\nthree' };
  const base = { file: 'src/a.ts', startLine: 2, endLine: 3, label: 'x', anchor: 'two' };
  it('정상', () => expect(resolveLocation(base, files).ok).toBe(true));
  it('없는 파일', () => expect(resolveLocation({ ...base, file: 'src/b.ts' }, files).ok).toBe(false));
  it('범위 초과', () => expect(resolveLocation({ ...base, endLine: 4 }, files).ok).toBe(false));
  it('0번 줄', () => expect(resolveLocation({ ...base, startLine: 0 }, files).ok).toBe(false));
  it('시작 > 끝', () => expect(resolveLocation({ ...base, startLine: 3, endLine: 2 }, files).ok).toBe(false));
  it('앵커 불일치 (줄 어긋남)', () => expect(resolveLocation({ ...base, startLine: 3 }, files).ok).toBe(false));
});

describe('배치 저장·복원', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it('프로젝트·보기별로 분리 저장되고 복원된다', () => {
    const s = mem();
    saveJSON(layoutKey('p', 'map'), { positions: { a: { x: 1, y: 2 } }, viewport: { x: 0, y: 0, zoom: 1.5 } }, s);
    saveJSON(layoutKey('p', 'flow-x'), { positions: { a: { x: 9, y: 9 } } }, s);
    expect(loadJSON<any>(layoutKey('p', 'map'), s).positions.a).toEqual({ x: 1, y: 2 });
    expect(loadJSON<any>(layoutKey('p', 'flow-x'), s).positions.a).toEqual({ x: 9, y: 9 });
    expect(loadJSON(layoutKey('q', 'map'), s)).toBeNull();
  });

  it('깨진 값·예외에도 죽지 않는다', () => {
    expect(loadJSON('k', { getItem: () => '{bad' })).toBeNull();
    expect(() => saveJSON('k', 1, { setItem: () => { throw new Error('full'); } })).not.toThrow();
  });

  it('저장 좌표는 아는 노드에만 적용, 새 노드는 자동 배치', () => {
    const auto = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } };
    expect(mergeLayout(auto, { positions: { a: { x: 5, y: 6 }, gone: { x: 1, y: 1 } } })).toEqual({ a: { x: 5, y: 6 }, b: { x: 300, y: 0 } });
  });

  it('자동 배치는 모든 노드에 좌표를 주고 순환에도 끝난다', () => {
    const pos = autoLayout(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }]);
    expect(Object.keys(pos)).toHaveLength(3);
    const chain = autoLayout(['a', 'b'], [{ from: 'a', to: 'b' }]);
    expect(chain.b.x).toBeGreaterThan(chain.a.x);
  });

  it('긴 열은 옆으로 접히고 다음 열과 겹치지 않는다', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const pos = autoLayout(ids, [], (id) => (id === 'd' ? 1 : 0), 2);
    expect(pos.c).toEqual({ x: 300, y: 0 });
    expect(pos.d.x).toBe(600);
  });
});
