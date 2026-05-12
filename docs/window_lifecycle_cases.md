# Window Lifecycle — Strict Hierarchy + 50 Verification Cases

Strict hide/show + lifecycle policy for Notology's three window kinds.
Target platforms: **Windows + Android only** (macOS is out of scope).

## Window kinds

- **M** — Main window (label `"main"`). The editor / content shell.
  Singleton. App entry point when a vault is open.
- **S** — Vault selector window (label `"vault-selector"`). Entry-time
  vault picker, also used for "보관소 변경". Singleton, transient.
- **H** — Hover window (label `"hover-{hash}-{counter}"`). File preview
  spawned from M. Independent OS window (own taskbar entry, free
  z-order). 0..n instances.

## Strict hierarchy rules

These rules are the contract. Code (`state.rs` transitions, lib.rs
window event handlers, App.tsx cleanup) enforces them.

1. **M ↔ S 동시 표시 금지**.
   - 시작 시 M 또는 S 중 정확히 하나가 visible
   - "보관소 변경" 시: M hide → S show (atomic via dispatcher)
   - vault 선택 시: M show → S close (atomic via dispatcher)

2. **H 는 M 종속, 단 OS 레벨로는 독립**.
   - 독립이라는 의미: 별개 OS 윈도우, 별개 taskbar entry, 자유 z-order,
     다중 모니터 자유 이동, 자유 minimize/restore
   - 종속이라는 의미: M close 시 모든 H 강제 close (orphan H 금지)
   - 구현: OS 레벨 `parent_label` 사용하지 않음 (z-order 잠김 부작용).
     대신 명시적 chain-close (App.tsx onCloseRequested →
     closeAllHoverWindows + lib.rs MainCloseRequested 핸들러)

3. **H + S 동시 표시 금지**.
   - "보관소 변경" 발동 시 state.rs SwitchVaultRequested 전이가
     모든 H 에 대해 CloseHover effect 발행
   - S 가 visible 인 상태에서는 새 H 생성 불가 (state.rs HoverOpenRequested
     transition 이 MainOnly 가 아니면 no-op)

4. **앱 종료 = 모든 윈도우 종료**.
   - M close 또는 S close (return_to=None) 시 `app.exit(0)`
   - 잔존 H 는 explicit close 후 OS 가 프로세스 종료로 정리

5. **Minimize = OS native**.
   - H 의 커스텀 `_` 버튼은 `getCurrentWindow().minimize()` 호출
   - taskbar / Alt-Tab / 가상 데스크탑 등 OS 기능에 위임
   - 커스텀 in-app overview UI 없음 (CollapsedHoverBar 폐기됨)

## States (see `src-tauri/src/features/window_lifecycle/state.rs`)

```
Splash                                    // startup, deciding entry
SelectorOnly { return_to: Option<vault> } // S visible, M hidden
MainOnly { vault, hovers }                // M visible, S closed
Exiting                                   // cleanup in flight
```

`return_to`:
- `None` → S close = exit app (came in at startup)
- `Some(vault)` → S close = restore M with that vault ("보관소 변경" cancel)

---

## A. 초기 진입 (6 cases)

| ID | 시작 상태 | 트리거 | 기대 결과 | 검증 |
|----|-----------|--------|-----------|------|
| A1 | WebDAV 미설정 | 첫 실행 | `SelectorOnly{None}` (로그인 화면) | unit + manual |
| A2 | WebDAV ✓, vault 미선택 | 첫 실행 | `SelectorOnly{None}` (vault 목록) | unit + manual |
| A3 | 마지막 vault 정상 | 재실행 | `MainOnly{last, []}` | unit + manual |
| A4 | 마지막 vault 로컬 폴더 소실 | 재실행 | `SelectorOnly{None}` + 오류 토스트 | unit + manual |
| A5 | 마지막 vault, NAS 오프라인 | 재실행 | `MainOnly{last, []}` (offline indicator) | manual |
| A6 | 비정상 종료 직후 (lock 잔재) | 재실행 | `MainOnly` + Tantivy lock 정리 로그 | manual + log grep |

## B. "보관소 변경" 흐름 (7)

