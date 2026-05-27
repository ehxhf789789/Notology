# Notology Microcopy Guide

> Established at Stage 5.0.11 (2026-05-17, HanBin sign-off). Next review:
> Stage 5.0.12 closeout. Quarterly tone-audit recommended.

## 1. Tone & formality

### Primary tone: **Command / imperative (plain form)**

- **When to use:** Button labels, action labels, section headings, toolbar items, tab labels.
- **Example:**
  - `'설정 열기'` (Open Settings) — ✅ command form
  - `'설정을 열어 주세요'` (formal request) — ❌ stilted
- **Rationale:** UI actions are direct imperatives; the user has the agency. We're labeling what the affordance does, not asking permission.

### Secondary tone: **Nominal / state (descriptive)**

- **When to use:** Status indicators, descriptions, labels, empty states, inline metadata.
- **Example:**
  - `'활동 중'` (Active) — ✅ noun form, terse
  - `'노트가 없습니다'` (No notes) — ✅ formal statement OK for empty states
  - `'로딩되고 있습니다'` — ❌ over-formal; use `'로딩 중...'` instead
- **Guideline:** Prefer **plain nouns** where possible (`'로딩 중'`, not `'로딩되고 있습니다'`).
- **Exception:** Long-form explanatory copy may use formal 합니다 for politeness:
  - ✅ `'이 기능은 NAS 연결 시에만 동작합니다.'`

### Avoid in UI

- **Informal casual** (반말 / 해체) — too familiar for a productivity tool.
- **Over-formal requests** (해 주세요 / 하십시오) — sounds stilted in modern desktop/mobile UX.
- **Mixed tones in the same section** — don't have a plain-form button next to a 합니다-form sibling description. Pick one register per surface.

## 2. Standard terminology

| Korean term | Recommended English | Context | Notes |
|---|---|---|---|
| **볼트** | Vault | Primary storage container | Never "폴더" / "Folder" in this slot. Aligns with Obsidian convention. |
| **노트** | Note | Individual `.md` document | Never "문서" / "Document" — keeps the PKM idiom. |
| **첨부** / **첨부파일** | Attachment | Files embedded in or linked from notes | Use **첨부** for short labels (5 chars), **첨부파일** for sentences. |
| **동기화** | Sync | NAS ↔ local replication | Never "동기" alone. |
| **보관소 상태** | Vault Status | Multi-device panel in Settings | Renamed from "연결된 기기" per 5.0.6d. |
| **브랜치** / **병합** | Branch / Merge | Sync-conflict resolution | Keep the Git metaphor. **Smart Merge** stays in English. |
| **휴지통** | Trash | Soft-delete bin (recoverable for N days) | Never "삭제됨" as a state. |
| **컨테이너** | Container | Folder with a folder-note acting as a section root | Already mobile + desktop canonical. |
| **템플릿** | Template | NoteTemplate definition | Used in Settings + creation wizard. |
| **검색** | Search | Full-text + frontmatter query | Avoid "찾기" / "Find" — search is the verb. |

## 3. Phrase patterns

| Pattern | Example | Form |
|---|---|---|
| Loading | `'로딩 중...'` | Plain noun + ellipsis |
| Success / completion | `'{count}개 항목 비움'` | State noun (no 했습니다) |
| Empty | `'노트 없음'` or `'노트가 없습니다.'` | Either; prefer plain for terse labels, formal for stand-alone explanations |
| Confirm | `'"{path}" 을(를) 영구 삭제합니다. 되돌릴 수 없습니다.'` | Formal 합니다 — gravity warrants it |
| Error | `'충돌 파일을 불러올 수 없습니다.'` | Formal 합니다 — softens the failure |
| Tooltip / hint | `'키보드 단축키는 설정에서 변경할 수 있습니다.'` | Formal 합니다 acceptable |
| Section heading | `'최근 노트'`, `'보관소 상태'` | Plain noun, no 함 / 합니다 |

## 4. Decision tree

```
Is this a button / action / tab / section label?
  └─ YES → Plain command form  ('열기', '저장', '삭제')

Is this a status / state chip?
  └─ YES → Plain noun  ('로딩 중', '오프라인', '활동 중')

Is this an empty-state message inside a panel?
  └─ Short label → Plain noun  ('노트 없음')
  └─ Standalone sentence → Formal 합니다 OK  ('노트가 없습니다.')

Is this a help text / tooltip / hint?
  └─ YES → Formal 합니다 OK for politeness

Is this a warning / confirmation / error?
  └─ YES → Formal 합니다 reinforces gravity

Is this a section / category heading?
  └─ YES → Plain noun
```

## 5. Exceptions & special cases

- **Multi-device sync messages** may lean slightly more formal to reinforce the seriousness of cross-device state. (`'다른 기기에서 충돌이 발생했습니다'` is OK.)
- **Keyboard hints** use symbols, not words. (`'↑'`, not `'위'`.)
- **Date / time** use ISO format or natural language:
  - Relative: `'{n}분 전'` (N minutes ago)
  - Absolute: `'2026-05-17 14:32'`
- **WebDAV / SmartMerge / faststart / etc.** stay in English. Technical terms with no Korean idiom should remain transliterated or English.

## 6. New-key review checklist

When adding a key to `src/core/utils/i18n.ts`:

- [ ] Tone matches the prefix group's existing register (`cmd*`, `vault*`, `trash*`, `mig*`, `cal*`, `conflict*`, `mobile m*`).
- [ ] No 합니다 mixed with plain in adjacent UI controls.
- [ ] Terminology matches §2 table (Vault / Note / Attachment / Sync / etc.).
- [ ] Button/action labels use imperative (`'삭제'`, not `'삭제하기'`).
- [ ] Empty/error states use plain nouns when possible.
- [ ] No English-only terminology unless §5 says so.
- [ ] Both `ko` and `en` blocks updated in the same commit (5.0.11 audit verified 1361/1361 parity).

## 7. Known prefixes — current tone status

| Prefix | Tone | Status |
|---|---|---|
| `mig*` (Migration v1→v2 upgrade) | Command / formal warning hybrid | ✅ Consistent |
| `fsmig*` (Faststart) | Same as `mig*` | ✅ Consistent |
| `cmd*` (Command palette) | Plain command | ✅ Consistent |
| `nasBrowser*`, `vs*` (Vault Selector) | Plain command + nominal | ✅ Consistent |
| `vault*` (Vault Status panel) | Mixed formal + plain | ⚠️ Reconciliation pass needed |
| `trash*` (Trash panel) | Mixed formal + plain | ⚠️ Reconciliation pass needed |
| `calendar*` / `cal*` (Calendar) | Mixed formal + plain | ⚠️ Reconciliation pass needed |
| `conflictList*` (Conflict list modal) | Mixed formal + plain | ⚠️ Reconciliation pass needed |
| `m*` (mobile views) | Plain (newly aligned in 5.0.10a) | ✅ Consistent |

**Reconciliation pass deferred:** the 4 mixed prefixes touch ~80 keys total. A
dedicated tone-pass would land in a follow-up sub-stage (5.0.11-followup) where
each key is reviewed against §4 and rewritten to the canonical register.

## 8. Source of truth

- All UI strings live in `src/core/utils/i18n.ts` keyed under `ko` and `en` blocks.
- `t(key, language)` / `tf(key, language, params)` exported from the same file.
- 5.0.11 verified 1361 keys × 2 languages = perfect parity. Adding a key to one
  block without the other is a tone-and-parity violation.

---

**Established:** Notology 5.0.11 by HanBin (2026-05-17)
**Audit cadence:** Quarterly tone pass; parity check on every release.
