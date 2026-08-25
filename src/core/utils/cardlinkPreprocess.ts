// 옵시디언의 ```cardlink``` 를 **링크 박스**로 바꾼다 (2026-08-25 사용자 지적)
//
// 사용자: *"notology의 이런 코드 블럭은 옵시디언의 링크 박스 플러그인을
// 사용한거다. … 이미 notology에는 링크 박스를 노트에 만드는 기능이 있을 거다.
// 이런 코드 블럭을 링크 박스로 수정."*
//
// 🔴 **그리는 자는 이미 있었다** (`LinkCard.ts` · `LinkCardView.tsx`). 다만
//    그 자는 제 저장 꼴(`<div data-link-card …>`)만 알아본다. 옵시디언
//    플러그인(Auto Card Link)이 쓰는 **코드 울타리 꼴**을 아무도 안 읽었다:
//
//        ```cardlink
//        url: https://…
//        title: "(PDF) Cash Flow and Its Components in Investment Valuation"
//        description: "PDF | Objective: …"
//        host: www.researchgate.net
//        favicon: https://…
//        image: https://…
//        ```
//
//    실측: 교보재 노트 **82개**가 이 꼴을 쓴다. 그동안 전부 **코드 덩어리**로
//    보였다 — 사람이 링크를 붙여 둔 자리가 읽을 수 없는 글자 더미가 됐다.
//
// 🔴 **원본을 안 고친다.** 파일에는 ```cardlink``` 그대로 남는다. 여기서
//    하는 것은 **화면에 들어올 때** HTML 로 바꿔 주는 것뿐이고, 저장할 때는
//    `LinkCard` 가 제 꼴로 되돌린다. 원본을 고치면 옵시디언에서 열 때 깨진다
//    (그쪽 플러그인은 이 `div` 를 모른다).

/** HTML 속성에 안전하게 넣는다 — 따옴표가 든 제목이 실제로 온다. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** `title: "…"` 의 따옴표를 벗긴다. 없으면 그대로. */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"'))
                        || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

const FENCE = /^```cardlink[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

export function preprocessCardLinks(markdown: string): string {
  if (!markdown || markdown.indexOf('cardlink') === -1) return markdown;
  return markdown.replace(FENCE, (whole, inner: string) => {
    const f: Record<string, string> = {};
    for (const line of String(inner).split('\n')) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim().toLowerCase();
      // 🔴 값에 `:` 가 들어 있다 (`https://…`) — **첫 콜론에서만** 가른다
      f[key] = unquote(line.slice(i + 1));
    }
    // 🔴 주소가 없으면 링크 박스가 아니다 — 건드리지 않고 그대로 둔다.
    //    억지로 바꾸면 사람이 적어 둔 것이 사라진다 (2-3 의 「지어내지 않는다」).
    if (!f.url) return whole;
    return '<div data-link-card="" '
      + `data-url="${esc(f.url)}" `
      + `data-title="${esc(f.title || f.host || f.url)}" `
      + `data-description="${esc(f.description || '')}" `
      + `data-image="${esc(f.image || '')}" `
      + `data-favicon="${esc(f.favicon || '')}"></div>`;
  });
}
