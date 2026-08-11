/** dobbin 대화 패널 — 사서를 부른다
 *
 * 사용자 요구 (2026-08-11):
 *   *"AI 채팅에 대한 기능을 Notology에 구현해야 한다. 버튼을 추가하는
 *     방식이던, 사용자가 편리하게 AI(Notology라는 도서관, 창고를 관리하는
 *     dobbin)를 쉽게 대화하고 호출하고 지시할 수 있도록."*
 *
 * ## 설계
 *
 * **어디서든 한 번에 부를 수 있어야 한다.** 화면을 옮겨 다니게 하면
 * "쉽게 호출"이 아니다. 그래서:
 *   - 오른쪽에서 밀려 나오는 패널 (탐색기를 가리지 않는다)
 *   - **`Ctrl+K`** 어디서든
 *   - 사이드바 하단 버튼
 *
 * 🔴 **답에 섞인 좌표와 경로를 눌러서 갈 수 있게 한다.** 1-2-1의
 *    *"처음 오는 알바도 지시에 기반해서 명확하게 좌표로 가서"* 가 화면에서
 *    성립하려면, 좌표가 글자가 아니라 **갈 수 있는 것**이어야 한다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, X, Trash2, Loader2, Library } from 'lucide-react';
import { useDobbinStore, dobbinActions } from './dobbinStore';
import { askDobbin, LOCATION_CODE, VAULT_PATH } from './dobbinClient';
import { hoverActions } from '../hover-windows/stores/hoverStore';
import './dobbin.css';

const EXAMPLES = [
  '작년 10월 본부기획 자문회의 자료 찾아줘',
  '스마트건설 정책 문서 어디 있어?',
  '국방부 과제에 뭐가 들어 있지?',
];

/** 답변 한 줄을 그린다 — 좌표·경로는 눌러서 갈 수 있게 */
function Line({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  const marks: { s: number; e: number; v: string; kind: 'code' | 'path' }[] = [];
  for (const m of text.matchAll(LOCATION_CODE)) {
    marks.push({ s: m.index!, e: m.index! + m[0].length, v: m[0], kind: 'code' });
  }
  for (const m of text.matchAll(VAULT_PATH)) {
    if (!marks.some((k) => m.index! < k.e && m.index! + m[0].length > k.s)) {
      marks.push({ s: m.index!, e: m.index! + m[0].length, v: m[0], kind: 'path' });
    }
  }
  marks.sort((a, b) => a.s - b.s);
  for (const k of marks) {
    if (k.s > last) parts.push(text.slice(last, k.s));
    parts.push(
      k.kind === 'path' ? (
        <button key={k.s} className="dobbin-ref" title="이 자료를 연다"
                onClick={() => hoverActions.open(`vault:${k.v}`)}>{k.v}</button>
      ) : (
        <span key={k.s} className="dobbin-code" title="좌표">{k.v}</span>
      ),
    );
    last = k.e;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** 마크다운 표를 표로 그린다.
 *
 * dobbin은 자료를 표로 답한다 — 좌표·위치·과제·날짜가 한눈에 들어와야 하기
 * 때문이다(시스템 프롬프트: *"표가 읽기 좋으면 표로"*). 그런데 화면이 그걸
 * 그대로 뿌리면 `| --- | --- |` 가 글자로 보인다. **답이 좋아도 읽을 수 없으면
 * 소용이 없다.**
 */
function renderBody(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0, key = 0;
  while (i < lines.length) {
    const ln = lines[i];
    const isRow = /^\s*\|.*\|\s*$/.test(ln);
    const isSep = /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '');
    if (isRow && isSep) {
      const cells = (s: string) => s.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(ln);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        <div key={key++} className="dobbin-table-wrap">
          <table className="dobbin-table">
            <thead><tr>{head.map((h, k) => <th key={k}>{h}</th>)}</tr></thead>
            <tbody>{rows.map((r, k) => (
              <tr key={k}>{r.map((c, j) => <td key={j}><Line text={c} /></td>)}</tr>
            ))}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    out.push(<div key={key++} className="dobbin-line"><Line text={ln} /></div>);
    i++;
  }
  return out;
}

export function DobbinPanel() {
  const { open, busy, messages, error } = useDobbinStore();
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); },
            [messages, busy]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setDraft('');
    dobbinActions.setError(null);
    const next = [...useDobbinStore.getState().messages,
                  { role: 'user' as const, content: q, at: Date.now() }];
    dobbinActions.push({ role: 'user', content: q, at: Date.now() });
    dobbinActions.setBusy(true);
    try {
      const answer = await askDobbin(next);
      dobbinActions.push({ role: 'assistant', content: answer, at: Date.now() });
    } catch (e) {
      dobbinActions.setError(e instanceof Error ? e.message : String(e));
    } finally {
      dobbinActions.setBusy(false);
    }
  }, [busy]);

  if (!open) return null;

  return (
    <aside className="dobbin-panel" role="complementary" aria-label="dobbin 대화">
      <header className="dobbin-head">
        <Library size={15} />
        <span className="dobbin-title">dobbin</span>
        <span className="dobbin-sub">이 서재의 사서</span>
        <button className="dobbin-icon" title="대화 비우기"
                onClick={() => dobbinActions.clear()}><Trash2 size={14} /></button>
        <button className="dobbin-icon" title="닫기 (Esc)"
                onClick={() => dobbinActions.close()}><X size={15} /></button>
      </header>

      <div className="dobbin-body">
        {messages.length === 0 && (
          <div className="dobbin-empty">
            <p>자료가 어디 있는지, 무엇이 있는지 물어보십시오.</p>
            <p className="dobbin-hint">
              dobbin은 <b>찾은 것만</b> 말합니다. 없으면 없다고 합니다.
            </p>
            {EXAMPLES.map((x) => (
              <button key={x} className="dobbin-example" onClick={() => send(x)}>{x}</button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`dobbin-msg ${m.role}`}>{renderBody(m.content)}</div>
        ))}
        {busy && (
          <div className="dobbin-msg assistant dobbin-busy">
            <Loader2 size={14} className="dobbin-spin" /> 서가를 뒤지는 중…
          </div>
        )}
        {error && <div className="dobbin-error">{error}</div>}
        <div ref={endRef} />
      </div>

      <div className="dobbin-input">
        <textarea
          ref={inputRef} rows={2} value={draft}
          placeholder="dobbin에게 묻기…  (Enter 전송 · Shift+Enter 줄바꿈)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft); }
            if (e.key === 'Escape') dobbinActions.close();
          }}
        />
        <button className="dobbin-send" disabled={busy || !draft.trim()}
                onClick={() => send(draft)} title="보내기 (Enter)">
          <Send size={15} />
        </button>
      </div>
    </aside>
  );
}

/** 어디서든 dobbin을 부르는 버튼 */
export function DobbinButton() {
  const open = useDobbinStore((s) => s.open);
  return (
    <button className={`dobbin-fab ${open ? 'active' : ''}`}
            onClick={() => dobbinActions.toggle()}
            title="dobbin에게 묻기 (Ctrl+K)">
      <Library size={16} />
      <span>dobbin</span>
    </button>
  );
}

/** `Ctrl+K` — 어디서든 부른다. 화면을 옮겨 다니면 "쉽게 호출"이 아니다. */
export function useDobbinShortcut() {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        dobbinActions.toggle();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}
