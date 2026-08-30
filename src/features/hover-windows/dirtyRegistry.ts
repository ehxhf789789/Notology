/**
 * **고치던 중인 창**을 적어 둔다 (2026-08-30)
 *
 * 바깥에서 파일이 지워지면 창을 닫는 것이 맞다 (사용자 지시). 그런데
 * 🔴 **저장 안 한 글이 있는 창을 닫으면 그건 도움이 아니라 사고다.**
 * `HoverWindow` 에는 「고치던 중」 표시가 없어서(전역 상태가 아니라 창
 * 안의 `useState`) 여기 따로 적는다.
 *
 * 창 하나가 자기 상태를 적고, 감시자(`staleWatch`)가 읽는다. 창이 닫히면
 * 지운다 — 안 지우면 영영 「고치던 중」으로 남아 다음부터 안 닫힌다.
 */
const dirty = new Set<string>();

export function setWindowDirty(id: string, isDirty: boolean): void {
  if (isDirty) dirty.add(id);
  else dirty.delete(id);
}

export function forgetWindow(id: string): void {
  dirty.delete(id);
}

export function isWindowDirty(id: string): boolean {
  return dirty.has(id);
}
