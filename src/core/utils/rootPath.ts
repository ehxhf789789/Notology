// 뿌리표를 사람 말로 — `vault:08_Contacts` 가 화면에 그대로 나오던 자리
// (2026-08-25 사용자 지적)
//
// 🔴 **`vault:` 는 주소이지 이름이 아니다.**
//
//    사용자: *"vault: 건도 로컬의 잔재다. 컨테이너를 왜 vault: 로 스코프하고
//    있는건가? 보관소 칸도 웹 플랫폼에 맞게 보완 및 수정해."*
//
//    맞다. 데스크톱 시절엔 보관함이 하나여서 뿌리표가 화면에 안 나왔다.
//    웹으로 오면서 뿌리가 셋이 됐고(교보재·서가·투입구, `vault_api.ROOTS`)
//    그 **열쇠**가 사람 눈에 그대로 새어 나왔다:
//
//        ContainerView.tsx:710  selectedContainer.split(/[/\\]/).pop()
//        Sidebar.tsx:37         vaultPath.split(/[/\\]/).filter(Boolean).pop()
//
//    `vault:08_Contacts` 에는 `/` 가 없다 → `pop()` 이 통째로 돌려준다.
//    그래서 제목이 «vault:08_Contacts», 바닥 칸이 «vault:» 였다.
//
// 🔴 **열쇠를 바꾸지 않는다.** 주소는 링크·색인·서버 갈래가 전부 쓰는 것이라
//    이름을 바꾸면 조용히 깨진다. 바꾸는 것은 **보여 주는 말**뿐이다.

/** 뿌리 열쇠 → 사람이 읽는 이름. 서버 `vault_api.ROOTS` 의 `label` 과 같다. */
export const ROOT_LABELS: Record<string, string> = {
  vault: '교보재',
  library: '서가',
  inbox: '투입구',
};

/** `vault:08_Contacts` → `{ root: 'vault', rest: '08_Contacts' }` */
export function splitRoot(p: string | null | undefined): { root: string; rest: string } {
  const s = String(p ?? '').replace(/\\/g, '/');
  const i = s.indexOf(':');
  // 🔴 윈도우 드라이브 문자(`C:`)를 뿌리표로 읽지 않는다 — 한 글자면 아니다.
  if (i > 1) return { root: s.slice(0, i), rest: s.slice(i + 1).replace(/^\/+/, '') };
  return { root: '', rest: s };
}

/** 화면에 쓸 마지막 칸 이름. 뿌리표는 뗀다. */
export function displayName(p: string | null | undefined): string {
  const { rest, root } = splitRoot(p);
  const last = rest.split('/').filter(Boolean).pop();
  // 뿌리 그 자체(`vault:`)면 뿌리 이름을 준다 — 빈 칸보다 낫다
  return last || ROOT_LABELS[root] || root || '';
}

/** 그 경로가 사는 보관소의 이름 (`교보재` · `서가` · `투입구`). */
export function rootLabel(p: string | null | undefined): string {
  const { root } = splitRoot(p);
  return ROOT_LABELS[root] || root || '';
}
