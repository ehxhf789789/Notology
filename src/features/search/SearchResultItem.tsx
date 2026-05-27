import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { NoteMetadata, SearchResult } from '../../core/types';
import type { LanguageSetting } from '../../core/utils/i18n';
import { t, tf } from '../../core/utils/i18n';
import {
  highlightText,
  formatDate,
  noteTypeToFullName,
  noteTypeToCssClass,
  getTagCategoryClass,
  inferNoteType,
} from './searchHelpers';
import { getAttachmentCategory } from '../suggestions/attachmentCategory';
import { useRegisteredTypes, isUnmatchedNoteType, findTemplateByType } from '../templates/templateRegistryUtils';
import { useTemplateStore } from '../templates/stores/templateStore';
// 5.0.7a (2026-05-17, HanBin) — initially tried wrapping ContentResultCard
// in design-system <Card interactive density="compact">, but Card's chrome
// (rounded box + shadow + padding) double-styled the existing row design
// (border-left color strip + bg-gradient). Reverted to raw <div>; full
// <SearchResultCard> primitive extraction is deferred to 5.0.7-followup
// once Card has a "row" variant or the row CSS migrates to tokens-only.

// ============================================================================
// Frontmatter result row
// ============================================================================

interface FrontmatterResultRowProps {
  note: NoteMetadata;
  frontmatterQuery: string;
  getTemplateCustomColor: (noteType: string) => string | undefined;
  onNoteClick: (path: string, noteType?: string) => void;
  onNoteHover: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, note: NoteMetadata) => void;
  selectedPath?: string | null;
  onSelect?: (path: string) => void;
  isMultiSelected?: boolean;
  onMultiClick?: (e: React.MouseEvent, note: NoteMetadata) => boolean;
  /**
   * 11th hotfix (2026-05-19, HanBin) — explicit checkbox toggle for
   * multi-select. Independent of `onMultiClick` (the Ctrl/Shift+click
   * path); used by the leading checkbox cell. Caller maintains the same
   * selection Set behind both entry points.
   */
  onCheckboxToggle?: (e: React.MouseEvent, note: NoteMetadata) => void;
  /**
   * 11th hotfix follow-up #2 (2026-05-19, HanBin) — selection-mode flag.
   * Driven by the toolbar's selection-mode toggle (NOT by whether
   * selection is non-empty). When true:
   *   • the leading 36px checkbox cell renders
   *   • a plain row click toggles selection instead of opening the note
   * When false the row behaves like a normal entry: click opens the
   * note, no checkbox column.
   */
  selectionActive?: boolean;
  style?: React.CSSProperties; // Virtual list positioning
  tagSortCategory?: string | null; // Active tag category for highlighting
  selectRowLabel?: string;
}

