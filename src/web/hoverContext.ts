/** "지금 별도 창 안인가" — web notology에서는 **항상 아니오**
 *
 * 데스크톱 notology는 노트를 OS 창으로 따로 띄울 수 있었다. 그래서 코드가
 * 곳곳에서 `isHoverWindow()`를 물어 "본창인가 떠 있는 창인가"로 갈렸다.
 *
 * 🔴 **브라우저에는 창이 하나뿐이다.** 노트는 페이지 안 패널로 열린다
 *    (`HoverEditorLayer`). 그래서 이 물음의 답은 언제나 `false`이고,
 *    갈리던 두 갈래 중 **본창 쪽만 남는다.**
 *
 * 함수를 지우지 않고 `false`를 돌려주는 이유: 부르는 곳이 8군데인데
 * 하나씩 들어내면 조건문이 뒤엉킨다. **답을 고정하는 것이 더 안전하고
 * 읽기도 쉽다** — 왜 항상 false인지가 여기 한 곳에 적혀 있다.
 */
export function isHoverWindow(): boolean {
  return false;
}
