/**
 * 자료 투입 — 마구잡이로 던지는 곳 (CLAUDE.md 1-2 ①)
 *
 * 사용자 요구:
 *   "마구잡이로 정리해야 할 자료를 올린다 → dobbin이 읽고 분석·해석한다
 *    → 그 자료에 맞는 노트를 만들거나 기존 노트에 링크를 건다"
 *
 * 이 파일은 그 **1단계**다. 2·3단계는 서버가 한다
 * (`interpret.py` · `decide.py` · `compose.py`).
 *
 * ## 🔴 창 아무 데나 떨어뜨릴 수 있어야 한다
 *
 * "마구잡이로 던진다"가 요구사항이다. 버튼을 찾아 눌러야 한다면 그건
 * 던지는 게 아니다. 창 전체가 받는다 — 노트를 보다가, 검색하다가,
 * 캘린더를 보다가 그냥 놓으면 된다.
 *
 * ## 🔴 폴더째 받는다. 경로를 살린다
 *
 * 원칙 7: *"인수인계 자료는 원본 경로가 내용보다 강한 분류 신호다."*
 * 그리고 6장 실측: 레인 A의 파일명 규칙은 미정리 자료에서 **4.9%** 로 떨어진다.
 * **미정리 자료의 신호는 파일명이 아니라 경로다.**
 *
 * `DataTransferItem.webkitGetAsEntry()` 로 폴더를 재귀로 편다.
 * `webkitRelativePath` 는 `<input webkitdirectory>` 에만 있고 드롭에는 없다.
 *
 * ## 🔴 한 파일에 한 요청
 *
 * 묶으면 하나가 실패할 때 전부 잃는다. 브라우저가 알아서 병렬로 보내므로
 * 묶을 이유도 없다. 동시에 4개까지만 — 그 이상은 CIFS 쪽이 병목이다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { UploadCloud, X, Check, AlertTriangle } from 'lucide-react';
import './ingest.css';

type Item = { rel: string; file: File; state: 'wait' | 'go' | 'ok' | 'skip' | 'fail';
              why?: string };

const CONCURRENCY = 4;

/** 드롭된 항목을 편다. 폴더면 재귀로 들어간다. */
async function flatten(items: DataTransferItemList): Promise<{ rel: string; file: File }[]> {
  const out: { rel: string; file: File }[] = [];
  const walk = async (entry: any, prefix: string): Promise<void> => {
    if (!entry) return;
    if (entry.isFile) {
      const file: File = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ rel: prefix + file.name, file });
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      // 🔴 `readEntries` 는 한 번에 100개까지만 준다. 빌 때까지 반복해야
      //    한다 — 한 번만 부르면 큰 폴더에서 조용히 잘린다.
      for (;;) {
        const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, prefix + entry.name + '/');
      }
    }
  };
  const entries = [...items].map(i => (i as any).webkitGetAsEntry?.()).filter(Boolean);
  for (const e of entries) await walk(e, '');
  return out;
}

async function send(it: Item): Promise<Item> {
  try {
    const r = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'X-Rel-Path': encodeURIComponent(it.rel), 'X-Source': 'web' },
      body: it.file,
    });
    const j = await r.json();
    if (!j.ok) return { ...it, state: 'fail', why: j.why || `HTTP ${r.status}` };
    return { ...it, state: j.skipped ? 'skip' : 'ok', why: j.why };
  } catch (e) {
    return { ...it, state: 'fail', why: String(e).slice(0, 80) };
  }
}

export function Ingest() {
  const [over, setOver] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);
  const depth = useRef(0);                       // dragenter/leave 가 자식마다 뜬다
  const picker = useRef<HTMLInputElement>(null);

  const run = useCallback(async (picked: { rel: string; file: File }[]) => {
    if (!picked.length) return;
    const queued: Item[] = picked.map(p => ({ ...p, state: 'wait' }));
    setItems(prev => [...queued, ...prev].slice(0, 400));
    setOpen(true);
    let i = 0;
    const worker = async () => {
      for (;;) {
        const k = i++;
        if (k >= queued.length) return;
        const done = await send({ ...queued[k], state: 'go' });
        setItems(prev => prev.map(x => (x.rel === done.rel && x.file === done.file)
          ? done : x));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }, []);

  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      depth.current++; setOver(true);
    };
    const onLeave = () => { if (--depth.current <= 0) { depth.current = 0; setOver(false); } };
    const onOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); }
    };
    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault(); depth.current = 0; setOver(false);
      const picked = await flatten(e.dataTransfer.items);
      // 폴더 API가 없는 브라우저는 평평한 목록으로라도 받는다
      if (!picked.length && e.dataTransfer.files.length) {
        await run([...e.dataTransfer.files].map(f => ({ rel: f.name, file: f })));
      } else await run(picked);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    const openEv = () => picker.current?.click();
    window.addEventListener('dobbin:ingest-open', openEv);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dobbin:ingest-open', openEv);
    };
  }, [run]);

  const busy = items.filter(x => x.state === 'wait' || x.state === 'go').length;
  const ok = items.filter(x => x.state === 'ok').length;
  const skip = items.filter(x => x.state === 'skip').length;
  const bad = items.filter(x => x.state === 'fail').length;

  return (
    <>
      <input ref={picker} type="file" multiple
             // @ts-expect-error 폴더 선택 — 표준이 아니지만 크롬·엣지·사파리가 지원한다
             webkitdirectory="" directory=""
             style={{ display: 'none' }}
             onChange={e => {
               const fs = [...(e.target.files || [])];
               run(fs.map(f => ({ rel: (f as any).webkitRelativePath || f.name, file: f })));
               e.target.value = '';
             }} />

      {over && (
        <div className="ingest-veil">
          <div className="ingest-veil__card">
            <UploadCloud size={40} />
            <div className="ingest-veil__title">여기에 놓으세요</div>
            <div className="ingest-veil__sub">
              폴더째 놓아도 됩니다 — 원래 경로가 분류 단서가 됩니다
            </div>
          </div>
        </div>
      )}

      {open && items.length > 0 && (
        <div className="ingest-tray">
          <div className="ingest-tray__head">
            <span className="ingest-tray__title">
              {busy > 0 ? `투입 중 ${ok + skip + bad}/${items.length}` : '투입 완료'}
            </span>
            <button className="ingest-tray__x" onClick={() => setOpen(false)}
                    aria-label="닫기"><X size={14} /></button>
          </div>
          <div className="ingest-tray__sum">
            {ok > 0 && <span className="ok"><Check size={12} /> 새로 {ok}</span>}
            {skip > 0 && <span className="skip">이미 있음 {skip}</span>}
            {bad > 0 && <span className="bad"><AlertTriangle size={12} /> 실패 {bad}</span>}
          </div>
          <div className="ingest-tray__list">
            {items.slice(0, 60).map((x, i) => (
              <div key={x.rel + i} className={`ingest-row ingest-row--${x.state}`}
                   title={x.why || x.rel}>
                <span className="ingest-row__name">{x.rel}</span>
                <span className="ingest-row__state">
                  {x.state === 'ok' ? '넣음' : x.state === 'skip' ? '중복'
                    : x.state === 'fail' ? '실패' : x.state === 'go' ? '…' : '대기'}
                </span>
              </div>
            ))}
          </div>
          {busy === 0 && (
            <div className="ingest-tray__foot">
              dobbin이 읽고 분석한 뒤 서가에 꽂습니다. 그때까지 투입구에 있습니다.
            </div>
          )}
        </div>
      )}
    </>
  );
}
