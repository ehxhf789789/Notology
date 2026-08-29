/**
 * TemplateMigrationPromptModal — 5.0.5a-migration B (HanBin 2026-05-17).
 *
 * Shown by hoverActions.open when the user tries to open a note whose
 * frontmatter `type:` doesn't match any registered template. Two paths:
 *   1. "이 노트를 변환" — pick a target template; the note is rewritten
 *      with the target's frontmatter + body skeleton, then the original
 *      body content is appended UNDER the new skeleton. Attachments stay
 *      put (the note keeps its filename, so the `<stem>_att/` folder + all
 *      `![[file]]` wikilinks continue to resolve).
 *   2. "그대로 열기" — open without rewriting (legacy data preserved).
 *
 * The target template's body (with `{{title}}` etc.) is INSERTED FIRST so
 * any required form fields appear at the top of the note; existing legacy
 * content is preserved under a "기존 내용" section divider so nothing is
 * lost.
 */
import { seedFacetSelection } from '../shared/TagInputSection';
import type { FacetedTagSelection } from '../shared/TagInputSection';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, FileText, ArrowRight } from 'lucide-react';
import { useTemplateMigrationPromptStore, templateMigrationPromptActions } from './templateMigrationPromptStore';
import { useTemplateStore } from './stores/templateStore';
import { useLanguage } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';
import { Button } from '../../design-system/components';
import { fileCommands, frontmatterCommands } from '../../core/services/tauriCommands';
import { showToast } from '../shared/Toast';
import { noteTypeCacheActions } from '../content-cache/stores/noteTypeCacheStore';
import { useEscapeKey } from '../shared/useEscapeKey';
// 5.0.5a-migration v2 (2026-05-17, HanBin hotfix) — when the target
// template body contains user-input `{{vars}}` (role / aliases / etc.),
// route through the same NoteCreationWizard the Ctrl+N flow uses so the
// user can fill them in BEFORE write. Without this the placeholders
// landed in the file as literal text.
import { hasUserInputVars, scanUserInputVars, buildSubstitutionMap } from './templateVarScan';
import { modalActions } from '../modals/stores/modalStore';
import type { NoteTemplate } from '../../core/types';

interface ParsedNoteShape {
  frontmatter: Record<string, unknown> | null;
  body: string;
}

/**
 * Demote every ATX heading in `md` by one level so the migrated body
 * slots cleanly UNDER the "변환전 기존 내용" H1 divider written by
 * performMigration. H6 is the markdown ceiling — already-H6 headings
 * stay at H6 (there's no H7).
 *
 * Skips lines inside fenced code blocks so leading `#` comments in code
 * snippets (Python / shell / etc.) aren't mistaken for headings.
 * Setext headings (`Title\n===` / `Title\n---`) are left alone — TipTap
 * always emits ATX so legacy bodies authored in Notology don't use them;
 * imported notes with setext are an out-of-scope edge case.
 */
