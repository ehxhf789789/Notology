import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { copyText } from '../../web/files';
import { useModalStore, modalActions } from '../modals/stores/modalStore';
import { useTemplateStore, templateActions } from './stores/templateStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { useVaultPath } from '../../core/stores/fileTreeStore';
import { useModalClose } from '../../core/hooks/useModalListeners';
import { t, tf } from '../../core/utils/i18n';
import type { LanguageSetting } from '../../core/utils/i18n';
import type { NoteTemplate } from '../../core/types';
import { resolveTemplateIcon } from './templateIconCatalog';
import { Upload, Search as SearchIcon, Plus, X as XIcon } from 'lucide-react';

// v14 (2026-05-16, HanBin) — resolve cssclasses preset to a CSS var that
// holds the theme color (defined in note-type-colors.css). When the user
// picks "테마 색상" preset (e.g. mtg-type), the tile is tinted with the
// corresponding `--mtg-color`. Custom hex takes priority.
function resolveTileColor(template: NoteTemplate): string {
  if (template.customColor) return template.customColor;
  const css = (template.frontmatter?.cssclasses as string[] | undefined)?.[0];
  if (!css || !css.endsWith('-type')) return 'var(--tx-2)';
  const key = css.replace(/-type$/, '');
  return `var(--${key}-color)`;
}

// Template description key map for each type
const TEMPLATE_DESC_KEYS: Record<string, string> = {
  'NOTE': 'templateDescNote',
  'SKETCH': 'templateDescSketch',
  'MTG': 'templateDescMtg',
  'SEM': 'templateDescSem',
  'EVENT': 'templateDescEvent',
  'OFA': 'templateDescOfa',
  'PAPER': 'templateDescPaper',
  'LIT': 'templateDescLit',
  'DATA': 'templateDescData',
  'THEO': 'templateDescTheo',
  'CONTACT': 'templateDescContact',
  'SETUP': 'templateDescSetup',
};

function getTemplateDescription(type: string, lang: LanguageSetting): string {
  const key = TEMPLATE_DESC_KEYS[type];
  return key ? t(key, lang) : t('templateDescCustom', lang);
}

