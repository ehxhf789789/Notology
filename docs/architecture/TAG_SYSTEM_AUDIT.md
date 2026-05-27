# Tag System — Audit & Direction

> Cross-cutting tag-system audit performed 2026-05-17, after the
> chip-input migration hotfix series. Captures structural issues,
> HanBin's direction decisions, what shipped this cycle, and what
> remains as backlog for future sessions.

## A. Storage shape — current state

| Layer | Shape | Notes |
|---|---|---|
| **Rust `Frontmatter.tags`** (src-tauri/src/frontmatter/types.rs) | `FacetedTags` — 7 facets: `domain / who / org / ctx / source / method / status` | Source of truth on disk |
| **Tantivy search index** (src-tauri/src/search/mod.rs) | `Vec<String>` — flattened namespace-prefixed (`"domain/X"`, `"who/Y"`, `"source/Z"`, …) | Used by filter/autocomplete |
| **TS `NoteFrontmatter.tags`** (src/core/types/index.ts) | After 11th hotfix: `FacetedTags \| LegacyFlatTags \| undefined` | Previously misleading `string[]` |
| **TS `FacetedTagSelection`** (TagInputSection) | 4 facets only: `domain / who / org / ctx` | UI chip input — narrower than disk |

**Asymmetry**: disk + index carry 7 facets, UI exposes 4. Legacy notes with
`source / method / status` tags survive deserialize but can't be edited
through the chip wizard — they leak through as untouched fields.

## B. HanBin's direction decisions (2026-05-17 sign-off)

| Q | Question | Decision | Implementation status |
|---|---|---|---|
| Q1 | Hidden 3 facets (source/method/status) — keep, expose, or cleanup? | **4-facet 공식 — source/method/status 제거 클린업** | ✅ shipped 2026-05-18 (Rust struct slimmed; `deserialize_tags` folds legacy fields into `ctx`; TS `FacetedTags` mirrored; `syncTagsFromIndex` narrowed back to 4 facets; `getFlatTags` slimmed) |
| Q2 | Disk legacy flat-array `tags: ['foo','bar']` — silent drop, prompt, or auto-migrate? | **Rust deserializer 자동 마이그레이션 (prefix → 4-facet, unprefixed → ctx)** | ✅ shipped 2026-05-18 (`deserialize_tags` handles `Value::Sequence` with prefix-bucketing) |
| Q3 | Special modals (Contact/MTG/Paper/Lit/Event) — retire, keep, or partial? | **관찰 audit 추가 → 결과로 결정** | ✅ shipped 2026-05-18 (5 modal files + 5 store action pairs + 5 mount points + ParticipantInput + contact-modal.css all deleted; LEGACY_NOTE_TEMPLATES carry `userInputTokens` so TitleInputModal collects what the dedicated modals used to) |
| Q4 | 이번 세션 범위 우선순위? | **최소 안전 수정만** (syncTagsFromIndex + TS dead-code) | ✅ shipped 2026-05-17; Q1/Q2/Q3 also shipped 2026-05-18 |

## C. What shipped this session (11차 hotfix 묶음 일부)

### syncTagsFromIndex filter 확장
- **File**: `src/features/tags/tagOntologyUtils.ts:207`
- **Change**: `['domain','who','org','ctx']` → `['domain','who','org','ctx','source','method','status']`
- **Effect**: legacy 7-facet 태그가 ontology에 들어와 autocomplete에 노출됨. Q1 cleanup 전까지 데이터 손실 0.

### TS `NoteFrontmatter` 타입 정확화
- **File**: `src/core/types/index.ts:15`
- **Change**: `tags?: string[]` → `tags?: FacetedTags | LegacyFlatTags`
- **New types exported**: `FacetedTags` (7-facet, source/method/status는 `@deprecated` JSDoc), `LegacyFlatTags = string[]`
- **Effect**: 다운스트림 type-narrow 가능. parseFrontmatter cast 동기화.

## D. Q3 audit 결론 — Special modals (Contact/MTG/Paper/Lit/Event)

5개 모달 전수 확인 (관찰 audit agent):

| 모달 | Tag input 구조 | Form field | Recommend |
|---|---|---|---|
| ContactInputModal | TagInputSection (4-facet chip, collapsed) | name/email/company/position/phone/location | **Retire** |
| MeetingInputModal | TagInputSection (동일) | title/participants/date/time | **Retire** |
| PaperInputModal | TagInputSection (동일) | title/authors/year/venue/doi/url | **Retire** |
| LiteratureInputModal | TagInputSection (동일) | title/authors/year/publisher/source/url | **Retire** |
| EventInputModal | TagInputSection (동일) | title/date/location/organizer/participants | **Retire** |

