/**
 * Stage 5.0.5a-γ5 (2026-05-16) — Live preview pane for NoteTemplateEditor.
 *
 * Two layers of preview the user sees update in real-time as they edit:
 *   1. Template CARD  — exactly how the template will appear in
 *                       TemplateSelector (icon + name + prefix + color).
 *   2. Sample NOTE    — a non-editable TipTap rendering of the body
 *                       markdown with `{{variables}}` substituted to
 *                       readable demo values (예시 제목 / 오늘 날짜 / etc.)
 *                       so the user sees what an actual note will look like.
 *
 * HanBin: "현재 설정의 템플릿 추가 기능은 많이 부족함" → without a live
 * preview the user has to save+create-a-note to find out if the color
 * looks right or the body structure makes sense. The preview removes
 * that round-trip.
 */
import { useEffect, useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import TextAlign from '@tiptap/extension-text-align';
import { Table, TableRow } from '@tiptap/extension-table';
import TableCellWithColor from '../../core/editor/extensions/TableCellWithColor';
import TableHeaderWithColor from '../../core/editor/extensions/TableHeaderWithColor';
import CodeBlockWithHighlight from '../../core/editor/extensions/CodeBlockWithHighlight';
import ItalicCJK from '../../core/editor/extensions/ItalicCJK';
import ParagraphWithIndent from '../../core/editor/extensions/ParagraphWithIndent';
import HeadingWithAlign from '../../core/editor/extensions/HeadingWithAlign';
import { createLowlight } from 'lowlight';
import { t } from '../../core/utils/i18n';
import type { LanguageSetting } from '../../core/utils/i18n';
import { Type as TypeIcon } from 'lucide-react';
import { resolveTemplateIcon } from './templateIconCatalog';
import { TEMPLATE_VAR_CATALOG } from './templateVarCatalog';
import { tf } from '../../core/utils/i18n';

const lowlight = createLowlight();

interface Props {
  name: string;
  prefix: string;
  icon: string;
  /** CSS class for color theme (e.g. 'mtg-type'). */
  cssclasses: string;
  /** Hex color override; takes priority over cssclasses. */
  customColor?: string;
  /**
   * Stage 5.0.5a-γ5 v3 (2026-05-16, HanBin) — resolved theme color (preset
   * → hex, or customColor → hex). Used to tint the card border + icon tile
   * so the preview shows the actual chosen color, not a stale `--c-blue`
   * fallback when only a preset (not a custom hex) is selected.
   */
  themeColor: string;
  /** Body markdown — re-rendered into the readonly preview on every keystroke. */
  bodyMarkdown: string;
  language: LanguageSetting;
}

/**
 * Build sample substitutions for {{var}} tokens so the preview is legible.
 *
 * v18 fix (2026-05-16, HanBin) — previously this hand-listed ~10 tokens and
 * silently left the other 19 catalog entries as literal `{{aliases}}` text
 * in the preview ("별칭 미리보기 오류"). Rewritten to enumerate from
 * TEMPLATE_VAR_CATALOG so adding a new variable to the catalog
 * automatically shows up here — no more drift between catalog and preview.
 *
 * Each token gets a language-aware demo value. Auto-fill variables
 * (date/year/today/etc.) resolve to actual current values; user-input
 * variables resolve to a plausible placeholder ("예시 이름" / "Sample name").
 */
function buildDemoSubs(prefix: string, language: LanguageSetting): Record<string, string> {
  const ko = language === 'ko';
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const hh = String(today.getHours()).padStart(2, '0');
  const min = String(today.getMinutes()).padStart(2, '0');
  const weekdayKo = ['일', '월', '화', '수', '목', '금', '토'][today.getDay()];
  const weekdayEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][today.getDay()];
  const dateStr = `${yyyy}-${mm}-${dd}`;
  const timeStr = `${hh}:${min}`;
  const upperPrefix = (prefix || 'PREFIX').toUpperCase();
  return {
    // basic / auto-fill (real values)
    title:    ko ? '예시 제목' : 'Sample title',
    date:     dateStr,
    year:     String(yyyy),
    prefix:   upperPrefix,
    time:     timeStr,
    datetime: `${dateStr} ${timeStr}`,
    // note meta
    id:       '20260516120000',
    type:     upperPrefix,
    filename: `${upperPrefix}-260516-${ko ? '예시제목' : 'sample'}`,
    path:     ko ? '/예시/경로.md' : '/sample/path.md',
    today:    dateStr,
    // time extended
    month:    mm,
    day:      dd,
    weekday:  ko ? weekdayKo : weekdayEn,
    hour:     hh,
    minute:   min,
    // people / org (placeholders)
    name:         ko ? '예시 이름' : 'Sample name',
    email:        'user@example.com',
    phone:        '010-0000-0000',
    organization: ko ? '예시 기관' : 'Sample Org',
    role:         ko ? '예시 직책' : 'Sample Role',
    location:     ko ? '예시 위치' : 'Sample Location',
    aliases:      ko ? '예시 별칭, 다른 이름' : 'sample-alias, alt-name',
    // document meta (placeholders)
    authors:   ko ? '저자1, 저자2' : 'Author1, Author2',
    venue:     ko ? '예시 학술지' : 'Sample Venue',
    doi:       '10.1000/example.123',
    url:       'https://example.com',
    publisher: ko ? '예시 출판사' : 'Sample Publisher',
    source:    ko ? '예시 출처' : 'Sample Source',
  };
}

