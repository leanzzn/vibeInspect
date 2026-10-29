import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CodeLocation } from './model';
import { buildMessages, requestKey, SYSTEM_PROMPT, type AskRequest, type AskResult } from './ai/prompt';
import {
  checkCitations, checkConnection, getStatus, parseAnswer, pingModel, prepareSnippets, relatedLocations, SECTIONS, sendAsk,
  type AiStatus, type CheckResult, type Prepared,
} from './ai/context';

/** gap: 정적 분석이 연결을 확정하지 못한 항목. 관련 코드를 함께 보내 AI에게 연결을 추정하게 한다 */
export interface AiTarget { title: string; description: string; locations: CodeLocation[]; gap?: boolean }

const EXAMPLES = ['이 단계에서 어떤 정보가 사용돼?', '이 함수가 호출하는 다른 함수는 뭐야?', '이 결과는 어디에서 화면에 표시돼?'];
const EASY = '이 단계를 쉽게 설명해 줘.';
const TRACE = '이 지점은 정적 분석이 연결 대상을 확정하지 못한 곳이야. 함께 보낸 다른 코드 조각을 참고해서 실제로 어떤 함수나 값이 여기에 연결될 가능성이 높은지, 그 근거와 함께 설명해 줘. 코드로 확인되지 않는 연결은 추정으로 적어 줘.';

/** AI 기능에서 오류가 나도 지도·코드 탐색은 계속 쓸 수 있게 이 패널만 감싼다. */
export class AiBoundary extends Component<{ children: ReactNode }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() { return { err: true }; }
  render() {
    return this.state.err
      ? <div className="ai-box ai-err" role="alert">AI 설명 기능에서 오류가 났습니다. 지도와 코드 탐색은 그대로 쓸 수 있습니다.</div>
      : this.props.children;
  }
}