| ID | 시작 | 트리거 | 기대 | 검증 |
|----|------|--------|------|------|
| B1 | `MainOnly{v, hs}` | "보관소 변경" | `SelectorOnly{Some(v)}`; H 모두 close; M hidden; taskbar 1개 | unit + manual |
| B2 | `SelectorOnly{Some(v)}` | 같은 vault `v` 선택 | `MainOnly{v, []}` | unit |
| B3 | `SelectorOnly{Some(v1)}` | 다른 vault `v2` 선택 | `MainOnly{v2, []}` + sync engine 재시작 로그 | unit + log |
| B4 | `SelectorOnly{Some(v)}` | "보관소 생성" → 완료 | `MainOnly{new, []}` | manual |
| B5 | `SelectorOnly{Some(v)}` | vault "삭제" 클릭 | `SelectorOnly{Some(v)}` 유지 (목록 갱신) | manual |
| B6 | `SelectorOnly{Some(v)}` | S 의 X | `MainOnly{v, []}` (M 복귀, 취소 의미) | unit + manual |
| B7 | `MainOnly` (unsaved 편집) | "보관소 변경" | hide 직전 모든 dirty buffer flush 완료 | log + 파일 mtime |

## C. Selector 단독 종료 (6) — startup 진입 분기

| ID | 시작 | 트리거 | 기대 | 검증 |
|----|------|--------|------|------|
| C1 | `SelectorOnly{None}` | S 의 X | **app exit** | unit + manual |
| C2 | `SelectorOnly{Some(v)}` | S 의 X | **M 복귀** (B6 와 동일 로직) | unit |
| C3 | `SelectorOnly{None}` (WebDAV 미연결) | S 의 X | **app exit** | manual |
| C4 | `SelectorOnly{None}` + NAS 오프라인 | S 의 X | **app exit** | manual |
| C5 | `SelectorOnly{None}` + 생성 모달 떠있음 | 생성 모달 X → S 의 X | 생성 취소 후 app exit | manual |
| C6 | `SelectorOnly{None}` + 시스템 sleep/wake | wake 후 S 의 X | **app exit** (상태 보존) | manual |

## D. Hover 윈도우 lifecycle (10)

| ID | 시작 | 트리거 | 기대 | 검증 |
|----|------|--------|------|------|
| D1 | `MainOnly{v, []}` | wikilink 클릭 | `MainOnly{v, [h1]}`; H 의 `parent_label="main"` | manual + WebviewWindow 속성 |
| D2 | `MainOnly{v, []}` | 첨부 (PDF/DOCX) 클릭 | 동일 (D1) | manual |
| D3 | `MainOnly{v, [h1]}` | 같은 파일 다시 클릭 | 기존 H focus, 새 H 생성 안 함 | manual |
| D4 | `MainOnly{v, [h1]}` | 다른 파일 클릭 | `[h1, h2]` | manual |
| D5 | `MainOnly{v, [h1, h2]}` | h1 의 X | `[h2]`; M, h2 영향 없음 | manual |
| D6 | `MainOnly{v, [h1, h2]}` | M minimize | OS 가 H 도 minimize (parent_label) | manual |
| D7 | D6 상태 | M restore | H 들 같이 restore | manual |
| D8 | `MainOnly{v, [h1]}` | "보관소 변경" | h1 close → `SelectorOnly{Some(v)}` (B1 의 효과) | unit + manual |
| D9 | `MainOnly{v, [h1, h2]}` | M 의 X | H 자동 close + app exit | manual + process tree |
| D10 | `MainOnly{v, [h1]}` + h1 원본 파일 외부 삭제 | (자동) | h1 자동 close | manual |

## E. 메인 종료 (5)

| ID | 시작 | 트리거 | 기대 | 검증 |
|----|------|--------|------|------|
| E1 | `MainOnly` (깨끗) | M 의 X | save flush → sync teardown → exit | log 순서 + exit 0 |
| E2 | `MainOnly` (unsaved 편집) | M 의 X | dirty buffer flush 완료 후 exit | 파일 mtime + log |
| E3 | `MainOnly` (sync 진행 중) | M 의 X | 안전 시점 abort 후 exit; dirty queue 빔 | log + queue 확인 |
| E4 | `MainOnly` + S race condition 동시 visible | M 의 X | 둘 다 close, app exit | manual (재현 어려움) |
| E5 | `MainOnly` | Windows shutdown signal | graceful exit | event viewer |

## F. Race condition / 동시성 (8)