function substituteVars(markdown: string, prefix: string, language: LanguageSetting): string {
  const subs = buildDemoSubs(prefix, language);
  let result = markdown;
  // Drive substitution from the catalog so every declared token has demo
  // coverage. Unknown tokens (not in catalog) remain literal — intentional,
  // marks them as "you used a token that won't be substituted at creation".
  for (const spec of TEMPLATE_VAR_CATALOG) {
    const key = spec.token.replace(/^\{\{|\}\}$/g, '');
    const value = subs[key];
    if (value === undefined) continue;
    const re = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    result = result.replace(re, value);
  }
  return result;
}

export function TemplatePreviewPane({
  name,
  prefix,
  icon,
  cssclasses,
  customColor,
  themeColor,
  bodyMarkdown,
  language,
}: Props) {
  const previewContent = useMemo(
    () => substituteVars(bodyMarkdown, prefix, language),
    [bodyMarkdown, prefix, language],
  );

  // Readonly TipTap renderer — same extension subset as the editor for
  // visual parity. `editable: false` disables typing but layout/styling
  // is identical to the WYSIWYG editor above.
  const previewEditor = useEditor({
    extensions: [
      StarterKit.configure({
        link: false,
        italic: false,
        paragraph: false,
        heading: false,
        codeBlock: false,
      }),
      Markdown.configure({ html: true, tightLists: true }),
      ParagraphWithIndent,
      HeadingWithAlign.configure({ levels: [1, 2, 3, 4, 5, 6] }),
      ItalicCJK,
      Highlight,
      Subscript,
      Superscript,
      TaskList,
      TaskItem.configure({ nested: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCellWithColor,
      TableHeaderWithColor,
      CodeBlockWithHighlight.configure({ lowlight }),
    ],
    content: '',
    editable: false,
    editorProps: {
      attributes: {
        class: 'tiptap-editor template-preview-tiptap',
        spellcheck: 'false',
      },
    },
  });

  // Keep the readonly editor's content in sync with the substituted markdown.
  // Debounced via React's batching — setContent is cheap on small docs.
  useEffect(() => {
    if (!previewEditor) return;
    previewEditor.commands.setContent(previewContent, { emitUpdate: false });
  }, [previewEditor, previewContent]);

  // Stage 5.0.5a-γ5 v3 (2026-05-16, HanBin) — use the parent-resolved
  // themeColor for BOTH border and icon tile. Previously the icon tile
  // only got a colored bg for custom hex; presets fell back to --c-blue.
  // Now: card border + icon tile always reflect the active theme color
  // whether preset or custom.
  const cardStyle = {
    '--template-color': themeColor,
    borderLeftColor: themeColor,
  } as React.CSSProperties;
  const iconEntry = resolveTemplateIcon(icon);
  const IconComp = iconEntry.Icon;
  // Soft tint backdrop + accent-colored icon glyph — same treatment as
  // toolbar/bubble-menu active state for consistency.
  const iconTileStyle: React.CSSProperties = {
    backgroundColor: `color-mix(in srgb, ${themeColor} 16%, transparent)`,
    color: themeColor,
  };
  const displayName = name.trim() || t('templatePreviewUnnamed', language);
  const displayPrefix = (prefix || '').toUpperCase();

  return (
    <aside className="template-preview-pane" aria-label={t('templatePreviewPane', language)}>
      <div className="template-preview-pane__header">
        {t('templatePreviewPaneTitle', language)}
      </div>

      {/* Card preview — mirrors TemplateSelector item-v2 markup,
          but renders the selected lucide icon inline so the preview
          updates immediately when the user picks a new icon. */}
      <div className="template-preview-pane__section">
        <div className="template-preview-pane__section-label">
          {t('templatePreviewCard', language)}
        </div>
        <div
          className={`template-selector-item-v2 template-preview-card-sample${cssclasses ? ' ' + cssclasses : ''}${customColor ? ' has-custom-color' : ''}`}
          style={cardStyle}
        >
          <span
            className="template-selector-icon-v2 template-preview-icon-tile"
            style={iconTileStyle}
          >
            <IconComp size={18} strokeWidth={1.8} />
          </span>
          <div className="template-selector-content">
            <div className="template-selector-header-row">
              <span className="template-selector-name-v2">{displayName}</span>
              {displayPrefix && (
                <span className="template-selector-prefix">{displayPrefix}</span>
              )}
            </div>
            <span className="template-selector-desc">
              {t('templatePreviewCardDesc', language)}
            </span>
          </div>
        </div>
      </div>

      {/* Note preview — readonly rendering of body with variables substituted */}
      <div className="template-preview-pane__section">
        <div className="template-preview-pane__section-label">
          {t('templatePreviewNote', language)}
        </div>
        <div className="template-preview-note-frame">
          <EditorContent editor={previewEditor} />
        </div>
      </div>

      {/* 2026-05-22 — fields section absorbed from the now-retired '필드' tab.
          Same `{{var}}` scan logic, but rendered as a calm summary at the
          bottom of the preview pane so the author sees both "how the note
          will look" and "what the wizard will ask for" without tab juggling. */}
      <FieldsSection bodyMarkdown={bodyMarkdown} language={language} />
    </aside>
  );
}

interface FieldsSectionProps {
  bodyMarkdown: string;
  language: LanguageSetting;
}

function FieldsSection({ bodyMarkdown, language }: FieldsSectionProps) {
  // Walk the body once, classify tokens against the catalog. De-duped
  // by token so multiple references collapse to one row each.
  const { usedAuto, usedInput, unknownTokens, usedCount } = useMemo(() => {
    const tokenRegex = /\{\{([\w-]+)\}\}/g;
    const seen = new Set<string>();
    const unknown: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(bodyMarkdown)) !== null) {
      const token = `{{${match[1]}}}`;
      if (seen.has(token)) continue;
      seen.add(token);
      if (!TEMPLATE_VAR_CATALOG.some(v => v.token === token)) unknown.push(token);
    }
    const auto = TEMPLATE_VAR_CATALOG.filter(v => seen.has(v.token) && v.autoFill);
    const input = TEMPLATE_VAR_CATALOG.filter(v => seen.has(v.token) && !v.autoFill);
    return { usedAuto: auto, usedInput: input, unknownTokens: unknown, usedCount: auto.length + input.length + unknown.length };
  }, [bodyMarkdown]);

  return (
    <div className="template-preview-pane__section">
      <div className="template-preview-pane__section-label">
        {t('templateFieldsHeading', language)}
      </div>
      <div className="template-preview-fields">
        <div className="template-preview-fields__count">
          {tf('templateFieldsCount', language, { count: usedCount })}
        </div>
        {usedCount === 0 ? (
          <div className="template-preview-fields__empty">
            {t('templateFieldsEmpty', language)}
          </div>
        ) : (
          <>
            {usedInput.length > 0 && (
              <div className="template-preview-fields__group">
                <div className="template-preview-fields__group-label is-input">
                  {t('templateFieldsInputSection', language)}
                </div>
                {usedInput.map(v => {
                  const IconComp = v.Icon;
                  return (
                    <div key={v.token} className="template-preview-fields__row is-input">
                      <IconComp size={12} strokeWidth={2} aria-hidden="true" />
                      <span className="template-preview-fields__label">{t(v.labelI18n, language)}</span>
                      <code className="template-preview-fields__token">{v.token}</code>
                    </div>
                  );
                })}
              </div>
            )}
            {usedAuto.length > 0 && (
              <div className="template-preview-fields__group">
                <div className="template-preview-fields__group-label is-auto">
                  {t('templateFieldsAutoSection', language)}
                </div>
                {usedAuto.map(v => {
                  const IconComp = v.Icon;
                  return (
                    <div key={v.token} className="template-preview-fields__row is-auto">
                      <IconComp size={12} strokeWidth={2} aria-hidden="true" />
                      <span className="template-preview-fields__label">{t(v.labelI18n, language)}</span>
                      <code className="template-preview-fields__token">{v.token}</code>
                    </div>
                  );
                })}
              </div>
            )}
            {unknownTokens.length > 0 && (
              <div className="template-preview-fields__group">
                <div className="template-preview-fields__group-label is-custom">
                  {t('templateFieldsCustomSection', language)}
                </div>
                {unknownTokens.map(tok => (
                  <div key={tok} className="template-preview-fields__row is-custom">
                    <TypeIcon size={12} strokeWidth={2} aria-hidden="true" />
                    <span className="template-preview-fields__label">
                      {tok.replace(/^\{\{|\}\}$/g, '')}
                    </span>
                    <code className="template-preview-fields__token">{tok}</code>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default TemplatePreviewPane;