export default function AiPanel({ target, files }: { target: AiTarget | null; files: Record<string, string> }) {
  const [status, setStatus] = useState<AiStatus | { ok: false; message: string } | null>(null);
  const [check, setCheck] = useState<CheckResult | { ok: false; kind: string; message: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [question, setQuestion] = useState('');
  const [draft, setDraft] = useState<{ req: AskRequest; prep: Prepared } | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ res: AskResult; req: AskRequest } | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { getStatus().then(setStatus); }, []); // 설정 상태만 묻는다(외부 요청 없음)
  useEffect(() => () => abort.current?.abort(), []);

  const st = status && 'state' in status ? status : null;
  const usable = st?.state === 'ready' || st?.state === 'mock';
  // 끊긴 지점은 그 위치 2곳 + 이름이 선언·전달된 다른 코드(최대 4곳)를 함께 보낸다
  const prepared = target ? prepareSnippets(target.gap ? [...target.locations.slice(0, 2), ...relatedLocations(target.locations, files)] : target.locations, files) : null;

  const preview = (q: string) => {
    if (!target || !prepared?.snippets.length) return;
    setQuestion(q);
    setResult(null);
    setDraft({ req: { target: `${target.title} — ${target.description}`.slice(0, 600), question: q.trim(), snippets: prepared.snippets }, prep: prepared });
  };
  const send = async () => {
    if (!draft) return;
    const req = draft.req;
    abort.current = new AbortController();
    setLoading(true);
    // 동의 = 지금 화면에 보이는 그 요청. sendAsk가 키를 다시 대조한다.
    const res = await sendAsk(req, requestKey(req), fetch, abort.current.signal);
    setLoading(false);
    setDraft(null);
    setResult({ res, req });
  };
  const runCheck = async (fn: typeof checkConnection) => { setChecking(true); setCheck(await fn()); setChecking(false); };

  return (
    <div className="ai">
      <div className="ai-box">
        <div className="ai-row">
          <strong>ChatKHU 연결</strong>
          <span className={`chip ${usable ? '' : 'gap'}`}>{!status ? '확인 중' : st ? ({ ready: '설정됨', mock: '모의 응답 모드', 'no-key': 'API 키 없음', 'no-model': '모델 미설정', 'bad-base-url': '주소 오류' })[st.state] : '서버 없음'}</span>
        </div>
        {status && !usable && <p className="muted">{status.message}</p>}
        {st?.state === 'ready' && (
          <div className="ai-row">
            <button className="sm" disabled={checking} onClick={() => runCheck(checkConnection)} title="모델 목록만 조회합니다. 소스 코드는 보내지 않습니다.">연결 확인</button>
            <button className="sm" disabled={checking} onClick={() => runCheck(pingModel)} title="고정된 짧은 문장만 보냅니다. 크레딧이 차감될 수 있습니다.">짧은 생성 테스트</button>
            {checking && <span className="muted">확인 중…</span>}
          </div>
        )}
        {check && <p className={check.ok ? 'muted' : 'ai-bad'}>{check.message}</p>}
      </div>

      {!target ? (
        <p className="muted ai-pad">카드나 단계를 선택하세요.</p>
      ) : !prepared?.snippets.length ? (
        <div className="ai-box ai-pad">
          <strong>보낼 수 있는 코드가 없습니다</strong>
          <p className="muted">확인된 코드 위치가 없어 보내지 않습니다.</p>
          {prepared?.excluded.map((x, i) => <p key={i} className="muted"><code>{x.label}</code> {x.reason}</p>)}
        </div>
      ) : (
        <>
          <div className="ai-pad">
            <strong>{target.title}</strong>
            <div className="ai-scope">
              {prepared.snippets.map((s) => <code key={`${s.file}:${s.startLine}`}>{s.file}:{s.startLine}–{s.endLine}</code>)}
            </div>
            {target.gap
              ? <button className="primary" disabled={!usable || loading} onClick={() => preview(TRACE)} title="관련 코드를 함께 보내 AI에게 연결을 추정하게 합니다. 결과는 추정입니다.">끊긴 연결 AI로 추적</button>
              : <button className="primary" disabled={!usable || loading} onClick={() => preview(EASY)} title="크레딧이 차감될 수 있습니다. 보내기 전에 내용을 보여 줍니다.">쉽게 설명하기</button>}
            <form className="ai-ask" onSubmit={(e) => { e.preventDefault(); if (question.trim()) preview(question); }}>
              <textarea value={question} maxLength={1000} rows={2} placeholder="이 항목에 대해 질문하세요" aria-label="질문"
                onChange={(e) => { setQuestion(e.target.value); setDraft(null); }} disabled={!usable || loading} />
              <button type="submit" disabled={!usable || loading || !question.trim()}>보낼 내용 확인</button>
            </form>
            {usable && (
              <div className="ai-examples">
                {EXAMPLES.map((q) => <button key={q} className="sm" disabled={loading} onClick={() => preview(q)}>{q}</button>)}
              </div>
            )}
          </div>

          {draft && !loading && <Consent draft={draft} onSend={send} onCancel={() => setDraft(null)} />}

          {loading && (
            <div className="ai-box ai-pad" role="status">
              <p>ChatKHU 답변을 기다리는 중…</p>
              <button onClick={() => abort.current?.abort()}>요청 취소</button>
            </div>
          )}

          {result && <Answer {...result} />}
        </>
      )}
    </div>
  );
}

