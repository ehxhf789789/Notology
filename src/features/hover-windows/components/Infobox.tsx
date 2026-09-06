// 노트 머리의 **정보 상자** — 나무위키 꼴 (2026-09-06 한빈 지시)
//
// 한빈: *"노트 상단이 태그도 코드 그대로 보이고, 노트가 뭔지 한눈에
// 보여주는 정보 상자로서 부족하다. 나무위키 스타일로 검토해라.
// dobbin 의 메타데이터는 **내용이 아니라 백엔드적으로** 관리돼야 한다."*
//
// 🔴 **본문에서 읽지 않는다.** 서버의 `/api/note/meta` 가 표에서 뽑아 준다.
//    앞 판은 메타데이터를 마크다운 본문 글자로 썼고, 편집기가 그 꾸밈을
//    되돌려 쓰지 못해 **노트를 열기만 해도 dirty** 가 되어 「다른 기기에서
//    수정되었습니다」 배너가 떴다. 본문에 쓰는 한 안 풀린다.
//
// 🔴 **색을 여기서 정하지 않는다.** 서버는 `axis` 만 싣고, 색은 앱이 이미
//    가진 `tagStyle()` 한 자리가 정한다 — 두 자리에서 정하면 어긋난다.
import { useEffect, useState } from 'react';
import { tagStyle, tagLabel } from '../../search/searchHelpers';
import { useHoverStore } from '../stores/hoverStore';
import { fileLookupActions } from '../../../core/stores/fileLookupStore';

/** 값 하나 — 서버가 싣는 꼴은 이 다섯뿐이다. */
type Atom =
  | { t: 'text'; s: string }
  | { t: 'num'; s: string; n: number }
  | { t: 'tag'; s: string; axis?: string }
  | { t: 'note'; s: string; to: string }
  | { t: 'path'; s: string };

interface Row { k: string; v: Atom[] }
interface Meta {
  id: number; title: string; type: string; type_label: string;
  stem: string; path: string; rows: Row[];
}

/** `vault:` 같은 주소표를 뗀 꼬리 — 서버가 «vault_path 또는 그 꼬리» 를 받는다. */
function tail(p: string): string {
  const i = p.indexOf(':');
  return i > 0 && !p.slice(0, i).includes('/') ? p.slice(i + 1) : p;
}

function AtomView({ a }: { a: Atom }) {
  if (a.t === 'tag') {
    // 🔴 축을 붙여 되돌린다 — `tagStyle` 이 축에서 색을 뽑기 때문이다.
    const full = a.axis ? `${a.axis}/${a.s}` : a.s;
    return (
      <span className="infobox-chip" style={tagStyle(full)} title={full}>
        {tagLabel(full)}
      </span>
    );
  }
  if (a.t === 'note') {
    return (
      <button
        type="button"
        className="infobox-link"
        title={a.to}
        onClick={() => {
          // 위키링크가 쓰는 그 자를 그대로 쓴다 — 푸는 자리는 하나다.
          const p = fileLookupActions.resolveNotePath(a.to);
          if (p) useHoverStore.getState().open(p);
        }}
      >
        {a.s}
      </button>
    );
  }
  if (a.t === 'path') return <span className="infobox-path" title={a.s}>{a.s}</span>;
  if (a.t === 'num') return <span className="infobox-num">{a.s}</span>;
  return <span>{a.s}</span>;
}

export default function Infobox({ notePath }: { notePath: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);

  useEffect(() => {
    let alive = true;
    setMeta(null);
    if (!notePath || !notePath.toLowerCase().endsWith('.md')) return;
    fetch(`/api/note/meta?path=${encodeURIComponent(tail(notePath))}`)
      // 🔴 404 는 «그런 노트 없음» 이다 — 지어내지 않고 그냥 안 그린다.
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Meta | null) => { if (alive) setMeta(d); })
      .catch(() => { /* 상자는 덤이다 — 못 받아도 노트는 열려야 한다 */ });
    return () => { alive = false; };
  }, [notePath]);

  if (!meta || !meta.rows?.length) return null;

  return (
    <aside className="infobox" data-note-type={meta.type}>
      <div className="infobox-head">
        <span className="infobox-title">{meta.title}</span>
        {meta.type_label && <span className="infobox-type">{meta.type_label}</span>}
      </div>
      <dl className="infobox-rows">
        {meta.rows.map((r) => (
          <div className="infobox-row" key={r.k}>
            <dt>{r.k}</dt>
            <dd>
              {r.v.map((a, i) => (
                <AtomView key={`${r.k}-${i}`} a={a} />
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
