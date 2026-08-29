/**
 * 접힌 창 독 — 최소화한 노트 창이 **어디로 갔는지 보이게** (2026-08-29)
 *
 * 사용자: *"노트 창을 최소화(-) 하면 사라지는데, 어딘가에 계속 켜져 있는 것
 * 아닌가? 작업 표시줄을 만들어 접고 열 수 있게 하든가."*
 *
 * 맞다. 창은 `minimized: true` 로 **살아 있었는데 되살릴 길이 화면에
 * 없었다.** (`HoverWindowsPanel` 이 만들어져 있었지만 어디에도 안 붙어
 * 있었다 — 이 저장소에서 여러 번 만난 «있는데 안 불린다».)
 *
 * 🔴 최소화를 없애지 않고 **되살릴 자리를 준다** — 여러 노트를 접어 두고
 *    오가는 것이 사서의 실제 일이다. 접힌 것이 없으면 독도 없다 (2-14-2-2:
 *    조용할 때 조용한 것이 살아 있는 것에 가깝다).
 */
import { memo } from 'react';
import { FileText, BookOpen, Image, FileCode, Globe, X } from 'lucide-react';
import { useMinimizedHoverWindows, hoverActions } from './stores/hoverStore';
import type { HoverWindow } from '../../core/types';

function icon(t: HoverWindow['type']) {
  switch (t) {
    case 'pdf': return <BookOpen size={13} />;
    case 'image': return <Image size={13} />;
    case 'code': return <FileCode size={13} />;
    case 'web': return <Globe size={13} />;
    default: return <FileText size={13} />;
  }
}

function label(w: HoverWindow): string {
  const raw = w.filePath || '';
  const base = raw.split('/').pop() || raw;
  return base.replace(/\.md$/i, '');
}

const MinimizedDock = memo(function MinimizedDock() {
  const wins = useMinimizedHoverWindows();
  if (!wins.length) return null;
  return (
    <div className="mindock" role="toolbar" aria-label="접힌 창">
      {wins.map(w => (
        <div key={w.id} className="mindock__item">
          <button
            className="mindock__open"
            title={`${label(w)} — 눌러서 펼치기`}
            onClick={() => hoverActions.restore(w.id)}>
            {icon(w.type)}
            <span className="mindock__name">{label(w)}</span>
          </button>
          <button
            className="mindock__close"
            aria-label={`${label(w)} 닫기`}
            title="닫기"
            onClick={() => hoverActions.close(w.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
});

export default MinimizedDock;
