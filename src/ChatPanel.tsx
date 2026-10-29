import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CodeLocation } from './model';
import { prepareSnippets, sendAsk } from './ai/context';
import { ASK_LIMITS, requestKey, type AskRequest } from './ai/prompt';

/** AI 기능에서 오류가 나도 지도·코드 탐색은 계속 쓸 수 있게 이 패널만 감싼다. */
export class AiBoundary extends Component<{ children: ReactNode }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() { return { err: true }; }
  render() {
    return this.state.err
      ? <div className="ai-box ai-err" role="alert">채팅 기능에서 오류가 났습니다. 지도와 코드 탐색은 그대로 쓸 수 있습니다.</div>
      : this.props.children;
  }
}

type Msg = { role: 'user' | 'ai'; text: string; bad?: boolean };
const TAIL = 6; // 이전 대화는 최근 몇 개만 같이 보낸다

/**
 * 사이드 채팅창: 질문 + 지도 요약 + (선택한 카드가 있으면) 그 카드의 코드 조각(가림 처리)을 보낸다.
 * 보내는 내용은 입력창 아래에 항상 적어 두고, 전송 버튼을 누르는 것을 동의로 본다.
 */
export default function ChatPanel({ mapSummary, target, files, onClose }: {
  mapSummary: string; target: { title: string; locations: CodeLocation[] } | null; files: Record<string, string>; onClose: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, loading]);

  const snippets = target ? prepareSnippets(target.locations, files).snippets : [];

  const send = async () => {
    const q = input.trim();
    if (!q || loading) return;
    const history = msgs.slice(-TAIL).filter((m) => !m.bad).map((m) => `${m.role === 'user' ? '사용자' : '도우미'}: ${m.text}`).join('\n');
    const question = `${history ? `이전 대화:\n${history}\n\n` : ''}질문: ${q}`.slice(-ASK_LIMITS.question);
    const req: AskRequest = {
      target: `[프로젝트 지도 요약]\n${mapSummary}${target ? `\n\n지금 선택한 카드: ${target.title}` : ''}`.slice(0, ASK_LIMITS.target),
      question, snippets, chat: true,
    };
    setMsgs((m) => [...m, { role: 'user', text: q }]);
    setInput('');
    setLoading(true);
    abort.current = new AbortController();
    const r = await sendAsk(req, requestKey(req), fetch, abort.current.signal);
    setLoading(false);
    setMsgs((m) => [...m, r.ok ? { role: 'ai', text: r.text } : { role: 'ai', text: r.message, bad: true }]);
  };

  return (
    <aside className="chat" aria-label="AI 채팅">
      <header className="chat-head">
        <strong>AI에게 물어보기</strong>
        <button className="icon-btn" onClick={onClose} title="채팅창 닫기" aria-label="채팅창 닫기">✕</button>
      </header>
      <div className="chat-log" aria-live="polite">
        {msgs.length === 0 && <p className="muted">지도나 코드에 대해 간단히 물어보세요. 카드를 선택한 상태로 물으면 그 카드의 코드를 함께 봅니다.</p>}
        {msgs.map((m, i) => <div key={i} className={`bubble ${m.role}${m.bad ? ' bad' : ''}`}>{m.text}</div>)}
        {loading && <div className="bubble ai muted">답을 쓰는 중… <button className="sm" onClick={() => abort.current?.abort()}>멈추기</button></div>}
        <div ref={end} />
      </div>
      <form className="chat-form" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea value={input} rows={2} maxLength={1000} placeholder="예: 장학금 추천은 어떤 정보를 써?" aria-label="질문"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <button className="primary" disabled={!input.trim() || loading}>보내기</button>
      </form>
      <p className="chat-note">
        보내는 것: 질문, 지도 요약{snippets.length > 0 && <>, <b>{target!.title}</b> 코드 {snippets.length}조각</>}. 외부 AI 서비스 ChatKHU로 보내며 크레딧이 조금 차감됩니다.
      </p>
    </aside>
  );
}
