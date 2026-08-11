/**
 * dobbin이 짚은 자료를 **누르면 열린다** (사용자 요구, 2026-08-12)
 *
 *   *"dobbin의 대화에서 url 링크처럼 notology 내 링크를 출력하고, 사용자는
 *     그 링크를 클릭함으로써 탐색기로 찾지 않고 바로 그 문서에 대한 창을
 *     열 수 있도록. 노트, 첨부파일 뷰어 혹은 첨부파일 다운로드(뷰어
 *     미지원 확장자), 폴더노트 모두."*
 *
 * ## 🔴 글에서 주소를 다시 알아내지 않는다
 *
 * 답변 문장에는 `01_Tasks/표준화 과제 → 첨부 탭 → ….hwp` 라고 적혀 있다.
 * 그것을 화면이 되짚어 파일을 찾으면 **모델이 쓴 글에 의존**하게 된다 —
 * 한 글자만 달라도 못 연다 (2-4: LLM은 경로를 만들지 않는다).
 *
 * 서버가 **무엇을 근거로 답했는지**를 따로 준다 (`dobbin_refs`). 화면은
 * 그 목록만 믿고, 문장 안에서는 **파일 이름이 나타난 자리**만 표시한다.
 *
 * | 무엇 | 누르면 |
 * |---|---|
 * | 노트·폴더노트 | 그 노트 창이 열린다 |
 * | 볼 수 있는 첨부 (pdf·이미지·md·코드) | 뷰어 창 |
 * | 못 보는 첨부 (hwp·zip·pptx…) | **받는다** — 못 그린다고 못 쓰는 건 아니다 |
 */

import { FileText, Image as ImageIcon, Download, StickyNote } from 'lucide-react';
import { hoverActions } from '../hover-windows/stores/hoverStore';
import { openFile } from '../../web/files';

export type DobbinRef = {
  code?: string | null; filename?: string | null; folder?: string | null;
  doc_id?: number; ext?: string; open?: string; path?: string;
  note?: string | null;
};

/** 브라우저가 그릴 수 있는 것 */
const VIEWABLE = /^(pdf|png|jpe?g|gif|webp|svg|bmp|md|txt|csv|json|py|js|ts|tsx|html|xml|yaml|yml)$/i;

export function openRef(r: DobbinRef): void {
  // 노트는 창으로 연다
  if (r.note) { hoverActions.open(r.note); return; }
  const target = r.open || (r.doc_id ? `doc:${r.doc_id}` : '');
  if (!target) return;
  if (VIEWABLE.test(r.ext || '')) {
    // 🔴 뷰어는 보관함 경로로 연다. 서가에 걸린 것은 그 자리로,
    //    아직 안 걸린 것은 창고 주소(`doc:`)로 — 둘 다 열려야 한다 (1-2-2).
    const p = r.folder && r.filename
      ? `library:${r.folder}/attachments/${r.filename}`
      : target;
    hoverActions.open(p);
    return;
  }
  openFile(target, r.filename || undefined);     // 못 그리면 받는다
}

function icon(r: DobbinRef) {
  if (r.note) return <StickyNote size={12} />;
  if (/^(png|jpe?g|gif|webp|svg|bmp)$/i.test(r.ext || '')) return <ImageIcon size={12} />;
  if (VIEWABLE.test(r.ext || '')) return <FileText size={12} />;
  return <Download size={12} />;
}

export function RefChips({ refs }: { refs: DobbinRef[] }) {
  // 🔴 **이름이 없으면 칩으로 만들지 않는다.** 「자료」라고만 적힌 단추는
  //    무엇이 열릴지 모르는 단추다 — 누를 이유가 없다.
  const list = (refs || []).filter((r) => (r.filename || '').trim().length > 0);
  if (!list.length) return null;
  return (
    <div className="dref">
      {list.map((r, i) => (
        <button key={i} className="dref__chip" onClick={() => openRef(r)}
                title={`${r.folder || ''} · ${VIEWABLE.test(r.ext || '') ? '열기' : '받기'}`}>
          {icon(r)}
          <span className="dref__name">{r.filename || r.code || '자료'}</span>
        </button>
      ))}
    </div>
  );
}
