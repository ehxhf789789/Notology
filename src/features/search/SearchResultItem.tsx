import React from 'react';
import type { NoteMetadata, SearchResult, AttachmentInfo } from '../../core/types';
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
  style?: React.CSSProperties; // Virtual list positioning
  tagSortCategory?: string | null; // Active tag category for highlighting
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
  style,
  tagSortCategory,
}: FrontmatterResultRowProps) {
  const noteType = noteTypeToCssClass(note.note_type);
  const fileName = note.path.split(/[/\\]/).pop()?.replace(/\.md$/, '') || note.title;
  const displayName = fileName.replace(/_/g, ' ');
  const customColor = getTemplateCustomColor(note.note_type);
  const isContainer = note.note_type?.toUpperCase() === 'CONTAINER';
  const isSelected = selectedPath === note.path;

  // mousedown fires ~50-100ms before click — faster trigger for double-click pre-creation
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey) return;
    if (isContainer) return;
    onNoteClick(note.path, note.note_type);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (onMultiClick && onMultiClick(e, note)) return;
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
      className={`search-row search-grid-row${noteType ? ' ' + noteType : ''}${customColor ? ' has-custom-color' : ''}${isMultiSelected ? ' multi-selected' : ''}`}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => onNoteHover(note.path)}
      onContextMenu={(e) => onContextMenu(e, note)}
      style={rowStyle}
    >
      <div className="search-td search-title">{highlightText(displayName, frontmatterQuery)}</div>
      <div className="search-td search-type">{noteTypeToFullName(note.note_type)}</div>
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
}

export const ContentResultCard = React.memo(function ContentResultCard({
  result,
  contentsQuery,
  getTemplateCustomColor,
  onNoteClick,
  onNoteHover,
}: ContentResultCardProps) {
  const fileName = result.path.split(/[/\\]/).pop()?.replace(/\.md$/, '') || '';
  const noteType = inferNoteType(fileName);
  // Check if this is a folder note (FolderName/FolderName.md pattern)
  const pathParts = result.path.split(/[/\\]/);
  const fileNameWithoutExt = pathParts.pop()?.replace(/\.md$/, '') || '';
  const parentFolderName = pathParts[pathParts.length - 1] || '';
  const isFolderNote = fileNameWithoutExt === parentFolderName;
  // Use fileName instead of title to show full name including _1, _2 suffixes
  // Display underscores as spaces for better readability
  const displayTitle = (fileName || result.title).replace(/_/g, ' ');
  // Get custom color for the note type
  const typeForColor = noteType?.replace('-type', '') || '';
  const customColor = getTemplateCustomColor(typeForColor);

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
      <div className="search-content-title">{highlightText(displayTitle, contentsQuery)}</div>
      <div className="search-content-snippet">{highlightText(result.snippet, contentsQuery)}</div>
      <div className="search-content-path">{result.path.split(/[/\\]/).slice(-2).join('/')}</div>
    </div>
  );
});

// ============================================================================
// Attachment result row
// ============================================================================

interface AttachmentResultRowProps {
  att: AttachmentInfo;
  attachmentsQuery: string;
  isSelected: boolean;
  onAttachmentClick: (e: React.MouseEvent, att: AttachmentInfo) => void;
  onAttachmentContextMenu: (e: React.MouseEvent, att: AttachmentInfo) => void;
  language: LanguageSetting;
}

export const AttachmentResultRow = React.memo(function AttachmentResultRow({
  att,
  attachmentsQuery,
  isSelected,
  onAttachmentClick,
  onAttachmentContextMenu,
  language,
}: AttachmentResultRowProps) {
  const category = getAttachmentCategory(att.file_name);
  return (
    <tr
      key={att.path}
      className={`search-row att-row-${category}${isSelected ? ' selected' : ''}${att.is_conflict ? ' conflict-file' : ''}`}
      onClick={(e) => onAttachmentClick(e, att)}
      onContextMenu={(e) => onAttachmentContextMenu(e, att)}
      title={att.is_conflict ? tf('syncConflictFileTitle', language, { original: att.conflict_original || '' }) : undefined}
    >
      <td className="search-td search-title">
        {att.is_conflict && <span className="conflict-badge">{t('conflictBadge', language)}</span>}
        {highlightText(att.file_name, attachmentsQuery)}
      </td>
      <td className="search-td search-note-path">{highlightText(att.note_relative_path, attachmentsQuery)}</td>
      <td className="search-td search-inferred-path">{highlightText(att.inferred_note_path, attachmentsQuery)}</td>
      <td className="search-td search-container">{highlightText(att.container, attachmentsQuery)}</td>
    </tr>
  );
});

