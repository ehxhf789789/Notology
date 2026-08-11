# web notology

**Obsidian을 대체하는 웹.** notology 데스크톱 앱(`main` 브랜치)에서 갈라져 나왔고,
로컬 앱 전용 기능을 들어낸 뒤 dobbin 서버 위에 다시 세웠다.

```
데스크톱 notology            web notology
Tauri v2 (Rust) + React  →  React + dobbin (Python/PostgreSQL)
Tantivy 색인             →  pg_bigm + pgvector (청크 28,495)
WebDAV 동기화             →  없음 — 서버가 NAS를 직접 마운트한다
창 3종 (본창·선택·hover)   →  브라우저 창 하나
```

## 무엇을 들어냈나

| 걷어낸 것 | 왜 |
|---|---|
| `src-tauri/` (Rust 130파일) · `relay-server/` | 백엔드가 dobbin으로 바뀌었다 |
| `sync_v2` WebDAV 부분 | 서버가 NAS를 직접 든다 — 어긋날 두 벌이 없다 |
| `connection` (WebDAV 연결·보관함 선택) | 보관함은 서버가 정한다 |
| `migration` · `faststart-migration` | 데스크톱 보관함 이관 절차 |
| `window-lifecycle` · `multiWindow` · `TitleBar` | 브라우저에 창 관리가 없다 |
| `UpdateChecker` | 웹은 새로고침이면 최신이다 |

**결과: 번들 3,858KB → 2,027KB.** 절반이 로컬 전용 코드였다.

## 🔴 이름이 같다고 같은 것이 아니다

`sync_v2` 아래에 성격이 다른 둘이 섞여 있었다:

```
WebDAV 동기화     syncV2Commands · 연결 화면 · 충돌 해소     ← 로컬 전용
첨부 생명주기      attachmentStore · 삭제 · 고아 정리 · 휴지통  ← 웹에도 필요
```

뒷것은 **위키링크 칩과 첨부 탭의 본체**이고 `invoke`/`webdav` 호출이 0회다.
이름 하나 때문에 지울 뻔했고, 실제로 지웠다가 되살렸다.
→ `features/attachments/` 로 갈라 나왔다.

같은 일이 `hover-windows`에도 있었다. 이름은 "창"인데 **OS 창이 아니라
페이지 안 떠 있는 패널**이다(네이티브 창 API 사용 0회). 브라우저에서 그대로 된다.

## 웹 런타임 — `src/web/`

호출부 52개 파일은 그대로 두고 **경계만 갈아끼웠다.** 본가(데스크톱)의
개선을 나중에 가져오려면 경계가 한 곳이어야 한다.

| | 무엇을 대신하나 |
|---|---|
| `core.ts` | `invoke()` → `POST /api/invoke`. 모르는 명령은 `window.__MISSING__`에 모은다 |
| `event.ts` | 창 간 이벤트 → 브라우저 안 `EventTarget` |
| `window.ts` | 창 관리 → 없다. 부르는 쪽이 죽지 않게만 한다 + 브라우저 드래그·드롭 |
| `path.ts` | `루트:상대경로` 문자열 조작 |
| `store.ts` | 설정을 **서버에** 둔다 — 기기마다 갈리면 웹으로 옮긴 뜻이 없다 |
| `dialog.ts` | 폴더 선택 없음. 파일 넣기는 업로드다 |
| `os.ts` · `webview.ts` | 브라우저가 아는 만큼만 |

## 빌드

```bash
npm install
npx vite build --base=/app/     # dobbin이 /app 아래로 서빙한다
```