function demoteHeadings(md: string): string {
  if (!md) return md;
  let inFence = false;
  return md.split('\n').map(line => {
    if (/^\s{0,3}```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    const m = /^(\s{0,3})(#{1,6})(\s+)(.*)$/.exec(line);
    if (!m) return line;
    const [, indent, hashes, sp, content] = m;
    const next = hashes.length < 6 ? hashes + '#' : hashes;
    return `${indent}${next}${sp}${content}`;
  }).join('\n');
}

export function TemplateMigrationPromptModal() {
  const language = useLanguage();
  const prompt = useTemplateMigrationPromptStore(s => s.prompt);
  const noteTemplates = useTemplateStore(s => s.noteTemplates);
  const [selectedId, setSelectedId] = useState<string>('');
  const [running, setRunning] = useState(false);

  // Reset selection whenever a new prompt opens.
  useEffect(() => {
    if (prompt) setSelectedId('');
  }, [prompt?.path]);

  useEscapeKey(() => {
    if (!running && prompt) {
      prompt.onResolved('cancelled');
      templateMigrationPromptActions.hide();
    }
  }, !!prompt);

  if (!prompt) return null;

  const fileName = prompt.path.split(/[/\\]/).pop()?.replace(/\.md$/, '') || prompt.path;
  // 8th hotfix — explicit-convert mode (triggered from a note's right-click
  // "템플릿 변환" item). Drops the "그대로 열기" escape hatch and uses
  // action-oriented copy. unmatched-warning mode keeps the original UX.
  const isExplicit = prompt.mode === 'explicit-convert';

  const openAsIs = () => {
    prompt.onResolved('opened-as-is');
    templateMigrationPromptActions.hide();
  };

  const cancel = () => {
    if (running) return;
    prompt.onResolved('cancelled');
    templateMigrationPromptActions.hide();
  };

  /**
   * Apply substitution + write. Called either directly (no user-input vars)
   * or via the NoteCreationWizard callback (after the user fills values).
   *
   * 10th hotfix (2026-05-17, HanBin) — `userTags` param added so the
   * wizard's tag selection (pre-seeded with target template defaults +
   * any user edits) lands in the migrated note's frontmatter. Without
   * this, the wizard's tag chips were visible but ignored at write.
   */
  const performMigration = async (
    target: NoteTemplate,
    titleForBody: string,
    varValues: Record<string, string>,
    userTags?: FacetedTagSelection,   // 🔴 축을 손으로 적지 않는다 (2026-08-29)
  ) => {
    if (!prompt) return;
    setRunning(true);
    try {
      // Read raw content + parse current frontmatter.
      const raw = await fileCommands.readTextFile(prompt.path);
      const parsed = await frontmatterCommands.parseFrontmatter<ParsedNoteShape>(raw);
      const oldFm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
      const oldBody = parsed.body || '';

      // Merge: keep existing id / title / dates etc., but swap type +
      // cssclasses + any explicit defaults the target template defines.
      const targetFmDefaults = target.frontmatter as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...oldFm };
      for (const [k, v] of Object.entries(targetFmDefaults)) {
        if (merged[k] === undefined || k === 'type' || k === 'cssclasses') {
          merged[k] = v;
        }
      }
      // Title override: if the user typed a fresh title in the wizard
      // (different from the existing filename / frontmatter title), honor it.
      if (titleForBody && titleForBody !== fileName) {
        merged.title = titleForBody;
      }

      // 10th hotfix (2026-05-17, HanBin) — apply wizard's tag selection
      // to merged.tags. wizard was pre-seeded with target template's
      // tagCategories so any post-edit value is the canonical 4-facet
      // choice. Old note's other facets (source/method/status — not
      // exposed in wizard) are preserved.
      if (userTags) {
        const oldTags = (merged.tags && typeof merged.tags === 'object') ? merged.tags as Record<string, unknown> : {};
        merged.tags = {
          ...oldTags,
          ...Object.fromEntries(
            Object.entries(userTags).map(([k, v]) => [k, [...(v || [])]])),
        };
      }

      // Build substitution map — same helper Ctrl+N uses, so auto-fill
      // tokens (date / today / weekday / etc.) + user-input values land
      // together. `title` defaults to the existing filename when the user
      // didn't edit it in the wizard.
      const subMap = buildSubstitutionMap(varValues, {
        title: titleForBody,
        prefix: target.prefix,
        type: String(target.frontmatter.type || ''),
        filename: fileName,
        id: typeof oldFm.id === 'string' ? oldFm.id : undefined,
      });

      // Substitute {{key}} → value across the target body. Same loop the
      // FolderNoteTemplate variant uses.
      let targetBody = target.body || '';
      for (const [key, value] of Object.entries(subMap)) {
        targetBody = targetBody.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
      }
      if (targetBody && !targetBody.endsWith('\n')) targetBody += '\n';

      const dividerHeader = language === 'ko'
        ? '\n\n---\n\n# 변환전 기존 내용\n\n'
        : '\n\n---\n\n# Content before conversion\n\n';
      // Demote old body's headings by one level so they nest under the
      // H1 divider above (H1→H2, H2→H3, ..., H6 stays H6). Plain text /
      // lists / code blocks / links etc. are untouched.
      const demotedOld = demoteHeadings(oldBody);
      const newBody = (targetBody || '') + (oldBody.trim() ? dividerHeader + demotedOld : '');

      // Persist: yaml-serialize + writeFile.
      const yaml = await frontmatterCommands.frontmatterToYaml<string>(JSON.stringify(merged));
      await fileCommands.writeFile(prompt.path, yaml, newBody);

      // Refresh the type cache so the sidebar's type column updates.
      noteTypeCacheActions.invalidate();
      await noteTypeCacheActions.refreshCache();

      showToast({
        type: 'success',
        title: language === 'ko'
          ? `"${fileName}" 노트가 "${target.name}" 템플릿으로 변환되었습니다.`
          : `"${fileName}" migrated to "${target.name}".`,
      });

      prompt.onResolved('migrated');
      templateMigrationPromptActions.hide();
    } catch (err: any) {
      console.error('[TemplateMigrationPrompt] migration failed:', err);
      showToast({
        type: 'error',
        title: language === 'ko' ? '템플릿 변환 실패' : 'Migration failed',
        description: String(err?.message ?? err),
      });
    } finally {
      setRunning(false);
    }
  };

  const migrate = async () => {
    if (!selectedId || running) return;
    const target = noteTemplates.find(tpl => tpl.id === selectedId);
    if (!target) return;

    // If the target body has user-input `{{vars}}`, route through the
    // unified TitleInputModal — same wizard the Ctrl+N flow opens after
    // v20 (NoteCreationWizard removed; variable inputs inline in
    // TitleInputModal). We pass the existing filename as the pre-filled
    // title (user can override) + the discovered token list so the modal
    // renders one field per variable.
    if (hasUserInputVars(target.body || '')) {
      const tokens = scanUserInputVars(target.body || '').map(s => s.token);
      const tplType = String(target.frontmatter.type || '').toLowerCase();
      modalActions.showTitleInputModal(
        async (result) => {
          if (!result.title.trim()) return;
          await performMigration(
            target,
            result.title.trim(),
            result.varValues ?? {},
            result.tags,
          );
        },
        // placeholder
        language === 'ko' ? '노트 제목' : 'Note title',
        // Modal HEADER — shows the existing note's name so the user sees
        // which note is being migrated. (Not the input pre-fill.)
        fileName,
        {
          name: target.name,
          prefix: target.prefix,
          description: language === 'ko'
            ? `미확인 템플릿(${prompt.noteType})을 "${target.name}"으로 변환`
            : `Migrate unidentified template (${prompt.noteType}) to "${target.name}"`,
          noteType: tplType,
          customColor: target.customColor,
          icon: target.icon,
        },
        tokens,
        // Hotfix (2026-05-17, HanBin) — pre-fill the INPUT with the
        // existing filename so the user doesn't have to retype the note's
        // title during migration. Auto-fill is the whole point of this
        // flow; a blank input defeats it.
        fileName,
        // 10th hotfix (2026-05-17, HanBin) — pre-seed wizard tag chips
        // from target template's tagCategories (same as Ctrl+N flow).
        // Migration's performMigration writes tags via its own merge
        // (oldFm.tags preserved), so this purely surfaces what the user
        // will be adopting from the target template.
        {
          ...seedFacetSelection(target.tagCategories),
        },
      );
      return;
    }

    // No vars — run migration directly with the existing filename as title.
    await performMigration(target, fileName, {});
  };

  return createPortal(
    <div className="tpl-migrate-overlay" onClick={cancel}>
      <div className="tpl-migrate-modal" onClick={e => e.stopPropagation()}>
        <div className="tpl-migrate-header">
          <div className="tpl-migrate-title-row">
            <FileText size={16} className="tpl-migrate-title-icon" />
            <h3 className="tpl-migrate-title">
              {isExplicit
                ? (language === 'ko' ? '템플릿 변환' : 'Convert template')
                : (language === 'ko' ? '미확인 템플릿 노트' : 'Unidentified template note')}
            </h3>
          </div>
          <button
            className="tpl-migrate-close"
            onClick={cancel}
            disabled={running}
            aria-label={t('close', language)}
            title={t('close', language)}
          >
            <X size={16} />
          </button>
        </div>

        <p className="tpl-migrate-desc">
          {isExplicit ? (
            language === 'ko'
              ? <>이 노트를 다른 템플릿 형식으로 변환합니다. 현재 type은 <strong>{prompt.noteType || '—'}</strong>입니다.</>
              : <>Convert this note to another template. Current type is <strong>{prompt.noteType || '—'}</strong>.</>
          ) : (
            language === 'ko'
              ? <>이 노트의 frontmatter <code>type:</code> 값은 <strong>{prompt.noteType}</strong>이며 현재 등록된 어떤 템플릿과도 매칭되지 않습니다. 신규 템플릿으로 변환한 뒤 열거나 그대로 열 수 있습니다.</>
              : <>This note's frontmatter <code>type:</code> is <strong>{prompt.noteType}</strong>, which doesn't match any registered template. You can migrate it to a current template, or open it as-is.</>
          )}
        </p>

        <div className="tpl-migrate-prompt-card">
          <div className="tpl-migrate-prompt-card__row">
            <span className="tpl-migrate-prompt-card__from">
              <span className="tpl-migrate-prompt-card__from-type">{prompt.noteType}</span>
              <span className="tpl-migrate-prompt-card__from-name">{fileName}</span>
            </span>
            <ArrowRight size={14} className="tpl-migrate-prompt-card__arrow" />
            <select
              className="tpl-migrate-target-select tpl-migrate-prompt-card__select"
              value={selectedId}
              onChange={e => setSelectedId(e.target.value)}
              disabled={running}
            >
              <option value="">
                {language === 'ko' ? '변환 대상 템플릿 선택...' : 'Pick target template...'}
              </option>
              {noteTemplates.map((tpl: NoteTemplate) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name} ({tpl.frontmatter.type ?? '—'})
                </option>
              ))}
            </select>
          </div>
          <p className="tpl-migrate-prompt-card__hint">
            {language === 'ko'
              ? '변환 시 신규 템플릿의 양식이 본문 상단에 들어가고, 기존 내용·링크·첨부파일은 "변환전 기존 내용" 섹션 아래에 그대로 보존됩니다.'
              : 'When converting, the new template\'s skeleton is inserted at the top; existing content, links, and attachments are preserved under a "Content before conversion" divider.'}
          </p>
        </div>

        <div className="tpl-migrate-footer">
          {!isExplicit && (
            <Button variant="ghost" onClick={openAsIs} disabled={running}>
              {language === 'ko' ? '그대로 열기' : 'Open as-is'}
            </Button>
          )}
          <div style={{ flex: 1 }} />
          <Button variant="secondary" onClick={cancel} disabled={running}>
            {language === 'ko' ? '취소' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            onClick={migrate}
            disabled={running || !selectedId}
            loading={running}
          >
            {running
              ? (language === 'ko' ? '변환 중...' : 'Migrating...')
              : (language === 'ko' ? '변환 후 열기' : 'Migrate & open')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default TemplateMigrationPromptModal;
