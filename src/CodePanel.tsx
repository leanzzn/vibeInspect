import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CodeLocation, Verification } from './model';
import { resolveLocation } from './lib';

interface Props {
  title: string;
  note?: string;
  action?: ReactNode;
  locations: CodeLocation[];
  verification?: Verification;
  files: Record<string, string>;
}

export default function CodePanel({ title, note, action, locations, verification, files }: Props) {
  const [idx, setIdx] = useState(0);
  const firstLine = useRef<HTMLDivElement>(null);
  const resolved = locations.map((l) => resolveLocation(l, files));
  const cur = resolved[Math.min(idx, resolved.length - 1)];

  // 코드 상자 안에서만 스크롤 (페이지 전체는 움직이지 않음)
  useEffect(() => {
    const el = firstLine.current, box = el?.parentElement;
    if (el && box) box.scrollTop = el.offsetTop - box.clientHeight / 3;
  }, [cur?.loc]);

  return (
    <section className="code-panel" aria-label="연결된 코드">
      <header className="code-head">
        <div className="code-title">{title}</div>
        {note && <p className="code-note">{note}</p>}
        {action}
        {resolved.length > 1 && (
          <div className="loc-tabs" role="tablist" aria-label="연결된 코드 위치">
            {resolved.map((r, i) => (
              <button key={i} role="tab" aria-selected={i === idx} className={`${i === idx ? 'on' : ''}${r.ok ? '' : ' bad'}`} onClick={() => setIdx(i)}>
                {r.loc.label}
              </button>
            ))}
          </div>
        )}
        {cur && (
          <div className="code-path">
            <code>{cur.loc.file}</code>
            <span>{cur.loc.startLine === cur.loc.endLine ? `${cur.loc.startLine}줄` : `${cur.loc.startLine}–${cur.loc.endLine}줄`}</span>
          </div>
        )}
      </header>

      {!cur || !cur.ok ? (
        <div className="unlinked" role="status">
          <strong>연결 위치 확인 불가</strong>
          <p>{cur && !cur.ok ? cur.reason : verification?.reason ?? '이 항목에 연결된 코드 위치가 없습니다.'}</p>
        </div>
      ) : (
        <div className="code-body" tabIndex={0} aria-label={`${cur.loc.file} 코드`}>
          {/* 소스는 텍스트로만 렌더링한다 (HTML로 해석·실행하지 않음) */}
          {cur.lines.map((line, i) => {
            const n = i + 1;
            const hit = n >= cur.loc.startLine && n <= cur.loc.endLine;
            return (
              <div key={n} ref={n === cur.loc.startLine ? firstLine : undefined} className={hit ? 'ln hit' : 'ln'}>
                <span className="no">{n}</span>
                <span className="tx">{line || ' '}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