export const FrontmatterResultRow = React.memo(function FrontmatterResultRow({
  note,
  frontmatterQuery,
  getTemplateCustomColor,
  onNoteClick,
  onNoteHover,
  onContextMenu,
  selectedPath,
  onSelect,
  isMultiSelected,
  onMultiClick,
  onCheckboxToggle,
  selectionActive,
  style,
  tagSortCategory,
  selectRowLabel,
}: FrontmatterResultRowProps) {
  const noteType = noteTypeToCssClass(note.note_type);
  const fileName = note.path.split(/[/\\]/).pop()?.replace(/\.md$/, '') || note.title;
  const displayName = fileName.replace(/_/g, ' ');
  const customColor = getTemplateCustomColor(note.note_type);
  const isContainer = note.note_type?.toUpperCase() === 'CONTAINER';
  const isSelected = selectedPath === note.path;
  // 5.0.5a-migration A — flag rows whose frontmatter type doesn't match
  // any current template. The row picks up `.search-row--unmatched`
  // styling and the type cell shows an AlertTriangle prefix.
  const registeredTypes = useRegisteredTypes();
  const noteTemplates = useTemplateStore(s => s.noteTemplates);
  const matchedTemplate = findTemplateByType(note.note_type, noteTemplates);
  const isUnmatched = !isContainer && isUnmatchedNoteType(note.note_type, registeredTypes);
  // 5.0.5a-migration A2 — show the TEMPLATE NAME (e.g., "문서", "테스트3")
  // instead of the raw frontmatter.type token ("Note", "TEST3"). For
  // unmatched rows show the raw type so the user sees what's actually
  // on disk, prefixed by the warning icon.
  const typeLabel = matchedTemplate
    ? matchedTemplate.name
    : (note.note_type || '—');

  // mousedown fires ~50-100ms before click — faster trigger for double-click pre-creation
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey) return;
    if (isContainer) return;
    // 11th hotfix follow-up (2026-05-19) — in selection-mode (one or more
    // rows already checked), defer to click so it can toggle selection
    // instead of opening the note here. Without this, mousedown would
    // fire `onNoteClick` and open the note before the user finishes
    // building their selection.
    if (selectionActive) return;
    onNoteClick(note.path, note.note_type);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (onMultiClick && onMultiClick(e, note)) return;
    // Selection-mode: plain click on a row becomes a selection toggle so
    // the user can build the set without holding modifier keys.
    if (selectionActive && !isContainer && onCheckboxToggle) {
      onCheckboxToggle(e, note);
      return;
    }
    if (isContainer && onSelect) {
      onSelect(note.path);
    }
  };

  // Container: double-click navigates into the folder
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!isContainer) return;
    e.preventDefault();
    onNoteClick(note.path, note.note_type);
  };

  const rowStyle = customColor
    ? { ...style, '--template-color': customColor } as React.CSSProperties
    : style;

  return (
    <div
      className={`search-row search-grid-row${noteType ? ' ' + noteType : ''}${customColor ? ' has-custom-color' : ''}${isMultiSelected ? ' multi-selected' : ''}${isUnmatched ? ' search-row--unmatched' : ''}`}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => onNoteHover(note.path)}
      onContextMenu={(e) => onContextMenu(e, note)}
      style={rowStyle}
    >
      {/* 11th hotfix follow-up #4 (2026-05-19) — back to native input but
          styled via `appearance: none` + custom CSS to match the design
          system's checkbox visual (border, radius, accent fill).
          Why not the DS <Checkbox> primitive: it wraps in <label>, so a
          click on the visible box auto-triggers a second click event on
          the inner <input> via the label/input link. That second click
          also bubbles to the cell, so our toggle fires twice and the
          visual state never moves. Native input + pointer-events:none
          on the input means clicks always hit the cell exactly once. */}
      {selectionActive && (
        <div
          className="search-td search-td-checkbox"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onCheckboxToggle?.(e, note);
          }}
        >
          <input
            type="checkbox"
            className="search-row-checkbox"
            checked={!!isMultiSelected}
            aria-label={selectRowLabel ?? 'Select row'}
            readOnly
            tabIndex={-1}
            onChange={() => { /* state managed by parent — cell click drives it */ }}
          />
        </div>
      )}
      <div className="search-td search-title">{highlightText(displayName, frontmatterQuery)}</div>
      <div className="search-td search-type">
        {isUnmatched && (
          <AlertTriangle size={11} className="search-type__unmatched-icon" aria-hidden="true" />
        )}
        {typeLabel}
      </div>
      <div className="search-td search-tags">
        {note.tags.length > 0 ? (
          note.tags.map(tag => {
            const categoryClass = getTagCategoryClass(tag);
            let tagName = tag;
            if (tag.startsWith('domain/')) tagName = tag.substring(7);
            else if (tag.startsWith('who/')) tagName = tag.substring(4);
            else if (tag.startsWith('org/')) tagName = tag.substring(4);
            else if (tag.startsWith('ctx/')) tagName = tag.substring(4);
            // Dim tags not in the active sort category
            const isDimmed = tagSortCategory ? !tag.startsWith(tagSortCategory + '/') : false;
            return (
              <span
                key={tag}
                className={`search-tag${categoryClass ? ' ' + categoryClass : ''}${isDimmed ? ' tag-dimmed' : ''}`}
              >
                {tagName}
              </span>
            );
          })
        ) : (
          <span className="search-tag-empty">-</span>
        )}
      </div>
      <div className="search-td search-memo">
        {note.comment_count > 0 ? note.comment_count : '-'}
      </div>
      <div className="search-td search-date">{formatDate(note.created)}</div>
      <div className="search-td search-date">{formatDate(note.modified)}</div>
    </div>
  );
});