function Consent({ draft, onSend, onCancel }: { draft: { req: AskRequest; prep: Prepared }; onSend: () => void; onCancel: () => void }) {
  const { req, prep } = draft;
  const user = buildMessages(req)[1].content;
  return (
    <div className="ai-box ai-consent" role="region" aria-label="전송 확인">
      <strong>아래 내용을 ChatKHU(외부 AI 서비스)로 보냅니다</strong>
      <p className="muted">질문: “{req.question}”</p>
      <ul className="ai-list">
        {req.snippets.map((s) => <li key={`${s.file}:${s.startLine}`}><code>{s.file}</code> {s.startLine}–{s.endLine}줄 ({s.endLine - s.startLine + 1}줄)</li>)}
      </ul>
      {prep.redacted > 0 && <p className="ai-bad">민감 정보로 의심되는 값 {prep.redacted}곳을 [가림]으로 바꿔 보냅니다. 그 때문에 설명이 불완전할 수 있습니다.</p>}
      {prep.excluded.length > 0 && (
        <div className="ai-bad">
          보내지 않는 부분이 있어 설명이 불완전할 수 있습니다:
          <ul className="ai-list">{prep.excluded.map((x, i) => <li key={i}><code>{x.label}</code> {x.reason}</li>)}</ul>
        </div>
      )}
      <p className="muted">자동 탐지는 모든 비밀 값과 개인정보를 찾아내지 못합니다. 아래 원문을 직접 확인하세요.</p>
      <details open>
        <summary>실제로 보낼 내용 전체</summary>
        <pre className="ai-pre">{user}</pre>
      </details>
      <details>
        <summary>함께 보내는 지침(시스템 메시지)</summary>
        <pre className="ai-pre">{SYSTEM_PROMPT}</pre>
      </details>
      <div className="ai-row">
        <button className="primary" onClick={onSend}>확인했고 보냅니다</button>
        <button onClick={onCancel}>보내지 않기</button>
      </div>
    </div>
  );
}

function Answer({ res, req }: { res: AskResult; req: AskRequest }) {
  if (!res.ok) {
    return (
      <div className="ai-box ai-pad" role="alert">
        <strong className="ai-bad">{res.kind === 'aborted' ? '요청을 취소했습니다' : 'AI 답변을 받지 못했습니다'}</strong>
        <p className="muted">{res.message}</p>
      </div>
    );
  }
  const parsed = parseAnswer(res.text);
  const cites = checkCitations(res.text, req.snippets);
  return (
    <div className="ai-box ai-answer">
      <div className="ai-row">
        <span className={`chip prov ${res.source === 'mock' ? 'manual' : 'auto'}`}>{res.source === 'mock' ? '모의 응답 · 실제 AI 아님' : `ChatKHU 응답 · ${res.model}`}</span>
        <span className="muted">질문: {req.question}</span>
      </div>
      <p className="muted">AI가 생성한 설명입니다. 틀릴 수 있으니 아래 근거 코드와 함께 확인하세요.</p>
      {parsed
        ? SECTIONS.map((h) => parsed[h] !== undefined && (
          <section key={h} className={`ai-sec${h === '추정' || h === '확인하지 못한 부분' ? ' soft' : ''}`}>
            <h4>{h}</h4>
            <p>{parsed[h]}</p>
          </section>
        ))
        : <>
          <p className="ai-bad">답변이 정해진 형식(네 개 제목)을 따르지 않아 원문 그대로 보여 줍니다. 확인한 사실과 추정이 구분되지 않았을 수 있습니다.</p>
          <p className="ai-raw">{res.text}</p>
        </>}
      <h4>답변에 적힌 근거 위치</h4>
      {cites.length === 0 && <p className="ai-bad">답변에 “파일:줄” 형식의 근거가 없습니다.</p>}
      {cites.map((c) => (
        <div key={c.ref} className={`ai-cite${c.ok ? '' : ' bad'}`}>
          <div><code>{c.ref}</code> {c.ok ? <span className="chip">보낸 범위 안</span> : <span className="chip gap">근거 확인 불가 · {c.reason}</span>}</div>
          {c.ok && <pre className="ai-pre">{c.lines!.map((l) => `${l.n}| ${l.text}`).join('\n')}</pre>}
        </div>
      ))}
      <p className="muted sm-note">위치 확인은 그 줄이 이번에 보낸 범위 안에 있다는 것만 검사합니다. 그 코드의 의미가 AI 설명과 맞는지는 보증하지 않습니다.</p>
    </div>
  );
}
