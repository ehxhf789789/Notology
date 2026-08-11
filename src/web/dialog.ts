/** 파일 선택 — 🔴 브라우저는 파일시스템을 못 연다
 *
 * 데스크톱은 OS 폴더 선택창을 띄웠다. **웹에는 그 개념이 없고 있어서도 안 된다** —
 * 서버가 마운트를 들고 있으므로 사용자가 서버의 폴더를 고를 이유가 없다.
 *
 * 파일을 **넣는 것**은 업로드로 한다 (전체계획서 N8). 그건 선택창이 아니라
 * 드래그·드롭이다.
 */
export async function open(opts?: { directory?: boolean; multiple?: boolean }) {
  if (opts?.directory) {
    // 보관함은 서버가 정한다. 사용자가 고르는 것이 아니다.
    throw new Error('web notology는 서버가 보관함을 든다 — 폴더를 고를 필요가 없습니다');
  }
  return new Promise<string[] | string | null>((resolve) => {
    const el = document.createElement('input');
    el.type = 'file';
    el.multiple = !!opts?.multiple;
    el.onchange = () => {
      const fs = Array.from(el.files ?? []).map((f) => f.name);
      resolve(opts?.multiple ? fs : (fs[0] ?? null));
    };
    el.click();
  });
}
export const save = async () => null;
export const message = async (m: string) => { window.alert(m); };
export const ask = async (m: string) => window.confirm(m);
export const confirm = async (m: string) => window.confirm(m);
