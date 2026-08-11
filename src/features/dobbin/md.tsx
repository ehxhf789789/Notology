/**
 * 말풍선 안의 마크다운 — 최소한만, 안전하게 (사용자 지적, 2026-08-12)
 *
 *   *"마크다운 기본 디자인도 반영이 안 되서 `**` 표시가 그대로 보이고 있다.
 *     링크 url 클릭도 안 되고."*
 *
 * ## 🔴 `dangerouslySetInnerHTML` 을 쓰지 않는다
 *
 * dobbin의 답에는 **웹에서 가져온 글**이 섞인다 (websurf.py). 그걸 HTML로
 * 그대로 밀어 넣으면 남이 쓴 문자열이 이 화면의 마크업이 된다 — 2-4가
 * 구조로 막은 것을 화면에서 다시 여는 셈이다.
 * **React 노드로 만든다.** 태그가 될 수 있는 것은 여기서 만든 것뿐이다.
 *
 * 다루는 것: `**굵게**` · `` `코드` `` · `[말](주소)` · 맨 주소 · 불릿 · 줄바꿈.
 * 그 이상은 하지 않는다 — 대화창은 문서 편집기가 아니다.
 */

import type { ReactNode } from 'react';
import { openRef, type DobbinRef } from './refs';

// ⚠️ `[^*\n]+` 로 두면 굵게 안에 별표가 하나라도 있으면 통째로 놓친다 —
//    웹 검색 결과 제목에 `**` 가 섞여 들어오는 일이 실제로 있었다.
//    링크를 **먼저** 보게 순서를 두고, 굵게는 비탐욕으로 잡는다.
const TOKEN = /(\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]+|\*\*(?!\s)[\s\S]*?\*\*|`[^`\n]+`)/g;

/** 한 줄 안의 굵게·코드·링크 */
function inline(text: string, key: string, refs?: DobbinRef[]): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const s = m[0];
    const k = `${key}-${i}`;
    if (s.startsWith('**')) {
      out.push(<strong key={k}>{s.slice(2, -2)}</strong>);
    } else if (s.startsWith('`')) {
      // 🔴 모델은 경로·파일명을 코드칸에 넣는다. 거기도 눌려야 한다 —
      //    실측에서 본문 링크가 0개였던 이유가 이것이다.
      out.push(<code key={k}>{withRefs([s.slice(1, -1)], refs)}</code>);
    } else if (s.startsWith('[')) {
      const cut = s.indexOf('](');
      const href = s.slice(cut + 2, -1);
      out.push(safeLink(href, s.slice(1, cut), k));
    } else {
      out.push(safeLink(s, s, k));
    }
    last = i + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 🔴 **문장 안에 나타난 파일 이름을 누를 수 있게 만든다.**
 *  이름은 서버가 준 목록(`refs`)에 있는 것만 본다 — 글에서 경로를 알아내지
 *  않는다 (모델이 쓴 글에 기대면 한 글자만 달라도 못 연다). */
function withRefs(nodes: ReactNode[], refs?: DobbinRef[]): ReactNode[] {
  if (!refs?.length) return nodes;
  const names = refs
    .map((r) => ({ r, n: (r.filename || '').trim() }))
    .filter((x) => x.n.length >= 6)
    .sort((a, b) => b.n.length - a.n.length);       // 긴 이름이 먼저 잡혀야 한다
  const out: ReactNode[] = [];
  nodes.forEach((node, ni) => {
    if (typeof node !== 'string') { out.push(node); return; }
    let rest = node;
    let guard = 0;
    while (guard++ < 12) {
      const hit = names
        .map((x) => ({ ...x, i: rest.indexOf(x.n) }))
        .filter((x) => x.i >= 0)
        .sort((a, b) => a.i - b.i)[0];
      if (!hit) break;
      if (hit.i > 0) out.push(rest.slice(0, hit.i));
      out.push(
        <button key={`r${ni}-${guard}`} className="md-ref"
                onClick={() => openRef(hit.r)} title="눌러서 열기">
          {hit.n}
        </button>,
      );
      rest = rest.slice(hit.i + hit.n.length);
    }
    if (rest) out.push(rest);
  });
  return out;
}

/** 🔴 `http(s)` 만 링크로 만든다 — `javascript:` 는 링크가 아니라 코드다. */
function safeLink(href: string, label: string, key: string): ReactNode {
  if (!/^https?:\/\//i.test(href)) return <span key={key}>{label}</span>;
  return (
    <a key={key} href={href} target="_blank" rel="noreferrer noopener"
       onClick={(e) => e.stopPropagation()}>{label}</a>
  );
}

export function Markdown({ text, refs }: { text: string; refs?: DobbinRef[] }) {
  const lines = (text || '').split('\n');
  return (
    <>
      {lines.map((line, i) => {
        const bullet = /^\s*[-*]\s+/.exec(line);
        const num = /^\s*(\d+)\.\s+/.exec(line);
        if (bullet) {
          return (
            <span key={i} className="md-li">
              <span className="md-dot">•</span>
              <span>{withRefs(inline(line.slice(bullet[0].length), String(i), refs), refs)}</span>
            </span>
          );
        }
        if (num) {
          return (
            <span key={i} className="md-li">
              <span className="md-dot">{num[1]}.</span>
              <span>{withRefs(inline(line.slice(num[0].length), String(i), refs), refs)}</span>
            </span>
          );
        }
        return <span key={i} className="md-p">{withRefs(inline(line, String(i), refs), refs)}</span>;
      })}
    </>
  );
}