function TemplateSelector() {
  const templateSelectorState = useModalStore(s => s.templateSelectorState);
  const hideTemplateSelector = useModalStore(s => s.hideTemplateSelector);
  const showNoteTemplateEditorModal = useModalStore(s => s.showNoteTemplateEditorModal);
  const noteTemplates = useTemplateStore(s => s.noteTemplates);
  const language = useSettingsStore(s => s.language);
  const enabledTemplateIds = useTemplateStore(s => s.enabledTemplateIds);
  const vaultPath = useVaultPath();
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [searchTerm, setSearchTerm] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Stage 5.0.5a (2026-05-16) — display mode discriminator.
  const isCentered = templateSelectorState?.mode === 'centered';

  // Use optimized hook for click-outside and escape handling
  useModalClose(menuRef, hideTemplateSelector, !!templateSelectorState?.visible);

  // v16 fix (2026-05-16, HanBin) — runtime auto-sync. If any custom template
  // exists in noteTemplates but is missing from enabledTemplateIds (legacy
  // data from before the v12 auto-enable fix), enable it on the fly. This
  // makes pre-existing user templates visible without requiring a vault
  // reload. Defensive — runs once when the selector opens.
  useEffect(() => {
    if (!templateSelectorState?.visible) return;
    const missing = noteTemplates.filter(
      t => !t.id.startsWith('tpl-') && !enabledTemplateIds.includes(t.id),
    );
    if (missing.length > 0) {
      const newIds = [...enabledTemplateIds, ...missing.map(t => t.id)];
      templateActions.setEnabledTemplates(newIds, vaultPath);
    }
  }, [templateSelectorState?.visible, noteTemplates, enabledTemplateIds, vaultPath]);

  // Reset search term and focus input when state changes
  useEffect(() => {
    if (!templateSelectorState) {
      setSearchTerm('');
      return;
    }
    // Focus search input when opened
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, [templateSelectorState]);

  useLayoutEffect(() => {
    // In centered mode the dialog positions itself via CSS — no layout pass.
    if (!templateSelectorState?.visible || !menuRef.current || isCentered) return;
    const rect = menuRef.current.getBoundingClientRect();
    const { position } = templateSelectorState;
    let x = position.x, y = position.y;
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    setAdjustedPos({ x, y });
  }, [templateSelectorState, isCentered]);

  if (!templateSelectorState || !templateSelectorState.visible) return null;

  const { callback } = templateSelectorState;

  const handleSelect = (templateId: string) => {
    callback(templateId);
    hideTemplateSelector();
  };

  // v16c fix (2026-05-16, HanBin) — show ALL templates that exist in
  // noteTemplates, regardless of enabledTemplateIds. The enabled-template
  // filter caused user-created templates to disappear when their ID wasn't
  // in the saved enabledTemplateIds (legacy data from before the v12 auto-
  // enable fix). The "enable/disable in picker" feature is rarely used and
  // can come back later as an opt-in setting; for now visibility > filter.
  //
  // Default (built-in) templates still respect enabledTemplateIds so users
  // who explicitly disabled defaults stay consistent.
  const isBuiltInId = (id: string) =>
    id.startsWith('tpl-') ||
    (id.startsWith('note-') && !id.startsWith('note-custom-'));
  const filteredTemplates = noteTemplates.filter(t => {
    // Apply enable filter to built-ins only — custom templates always show.
    if (isBuiltInId(t.id) && !enabledTemplateIds.includes(t.id)) return false;
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return (
      t.name.toLowerCase().includes(search) ||
      t.prefix.toLowerCase().includes(search) ||
      (t.frontmatter.type?.toLowerCase() || '').includes(search)
    );
  });

  // Separate default and custom templates.
  // Stage 5.0.5a (2026-05-16): new template IDs use `tpl-` prefix (Entity /
  // Document / Sketch). Legacy `note-*` IDs preserved for backward compat.
  // User-created custom templates use `note-custom-*` IDs.
  const isBuiltIn = (id: string) =>
    id.startsWith('tpl-') ||
    (id.startsWith('note-') && !id.startsWith('note-custom-'));
  const defaultTemplates = filteredTemplates.filter(t => isBuiltIn(t.id));
  const customTemplates = filteredTemplates.filter(t => !isBuiltIn(t.id));

  // Stage 5.0.5a — handler for "+ 새 템플릿" card. Opens the editor with no
  // initial template (create mode); on save, addNoteTemplate persists to
  // vault-config.yaml (auto-NAS-synced because vault-config lives under
  // the vault root).
  const handleCreateTemplate = () => {
    hideTemplateSelector();
    showNoteTemplateEditorModal(undefined, (newTemplate: NoteTemplate) => {
      templateActions.addNoteTemplate(newTemplate, vaultPath);
    });
  };

  // Stage 5.0.5 T-2 (2026-05-17, HanBin) — right-click menu on template cards.
  // Plan §T-2 "γ1 Card right-click menu on TemplateSelector". Edit / Duplicate /
  // Copy JSON / Toggle visibility / Delete. Built-in templates can be
  // duplicated + copied + toggled but not edited or deleted (they ship with
  // the app and are restored from defaults if the user nukes them anyway).
  //
  // T-4 (.notology-template file import/export) is delivered here as a
  // CLIPBOARD-BASED workflow rather than a `.notology-template` file. The
  // backend `write_file` auto-prepends a frontmatter wrapper + injects an
  // `id` field into raw JSON, which corrupts the template payload — and
  // CLAUDE.md forbids backend modifications during Stage 5.0. Clipboard
  // sidesteps both issues: users can paste the JSON into any editor, save
  // it as a `.notology-template` file out-of-band, and share via any
  // mechanism (chat, gist, file copy). A future BE-2 sub-stage can add a
  // dedicated `write_raw_file` Tauri command for first-class file flow.
  const duplicateTemplate = (template: NoteTemplate) => {
    const baseName = template.name.replace(/\s*\(\d+\)$/, '');
    let candidate = `${baseName} (사본)`;
    let n = 2;
    const taken = new Set(noteTemplates.map(t => t.name));
    while (taken.has(candidate)) {
      candidate = `${baseName} (사본 ${n++})`;
    }
    const copy: NoteTemplate = {
      ...template,
      id: `note-custom-${Date.now()}`,
      name: candidate,
      frontmatter: { ...template.frontmatter },
      tagCategories: template.tagCategories
        ? { ...template.tagCategories }
        : undefined,
    };
    templateActions.addNoteTemplate(copy, vaultPath);
  };

  const handleCopyJson = async (template: NoteTemplate) => {
    try {
      // Strip the id so the JSON is a "blueprint" — when re-imported it
      // gets a fresh id, avoiding collisions with the source template.
      const blueprint = { ...template, id: undefined };
      await copyText(JSON.stringify(blueprint, null, 2));
      modalActions.showAlertModal(
        t('templateMenuCopyJson', language),
        t('templateCopiedToClipboard', language),
      );
    } catch (err) {
      console.error('[TemplateSelector] copyJson failed:', err);
      modalActions.showAlertModal(
        t('templateMenuCopyJson', language),
        t('templateClipboardError', language),
      );
    }
  };

  const handleImportFromClipboard = async () => {
    try {
      const raw = await navigator.clipboard.readText();
      if (!raw || !raw.trim()) {
        modalActions.showAlertModal(
          t('templateMenuImportFromClipboard', language),
          t('templateImportEmpty', language),
        );
        return;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch {
        modalActions.showAlertModal(
          t('templateMenuImportFromClipboard', language),
          t('templateImportInvalid', language),
        );
        return;
      }
      const p = parsed as Partial<NoteTemplate> | null;
      if (!p || typeof p !== 'object' || typeof p.name !== 'string' || typeof p.prefix !== 'string') {
        modalActions.showAlertModal(
          t('templateMenuImportFromClipboard', language),
          t('templateImportInvalid', language),
        );
        return;
      }
      // Ensure new id + non-conflicting name. The blueprint exporter strips
      // id, but defensively regenerate even if it was kept.
      const taken = new Set(noteTemplates.map(t => t.name));
      let finalName = p.name.trim();
      let n = 2;
      while (taken.has(finalName)) finalName = `${p.name.trim()} (${n++})`;
      const newTemplate: NoteTemplate = {
        id: `note-custom-${Date.now()}`,
        name: finalName,
        prefix: (p.prefix || '').toUpperCase(),
        namePattern: p.namePattern || '',
        frontmatter: p.frontmatter || { type: 'NOTE', cssclasses: [], tags: [] },
        body: typeof p.body === 'string' ? p.body : '',
        customColor: p.customColor,
        icon: p.icon,
        tagCategories: p.tagCategories,
      };
      templateActions.addNoteTemplate(newTemplate, vaultPath);
      modalActions.showAlertModal(
        t('templateMenuImportFromClipboard', language),
        tf('templateImportSuccess', language, { name: finalName }),
      );
    } catch (err) {
      console.error('[TemplateSelector] importFromClipboard failed:', err);
      modalActions.showAlertModal(
        t('templateMenuImportFromClipboard', language),
        t('templateClipboardError', language),
      );
    }
  };

  const handleCardContextMenu = (e: React.MouseEvent, template: NoteTemplate) => {
    e.preventDefault();
    e.stopPropagation();
    const isCustom = !isBuiltInId(template.id);
    const isEnabled = enabledTemplateIds.includes(template.id);
    const actions: Array<{ label: string; onClick: () => void; danger?: boolean }> = [];
    if (isCustom) {
      actions.push({
        label: t('templateMenuEdit', language),
        onClick: () => {
          hideTemplateSelector();
          showNoteTemplateEditorModal(template, (updated: NoteTemplate) => {
            templateActions.updateNoteTemplate(updated, vaultPath);
          });
        },
      });
    }
    actions.push({
      label: t('templateMenuDuplicate', language),
      onClick: () => duplicateTemplate(template),
    });
    actions.push({
      label: t('templateMenuCopyJson', language),
      onClick: () => { void handleCopyJson(template); },
    });
    // Built-ins get an enable/disable toggle since users can't delete them.
    if (!isCustom) {
      actions.push({
        label: isEnabled
          ? t('templateMenuToggleDisabled', language)
          : t('templateMenuToggleEnabled', language),
        onClick: () => templateActions.toggleTemplateEnabled(template.id, vaultPath),
      });
    }
    if (isCustom) {
      actions.push({
        label: t('templateMenuDelete', language),
        danger: true,
        onClick: () => {
          modalActions.showConfirmDelete(
            template.name,
            'file',
            () => templateActions.removeNoteTemplate(template.id, vaultPath),
            undefined,
            { warningOverride: tf('templateDeleteConfirmBody', language, { name: template.name }) },
          );
        },
      });
    }
    modalActions.showAtomContextMenu({ x: e.clientX, y: e.clientY }, actions);
  };

  const getDescription = (template: typeof noteTemplates[0]): string => {
    const type = template.frontmatter.type?.toUpperCase() || '';
    return getTemplateDescription(type, language);
  };

  const renderTemplateItem = (t: typeof noteTemplates[0]) => {
    const typeClass = t.frontmatter.cssclasses?.[0] || '';
    const customColor = t.customColor;
    const description = getDescription(t);

    // v14 (2026-05-16, HanBin) — resolve icon + color via shared helpers so
    // user-created templates display their chosen lucide icon + theme color
    // (previously only the 3 built-ins had CSS rules for `icon-${type}`;
    // custom prefixes like "TEST" matched nothing → blank icon).
    const iconEntry = resolveTemplateIcon(t.icon);
    const IconComp = iconEntry.Icon;
    const tileColor = resolveTileColor(t);

    const itemStyle = customColor ? {
      '--template-color': customColor,
      borderLeftColor: customColor,
    } as React.CSSProperties : undefined;

    return (
      <button
        key={t.id}
        className={`template-selector-item-v2${typeClass ? ' ' + typeClass : ''}${customColor ? ' has-custom-color' : ''}`}
        onClick={() => handleSelect(t.id)}
        onContextMenu={(e) => handleCardContextMenu(e, t)}
        style={itemStyle}
      >
        <span
          className="template-selector-icon-v2 template-selector-icon-tile"
          style={{
            backgroundColor: `color-mix(in srgb, ${tileColor} 16%, transparent)`,
            color: tileColor,
          }}
        >
          <IconComp size={16} strokeWidth={2} />
        </span>
        <div className="template-selector-content">
          <div className="template-selector-header-row">
            <span className="template-selector-name-v2">{t.name}</span>
            <span className="template-selector-prefix">{t.prefix}</span>
          </div>
          <span className="template-selector-desc">{description}</span>
        </div>
      </button>
    );
  };

  // Stage 5.0.5a (2026-05-16) — centered vs anchored render path.
  // Centered mode wraps in a backdrop overlay and ignores the position
  // coordinates; anchored mode keeps the original popover behavior.
  const inner = (
    <div
      ref={menuRef}
      className={`template-selector-v2${isCentered ? ' is-centered' : ''}`}
      style={isCentered ? undefined : { left: adjustedPos.x, top: adjustedPos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="template-selector-header-v2">
        <span>{t('templateSelectorTitle', language)}</span>
        <span className="template-selector-header-spacer" />
        {/* Stage 5.0.5 T-4 (2026-05-17, HanBin) — clipboard import.
            Pairs with the per-card "JSON 복사" right-click action so
            users can share templates as JSON via any text channel.
            Lives in the header so it's discoverable without needing to
            right-click on something. */}
        <button
          type="button"
          className="template-selector-header-icon-btn"
          onClick={() => { void handleImportFromClipboard(); }}
          title={t('templateMenuImportFromClipboard', language)}
          aria-label={t('templateMenuImportFromClipboard', language)}
        >
          <Upload size={14} strokeWidth={2} />
        </button>
        <span className="template-selector-hint">Ctrl+N</span>
        {/* 2026-05-22 — close button. iOS sheet pattern (X on right
            corner). Backdrop click still works; this just gives a
            visible affordance for users who don't know to click out. */}
        {isCentered && (
          <button
            type="button"
            className="template-selector-close-btn"
            onClick={hideTemplateSelector}
            title={t('close', language)}
            aria-label={t('close', language)}
          >
            <XIcon size={14} strokeWidth={2} />
          </button>
        )}
      </div>

      <div className="template-selector-search">
        {/* 2026-05-22 — search bar restyle: pill shape + Search icon
            prefix + "+ 새 템플릿" trailing button. Same iOS toolbar
            pattern as the global Search tab. The bottom dashed
            create-card was removed; create is always one click away
            from the same line as search. */}
        <div className="template-selector-search-field">
          <SearchIcon size={14} strokeWidth={2} className="template-selector-search-icon" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder={t('templateSearchPlaceholder', language)}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="template-selector-search-input"
          />
        </div>
        <button
          type="button"
          className="template-selector-create-btn"
          onClick={handleCreateTemplate}
          title={t('templateCreateNewHint', language)}
          aria-label={t('templateCreateNew', language)}
        >
          <Plus size={14} strokeWidth={2.5} aria-hidden="true" />
          <span>{t('templateCreateNew', language)}</span>
        </button>
      </div>

      <div className="template-selector-list">
        {/* 2026-05-22 — 2-column layout for centered (Ctrl+N) mode:
            basic templates on the left, custom on the right. Side-by-side
            keeps both visible without scroll. Anchored mode (right-click
            menu) stays single-column because the surface is narrower. */}
        {filteredTemplates.length === 0 ? (
          <div className="template-selector-empty">
            {t('noSearchResultsTemplate', language)}
          </div>
        ) : (
          <div className="template-selector-grid">
            {defaultTemplates.length > 0 && (
              <div className="template-selector-column">
                <div className="template-selector-section-label">{t('defaultTemplates', language)}</div>
                {defaultTemplates.map(renderTemplateItem)}
              </div>
            )}
            {customTemplates.length > 0 && (
              <div className="template-selector-column is-custom">
                <div className="template-selector-section-label">{t('customTemplates', language)}</div>
                {customTemplates.map(renderTemplateItem)}
              </div>
            )}
          </div>
        )}

        {/* 2026-05-22 — bottom create card retired; the "+" trigger
            now lives in the search toolbar above. */}
      </div>
    </div>
  );

  // Centered mode — wrap the picker in a full-screen backdrop overlay so it
  // reads as a proper dialog rather than a stranded popover.
  if (isCentered) {
    return (
      <div
        className="template-selector-backdrop"
        onClick={hideTemplateSelector}
      >
        {inner}
      </div>
    );
  }
  return inner;
}

export default TemplateSelector;