| ID | 시작 | 동시 트리거 | 기대 | 검증 |
|----|------|-------------|------|------|
| F1 | `MainOnly` | "보관소 변경" + 0ms 내 M 의 X | events serialized; second wins, app exit | unit |
| F2 | `MainOnly` | "보관소 변경" 두 번 빠르게 | S 1개만 (singleton enforced by mode) | manual + log |
| F3 | `SelectorOnly{Some(v)}` | vault 선택 직후 S 의 X | vault 진입 wins (event 순서) | unit |
| F4 | `MainOnly` | 두 H 가 같은 파일 동시 열기 | 1개만 생성 (multiWindow dedupe) | unit |
| F5 | `MainOnly{v, [h1]}` | M close + 새 H open 동시 | close 우선; open 무시 | manual |
| F6 | `MainOnly` (sync push 중) | "보관소 변경" | sync teardown 후 S 진입 | log |
| F7 | `SelectorOnly{Some(v)}` | M 의 background sync timer fires | 무시 (M hidden 동안 sync 동결) | unit |
| F8 | `MainOnly` 에서 vault config 외부 손상 | 다음 sync tick | `SelectorOnly{None}` fallback + 오류 | manual |

## G. 에러 / 복구 (5)

| ID | 시작 | 트리거 | 기대 | 검증 |
|----|------|--------|------|------|
| G1 | 임의 상태 | Task Mgr 에서 S 강제 종료 | S 가 parent 없음 → 단독 종료; M 영향 없음 (문서화 한계) | manual |
| G2 | `MainOnly{v, [h1, h2]}` | Task Mgr 에서 M 강제 종료 | parent_label 로 H 도 OS 가 정리 | process tree |
| G3 | `MainOnly` | NAS 연결 끊김 | M 유지, 오프라인 인디케이터, exit 흐름 정상 | manual |
| G4 | `SelectorOnly{None}` | "보관소 생성" 시 디스크 풀 | 오류 표시, S 유지, 닫기 동작 정상 | manual (artificial) |
| G5 | `MainOnly` | 잘못된 vault config (remote_path 손상) | `SelectorOnly{None}` 로 자동 fallback + 토스트 | manual |

## H. Android / 모바일 (5)

| ID | 시작 | 트리거 | 기대 | 검증 |
|----|------|--------|------|------|
| H1 | `MainOnly{v}` | 홈 버튼 (앱 background) | 상태 보존, dirty queue 유지 | manual on device |
| H2 | `MainOnly{v}` | OS 가 메모리 부족으로 kill, 재진입 | A3 흐름 (마지막 vault 복원) | manual |
| H3 | `MainOnly` | 화면 회전 | vault state 유지, layout 재구성만 | manual |
| H4 | `SelectorOnly{None}` | Android back button | **app exit** (C1 의 모바일 등가) | manual |
| H5 | `MainOnly` | Android back button | save → vault-level back navigation (편집기/컨테이너 내 back) | manual |

---

## 자동화 매트릭스

| 자동화 수준 | 케이스 ID | 비율 |
|-------------|-----------|------|
| **Rust 단위** (state machine) | A1·A2·A3·A4, B1·B2·B3·B6·B7, C1·C2, D1·D3·D4·D5·D8, E1·E2·E3, F1·F2·F3·F4·F7 | 25/50 (50%) |
| **Tauri 통합** (mock window manager) | A6, B4·B5, D6·D7·D9·D10, E5, F5·F6·F8 | 12/50 (24%) |
| **수동 UI** (환경 의존) | A5, C3·C4·C5·C6, E4, G1·G2·G3·G4·G5, H1·H2·H3·H4·H5 | 13/50 (26%) |

## 진행 순서

1. **상태머신 추출**: `transition()` + Rust 단위 테스트 25개
2. **6 코드 변경 반영**:
   - Hover 윈도우 `parent_label: "main"`
   - "보관소 변경" 클릭 시 M `hide()` 추가
   - S 의 `CloseRequested` 핸들러 신설 (mode 의 `return_to` 로 분기)
   - vault-selected listener 가 hidden→show 정상 처리 확인
   - M `CloseRequested` 에서 S 도 cleanup
   - App.tsx 의 수동 hover cleanup 제거 검토 (parent_label 로 자동화 시)
3. **통합 테스트 12개**: `tauri::test` + mock Window manager
4. **수동 13개**: 본 문서 체크리스트로 sign-off
5. 회귀 발견 시 본 문서에 케이스 추가