// ============================================================================
// Content search result card
// ============================================================================

interface ContentResultCardProps {
  result: SearchResult;
  contentsQuery: string;
  getTemplateCustomColor: (noteType: string) => string | undefined;
  onNoteClick: (path: string, noteType?: string) => void;
  onNoteHover: (path: string) => void;
  /** Optional vault root path for displaying vault-relative paths. */
  vaultPath?: string | null;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'gi');
  return (haystack.match(re) || []).length;
}

export const ContentResultCard = React.memo(function ContentResultCard({
  result,
  contentsQuery,
  getTemplateCustomColor,
  onNoteClick,
  onNoteHover,
  vaultPath,
}: ContentResultCardProps) {
  const fileName = result.path.split(/[/\\]/).pop()?.replace(/\.md$/, '') || '';
  const noteType = inferNoteType(fileName);
  const pathParts = result.path.split(/[/\\]/);
  const fileNameWithoutExt = pathParts.pop()?.replace(/\.md$/, '') || '';
  const parentFolderName = pathParts[pathParts.length - 1] || '';
  const isFolderNote = fileNameWithoutExt === parentFolderName;
  const displayTitle = (fileName || result.title).replace(/_/g, ' ');
  const typeForColor = noteType?.replace('-type', '') || '';
  const customColor = getTemplateCustomColor(typeForColor);

  // 2026-05-22 — vault-relative path (drop the absolute `C:/Users/...`
  // prefix). Fallback to last-two segments when vaultPath is missing.
  const relPath = (() => {
    const norm = result.path.replace(/\\/g, '/');
    if (vaultPath) {
      const root = vaultPath.replace(/\\/g, '/').replace(/\/$/, '') + '/';
      if (norm.toLowerCase().startsWith(root.toLowerCase())) return norm.slice(root.length);
    }
    return norm.split('/').slice(-2).join('/');
  })();

  // 2026-05-22 — prefer multi-snippet list from the Rust side; fall back
  // to the single legacy snippet for older index data.
  const allSnippets = (result.snippets && result.snippets.length > 0)
    ? result.snippets
    : [result.snippet];
  const matchCount = contentsQuery.trim()
    ? allSnippets.reduce((sum, s) => sum + countOccurrences(s, contentsQuery), 0)
      + countOccurrences(displayTitle, contentsQuery)
    : 0;

  return (
    <div
      key={result.path}
      className={`search-content-item${noteType ? ' ' + noteType : ''}${isFolderNote ? ' container-type' : ''}${customColor ? ' has-custom-color' : ''}`}
      onMouseDown={(e: React.MouseEvent) => {
        if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey) return;
        onNoteClick(result.path, isFolderNote ? 'CONTAINER' : undefined);
      }}
      onMouseEnter={() => onNoteHover(result.path)}
      style={customColor ? { '--template-color': customColor } as React.CSSProperties : undefined}
    >
      <div className="search-content-header">
        <span className="search-content-title">{highlightText(displayTitle, contentsQuery)}</span>
        {matchCount > 0 && (
          <span className="search-content-match-count">{matchCount}</span>
        )}
      </div>
      {allSnippets.map((s, i) => (
        <div key={i} className="search-content-snippet">{highlightText(s, contentsQuery)}</div>
      ))}
      <div className="search-content-path">{relPath}</div>
    </div>
  );
});

// `AttachmentResultRow` retired 2026-05-20 along with the legacy
// `searchCommands.searchAttachments` flow. `AttachmentsTab` v2 owns row
// rendering now (with the AttachmentRef store).

// ============================================================================
// Details result card
// ============================================================================

// 5.0.7a (2026-05-17, HanBin) — `DetailsResultCard` removed alongside the
// Details tab. Frontmatter row click will surface this metadata via an
// inline expand panel in a follow-up sub-stage.
