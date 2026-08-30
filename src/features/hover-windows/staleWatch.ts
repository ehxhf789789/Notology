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
type Watched = { path: string; gone?: boolean; mtime?: number };

/** 🔴 **자국.** 안 도는 것과 돌았는데 안 먹은 것은 다른 병인데, 자국이
 *  없으면 못 가른다 — 이 자리에서 실제로 한 시간을 잃었다. 마지막 40줄만
 *  들고 있으므로 값이 없다. `window.__stale` 로 본다. */
const trail: string[] = [];
function mark(s: string): void {
  trail.push(`${new Date().toISOString().slice(11, 19)} ${s}`);
  if (trail.length > 40) trail.shift();
  (window as unknown as Record<string, unknown>).__stale = trail;
}

let running = false;
const seen = new Map<string, { stamp: string; mtime: number }>();

/** 객체 판을 견줄 수 있는 한 줄로. */
function stamp(r: Rev): string {
  if (!r || typeof r !== 'object') return String(r);
  return `${r.hash ?? ''}:${r.mtime ?? ''}:${r.size ?? ''}`;
}

/** 창이 **열리는 순간** 바탕 판을 찍는다.
 *
 * 🔴 이것이 없으면 ② 가 통째로 안 된다 (실측 2026-08-30). 창을 연 뒤
 *    처음 도는 `check()` 가 곧 **그 변경을 알리는 알림**이라, 「견줄 것이
 *    없다」로 기록만 하고 넘어간다 — 사람 눈에는 아무 일도 안 일어난다.
 *    바탕은 알림이 아니라 **열림**에 맞춰 찍어야 한다.
 */
async function stampNew(): Promise<void> {
  const wins = useHoverStore.getState().hoverFiles || [];
  for (const path of new Set(wins.map(w => w.filePath).filter(Boolean))) {
    if (seen.has(path)) continue;
    seen.set(path, { stamp: '', mtime: 0 });     // 겹쳐 부르는 것을 막는다
    try {
      const r = await invoke<Rev>('get_file_revision', { path });
      seen.set(path, { stamp: stamp(r), mtime: (r && r.mtime) || 0 });
    } catch {
      seen.delete(path);
    }
  }
}

async function check(): Promise<void> {
  if (running) { mark('겹쳐서 건너뜀'); return; }
  running = true;
  try {
    const wins = useHoverStore.getState().hoverFiles || [];
    const paths = [...new Set(wins.map(w => w.filePath).filter(Boolean))];
    // 이제 안 열려 있는 것은 기억에서 지운다 — 다시 열면 첫 판부터 다시 잰다
    for (const p of [...seen.keys()]) if (!paths.includes(p)) seen.delete(p);
    mark(`창 ${wins.length} 경로 ${paths.length}`);
    await stampNew();                            // 방금 연 창의 바탕을 먼저

    for (const path of paths) {
      let exists = true;
      try {
        exists = await fileCommands.checkFileExists(path);
      } catch {
        continue;                                // 못 물으면 아무것도 안 한다
      }
      mark(`있음 ${exists} ${path.slice(-28)}`);
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
      let revMtime = 0;
      try {
        const r = await invoke<Rev>('get_file_revision', { path });
        rev = stamp(r);
        revMtime = (r && r.mtime) || 0;
      } catch {
        continue;
      }
      const was = seen.get(path)?.stamp;
      seen.set(path, { stamp: rev, mtime: revMtime });
      mark(`판 was=${(was ?? '없음').slice(0, 8)} now=${rev.slice(0, 8)}`);
      // 🔴 처음 본 것은 견줄 것이 없다. 「갈렸다」로 읽으면 창이 열리자마자
      //    한 번 다시 읽는 헛일을 한다.
      // 🔴 **자기가 방금 저장한 것을 「바깥 변화」로 읽으면 안 된다.**
      //    그러면 저장할 때마다 창이 한 번씩 다시 읽혀 글자가 튄다.
      //    이 저장소에 이미 있는 `selfSaveTracker` 가 그 판정을 한다.
      if (was !== undefined && was !== rev
          && filterExternalChanges([path]).length > 0) {
        mark('되읽기 부름');
        hoverActions.refreshForFile(path);
      }
    }
  } finally {
    running = false;
  }
}


/** 🔴 **열어 둔 것만 3초마다 되묻는다** — 20초짜리 전체 감시를 기다리지 않는다.
 *
 * `live.watched()` 가 바로 이 용도로 만들어져 있었다. 그 문서 그대로:
 *   *"열어 둔 노트는 많아야 몇 개이고, 그 몇 개만 `stat` 하면 밀리초다.
 *     안 보는 것이 바뀌었는지는 알 필요가 없다 — 볼 때 읽으면 그때 최신이다."*
 * 그런데 **명령으로 내놓지 않아 아무도 못 불렀다.** 이었다.
 *
 * 창이 없으면 아무것도 안 묻는다 — 놀 때 서버를 깨우지 않는다.
 */
async function pollWatched(): Promise<void> {
  const wins = useHoverStore.getState().hoverFiles || [];
  const paths = [...new Set(wins.map(w => w.filePath).filter(Boolean))];
  if (!paths.length) return;
  const known: Record<string, number> = {};
  for (const p of paths) known[p] = seen.get(p)?.mtime ?? 0;

  let rows: Watched[] = [];
  try {
    rows = (await invoke<Watched[]>('watched', { paths, known })) || [];
  } catch {
    return;                                      // 옛 서버면 조용히 넘어간다
  }
  for (const r of rows) {
    const base = seen.get(r.path);
    // 🔴 **바탕을 아직 못 찍었으면 아무것도 안 한다.** `stampNew` 가 판을
    //    묻는 동안 mtime 은 0 인데, 그 0 을 「알고 있는 값」으로 넘기면
    //    서버가 «갈렸다» 고 답한다 — 창을 열자마자 한 번 되읽어 글자가 튄다.
    if (!base || !base.mtime) continue;
    if (r.gone) {
      if (wins.filter(w => w.filePath === r.path).some(w => isWindowDirty(w.id))) continue;
      mark(`되물음: 사라짐 ${r.path.slice(-24)}`);
      hoverActions.closeByFilePath(r.path);
      seen.delete(r.path);
      continue;
    }
    if (filterExternalChanges([r.path]).length === 0) continue;   // 내가 방금 저장한 것
    seen.set(r.path, { stamp: base.stamp, mtime: r.mtime || base.mtime });
    mark(`되물음: 갈림 ${r.path.slice(-24)}`);
    hoverActions.refreshForFile(r.path);
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
    mark('알림 받음');
    refreshActions.incrementSearchRefresh();
    void check();
  });
  // 🔴 **창이 열릴 때마다** 바탕을 찍는다. 알림을 기다리면 늦다.
  useHoverStore.subscribe(() => { void stampNew(); });
  void check();                                  // 처음 판을 적어 둔다
  // 창이 열려 있을 때만 도는 값싼 되묻기 (열린 창 수만큼 stat, 왕복 1회)
  setInterval(() => { void pollWatched(); }, 3000);
}

/** 시험용 — 감시를 손으로 한 번 돌린다. */
export const _checkNow = check;