**결론**: 태그 layer는 이미 통일. 5개 모달의 unique value = type별 form
field뿐인데, 이는 TitleInputModal의 `userInputTokens` + `TEMPLATE_VAR_CATALOG`
+ 시맨틱 input type 시스템이 이미 처리 가능. 모달 5개 전부 dead weight.

**Retire 경로 (별도 세션)**:
1. 각 템플릿(note-contact / note-mtg / note-paper / note-lit / note-event)에
   `userInputTokens: ['{{name}}', '{{email}}', ...]` 선언 추가
2. `appActions.ts:449-537` SPECIAL_TEMPLATE_IDS 분기 제거 → 모두 TitleInputModal 경로로
3. 5개 modal 파일 + show/hide store actions `@deprecated` 마크 후 제거

## E. 미해결 — next-session backlog (severity 순)

| # | Item | Severity | Source |
|---|---|---|---|
| ~~1~~ | ~~Rust `FacetedTags`에서 `source/method/status` 필드 제거 + 마이그레이션~~ | ~~MEDIUM~~ | ✅ done 2026-05-18 |
| ~~2~~ | ~~Rust deserializer: 평탄 array → 4-facet 자동 마이그레이션~~ | ~~MEDIUM~~ | ✅ done 2026-05-18 |
| ~~3~~ | ~~Special modals 5개 retire (TitleInputModal로 통합)~~ | ~~MEDIUM~~ | ✅ done 2026-05-18 |
| ~~4~~ | ~~(Q1 후속) `syncTagsFromIndex` filter 다시 4-facet으로 좁히기~~ | ~~LOW~~ | ✅ done 2026-05-18 |
| ~~5~~ | ~~(Q1 후속) `FacetedTags` 타입에서 `source/method/status` 필드 제거 + `@deprecated` 마크 제거~~ | ~~LOW~~ | ✅ done 2026-05-18 |
| ~~6~~ | ~~TagInputSection: 새 chip 입력 시 ontology 즉시 persist 여부 명세 + 구현~~ | ~~LOW~~ | ✅ already-shipped 확인 2026-05-18 ([TagInputSection.tsx:119-134](../../src/features/shared/TagInputSection.tsx#L119-L134) — handleAddTag가 ontology 미존재 chip을 자동으로 `addNewTag()` + `incrementOntologyRefresh()` 호출. 명세는 본 audit 문서로 commit) |
| ~~7~~ | ~~Template editor: `tagCategories`의 orphan 태그 검증~~ | ~~LOW~~ | ✅ no-op 결론 2026-05-18 (TagInputSection이 신규 chip을 즉시 ontology에 등록하므로 orphan 입력 자체가 불가. ontology에서 사후 삭제된 tag도 다음 노트 생성 시 syncTagsFromIndex가 재발견 → self-healing) |
| 8 | Mobile NoteListView 태그 입력 UI 부재 (현재 템플릿 default만 적용) | LOW | Audit gap (기능 부재, 회귀 아님) — Stage 5.0.10b/c~f 모바일 재설계 시 처리 예정 |

## F. Forward-facing notes — current chip-input flow (working correctly)

- 템플릿 정의 → 4-facet chip 입력 (TagInputSection)
- Ctrl+N → wizard에 template default chip pre-seed → 사용자 add/remove → 저장 시 userTags 그대로 frontmatter에 기록
- 마이그레이션 → 동일 wizard 경로 + oldFm의 7-facet은 ctx로 fold (2026-05-18 Q1 cleanup 완료)
- Bulk tag rename/delete (Rust) → 모든 facet에서 작동 (namespace-aware)
- **신규 chip → ontology 즉시 등록** (`TagInputSection.handleAddTag` → `addNewTag()` + ontology refresh trigger)

## G. Audit 종결 상태 (2026-05-18)

| Severity | Open | Total |
|---|---|---|
| MEDIUM | 0 | 3 |
| LOW | 1 (item 8 — 모바일 재설계로 이관) | 5 |

**Tag 시스템 audit 종결**. 남은 1건은 Stage 5.0.10 모바일 재설계 트랙으로 이관.
