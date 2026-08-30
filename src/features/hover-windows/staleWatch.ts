/**
 * 열어 둔 노트 창이 **바깥 변화를 따라간다** (2026-08-30)
 *
 * 사용자: *"노트가 이미 변경되었거나 제거되었음에도, 내가 notology에 해당
 * 노트를 열어두었다면 노트창이 닫히거나 변경에 대응되어야 하는데, 그대로
 * 열려있다."*
 *
 * 🔴 맞다. 실측했다 — 바깥에서 본문을 바꾸고 36초를 기다려도 창은 옛 글자를
 *    보여줬고, **파일을 지워도 창이 그대로 열려 있었다.**
 *
 * 🔴 **되읽는 기계는 이미 다 있었다.** `hoverActions.refreshForFile` 이
 *    캐시를 버리고 `contentReloadTrigger` 를 올리면 `useContentLoader` 가
 *    다시 읽고, 사람이 고치던 중이면 **충돌 화면**까지 띄운다.
 *    `closeByFilePath` 도 있다. 데스크톱은 파일 감시기가 이 둘을 불렀는데
 *    **웹판에는 부르는 자가 없었다** — 이 저장소가 되풀이하는
 *    「있는데 안 불린다」의 또 한 자리다.
 *
 * 그래서 이 파일은 새 기계를 짓지 않는다. **알림과 그 둘을 잇기만 한다.**
 *
 * 🔴 알림에는 **어느 파일인지가 없다** (scope 와 파일 수만 온다). 열린 창만
 *    되물어 본다 — 창은 보통 한둘이라 값이 싸다 (명령 2개 × 창 수).
 *
 * ⚠️ **판을 글자로 견주면 안 된다.** `get_file_revision` 은
 *    `{hash, mtime, size}` 객체를 준다. `String()` 을 씌우면 언제나
 *    `"[object Object]"` 라서 **판이 영영 안 갈린다** — 첫 판이 그랬다.
 */
import { invoke } from '../../web/core';
import { fileCommands } from '../../core/services/tauriCommands';
import { useHoverStore, hoverActions } from './stores/hoverStore';
import { refreshActions } from '../../core/stores/refreshStore';
import { filterExternalChanges } from '../../core/utils/selfSaveTracker';
import { isWindowDirty } from './dirtyRegistry';

type Rev = { hash?: string; mtime?: number; size?: number } | null;

let running = false;
const seen = new Map<string, string>();          // 경로 → 마지막으로 본 판

/** 객체 판을 견줄 수 있는 한 줄로. */
function stamp(r: Rev): string {
  if (!r || typeof r !== 'object') return String(r);
  return `${r.hash ?? ''}:${r.mtime ?? ''}:${r.size ?? ''}`;
}

async function check(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const wins = useHoverStore.getState().hoverFiles || [];
    const paths = [...new Set(wins.map(w => w.filePath).filter(Boolean))];
    // 이제 안 열려 있는 것은 기억에서 지운다 — 다시 열면 첫 판부터 다시 잰다
    for (const p of [...seen.keys()]) if (!paths.includes(p)) seen.delete(p);

    for (const path of paths) {
      let exists = true;
      try {
        exists = await fileCommands.checkFileExists(path);
      } catch {
        continue;                                // 못 물으면 아무것도 안 한다
      }
      if (!exists) {
        // 🔴 **고치던 중인 창은 안 닫는다.** 저장 안 한 글을 밀어내는 것은
        //    도움이 아니라 사고다. 대신 그대로 두면 사람이 저장할 수 있다.
        const live = wins.filter(w => w.filePath === path);
        if (live.some(w => isWindowDirty(w.id))) continue;
        hoverActions.closeByFilePath(path);
        seen.delete(path);
        continue;
      }
      let rev = '';
      try {
        rev = stamp(await invoke<Rev>('get_file_revision', { path }));
      } catch {
        continue;
      }
      const was = seen.get(path);
      seen.set(path, rev);
      // 🔴 처음 본 것은 견줄 것이 없다. 「갈렸다」로 읽으면 창이 열리자마자
      //    한 번 다시 읽는 헛일을 한다.
      // 🔴 **자기가 방금 저장한 것을 「바깥 변화」로 읽으면 안 된다.**
      //    그러면 저장할 때마다 창이 한 번씩 다시 읽혀 글자가 튄다.
      //    이 저장소에 이미 있는 `selfSaveTracker` 가 그 판정을 한다.
      if (was !== undefined && was !== rev
          && filterExternalChanges([path]).length > 0) {
        hoverActions.refreshForFile(path);
      }
    }
  } finally {
    running = false;
  }
}

/** 화면이 뜰 때 한 번 부른다. */
export function startStaleWatch(): void {
  window.addEventListener('dobbin:live', (e) => {
    const d = ((e as CustomEvent).detail || {}) as { kind?: string };
    if (d.kind && d.kind !== 'vault-changed') return;
    // 🔴 **목록을 다시 부르는 자가 아무도 없었다.** 폴더 트리는 배지 수만
    //    새로 세고(FolderTree), 노트 목록(`Search.tsx`)은 `refreshTrigger`
    //    가 올라야 다시 묻는데 그것을 올리는 자가 없다 — 그래서 밖에서
    //    만든 노트가 **60초를 기다려도 목록에 안 나타났다** (실측).
    refreshActions.incrementSearchRefresh();
    void check();
  });
  void check();                                  // 처음 판을 적어 둔다
}

/** 시험용 — 감시를 손으로 한 번 돌린다. */
export const _checkNow = check;