// ============================================================================
// Details result card
// ============================================================================

interface DetailsResultCardProps {
  note: NoteMetadata;
  getTemplateCustomColor: (noteType: string) => string | undefined;
  onNoteClick: (path: string, noteType?: string) => void;
  onNoteHover: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, note: NoteMetadata) => void;
  onTagClick: (tag: string) => void;
  language: LanguageSetting;
  selectedPath?: string | null;
  onSelect?: (path: string) => void;
  isMultiSelected?: boolean;
  onMultiClick?: (e: React.MouseEvent, note: NoteMetadata) => boolean;
  tagSortCategory?: string | null;
}

export const DetailsResultCard = React.memo(function DetailsResultCard({
  note,
  getTemplateCustomColor,
  onNoteClick,
  onNoteHover,
  onContextMenu,
  onTagClick,
  language,
  selectedPath,
  onSelect,
  isMultiSelected,
  onMultiClick,
  tagSortCategory,
}: DetailsResultCardProps) {
  const noteType = noteTypeToCssClass(note.note_type);
  const fileName = note.path.split(/[/\\]/).pop()?.replace(/\.md$/, '') || note.title;
  // Display underscores as spaces for better readability
  const displayName = fileName.replace(/_/g, ' ');
  const containerPath = note.path.split(/[/\\]/).slice(0, -1).pop() || '';
  const customColor = getTemplateCustomColor(note.note_type);
  const isContainer = note.note_type?.toUpperCase() === 'CONTAINER';

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey) return;
    if (isContainer) return;
    onNoteClick(note.path, note.note_type);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (onMultiClick && onMultiClick(e, note)) return;
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

  return (
    <div
      key={note.path}
      className={`search-details-item${noteType ? ' ' + noteType : ''}${customColor ? ' has-custom-color' : ''}${isMultiSelected ? ' multi-selected' : ''}`}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => onNoteHover(note.path)}
      onContextMenu={(e) => onContextMenu(e, note)}
      style={customColor ? { '--template-color': customColor } as React.CSSProperties : undefined}
    >
      <div className="search-details-header">
        <span className="search-details-title">{displayName}</span>
        <span className="search-details-type">{noteTypeToFullName(note.note_type)}</span>
      </div>
      <div className="search-details-meta">
        <span className="search-details-container">{containerPath}</span>
        <span className="search-details-dates">
          {t('createdDate', language)}: {formatDate(note.created)} | {t('modifiedDate', language)}: {formatDate(note.modified)}
        </span>
      </div>
      {note.tags.length > 0 && (
        <div className="search-details-tags">
          {note.tags.map(tag => {
            const categoryClass = getTagCategoryClass(tag);
            // Extract display name without namespace prefix
            let displayTag = tag;
            if (tag.startsWith('domain/')) displayTag = tag.substring(7);
            else if (tag.startsWith('who/')) displayTag = tag.substring(4);
            else if (tag.startsWith('org/')) displayTag = tag.substring(4);
            else if (tag.startsWith('ctx/')) displayTag = tag.substring(4);
            const isDimmed = tagSortCategory ? !tag.startsWith(tagSortCategory + '/') : false;
            return (
              <span
                key={tag}
                className={`search-tag${categoryClass ? ' ' + categoryClass : ''}${isDimmed ? ' tag-dimmed' : ''}`}
                onClick={e => {
                  e.stopPropagation();
                  onTagClick(tag);
                }}
              >
                {displayTag}
              </span>
            );
          })}
        </div>
      )}
      {note.comment_count > 0 && (
        <div className="search-details-comments">
          {tf('commentCountLabel', language, { count: note.comment_count })}
        </div>
      )}
    </div>
  );
});
