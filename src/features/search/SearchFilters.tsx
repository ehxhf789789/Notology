import { X } from 'lucide-react';
import type { SearchMode, AttachmentInfo } from '../../core/types';
import type { LanguageSetting } from '../../core/utils/i18n';
import { t } from '../../core/utils/i18n';
import { NOTE_TYPES, noteTypeToFullName } from './searchHelpers';

export interface SearchFiltersProps {
  mode: SearchMode;
  // Frontmatter filters
  frontmatterTypeFilter: string;
  setFrontmatterTypeFilter: (v: string) => void;
  frontmatterTagFilter: string;
  setFrontmatterTagFilter: (v: string) => void;
  frontmatterMemoFilter: 'all' | 'has' | 'none';
  setFrontmatterMemoFilter: (v: 'all' | 'has' | 'none') => void;
  showFolderNotes: boolean;
  setShowFolderNotes: (v: boolean) => void;
  showDateFilters: boolean;
  setShowDateFilters: (v: boolean) => void;
  createdAfter: string;
  setCreatedAfter: (v: string) => void;
  createdBefore: string;
  setCreatedBefore: (v: string) => void;
  modifiedAfter: string;
  setModifiedAfter: (v: string) => void;
  modifiedBefore: string;
  setModifiedBefore: (v: string) => void;
  // Contents filters
  showContentsFilters: boolean;
  contentsTypeFilter: string;
  setContentsTypeFilter: (v: string) => void;
  // Attachments filters
  showAttachmentsFilters: boolean;
  attachmentsContainerFilter: string;
  setAttachmentsContainerFilter: (v: string) => void;
  attachmentsExtensionFilter: string;
  setAttachmentsExtensionFilter: (v: string) => void;
  attachmentsShowDummyOnly: boolean;
  setAttachmentsShowDummyOnly: (v: boolean) => void;
  attachmentsNotePathFilter: string;
  setAttachmentsNotePathFilter: (v: string) => void;
  // Data for dropdowns
  uniqueTags: string[];
  filteredAttachments: AttachmentInfo[];
  selectedAttachments: Set<string>;
  // Batch operations
  onBatchDeleteDummy: () => void;
  onBatchDeleteSelected: () => void;
  // Details filters
  detailsTypeFilter: string;
  setDetailsTypeFilter: (v: string) => void;
  detailsTagFilter: string;
  setDetailsTagFilter: (v: string) => void;
  // Utility
  language: LanguageSetting;
  // Search functions
  fetchNotes: () => void;
}

export function SearchFilters(props: SearchFiltersProps) {
  const {
    mode,
    frontmatterTypeFilter, setFrontmatterTypeFilter,
    frontmatterTagFilter, setFrontmatterTagFilter,
    frontmatterMemoFilter, setFrontmatterMemoFilter,
    showFolderNotes, setShowFolderNotes,
    showDateFilters,
    createdAfter, setCreatedAfter,
    createdBefore, setCreatedBefore,
    modifiedAfter, setModifiedAfter,
    modifiedBefore, setModifiedBefore,
    showContentsFilters,
    contentsTypeFilter, setContentsTypeFilter,
    showAttachmentsFilters,
    attachmentsContainerFilter, setAttachmentsContainerFilter,
    attachmentsExtensionFilter, setAttachmentsExtensionFilter,
    attachmentsShowDummyOnly, setAttachmentsShowDummyOnly,
    attachmentsNotePathFilter, setAttachmentsNotePathFilter,
    uniqueTags,
    filteredAttachments,
    onBatchDeleteDummy,
    language,
  } = props;

  return (
    <>
      {/* Date filters panel */}
      {mode === 'frontmatter' && showDateFilters && (
        <div className="search-date-filters">
          {/* Type filter */}
          <div className="search-date-filter-row">
            <label className="search-date-filter-label">{t('noteType', language)}</label>
            <select
              className="search-details-select"
              value={frontmatterTypeFilter}
              onChange={e => setFrontmatterTypeFilter(e.target.value)}
            >
              {NOTE_TYPES.map(nt => (
                <option key={nt.value} value={nt.value}>{nt.value === '' ? t('allTypes', language) : nt.label}</option>
              ))}
            </select>
            {frontmatterTypeFilter && (
              <button
                className="search-date-clear-btn"
                onClick={() => setFrontmatterTypeFilter('')}
                title={t('resetTypeFilter', language)}
              >
                <X size={12} />
              </button>
            )}
          </div>
          {/* Tag filter */}
          <div className="search-date-filter-row">
            <label className="search-date-filter-label">{t('tag', language)}</label>
            <select
              className="search-details-select"
              value={frontmatterTagFilter}
              onChange={e => setFrontmatterTagFilter(e.target.value)}
            >
              <option value="">{t('allTags', language)}</option>
              {uniqueTags.map(tag => {
                // Extract display name without namespace prefix
                let displayTag = tag;
                if (tag.startsWith('domain/')) displayTag = tag.substring(7);
                else if (tag.startsWith('who/')) displayTag = tag.substring(4);
                else if (tag.startsWith('org/')) displayTag = tag.substring(4);
                else if (tag.startsWith('ctx/')) displayTag = tag.substring(4);
                return <option key={tag} value={tag}>{displayTag}</option>;
              })}
            </select>
            {frontmatterTagFilter && (
              <button
                className="search-date-clear-btn"
                onClick={() => setFrontmatterTagFilter('')}
                title={t('resetTagFilter', language)}
              >
                <X size={12} />
              </button>
            )}
          </div>
          {/* Memo filter */}
          <div className="search-date-filter-row">
            <label className="search-date-filter-label">{t('memos', language)}</label>
            <select
              className="search-details-select"
              value={frontmatterMemoFilter}
              onChange={e => setFrontmatterMemoFilter(e.target.value as 'all' | 'has' | 'none')}
            >
              <option value="all">{t('all', language)}</option>
              <option value="has">{t('hasMemos', language)}</option>
              <option value="none">{t('noMemos', language)}</option>
            </select>
            {frontmatterMemoFilter !== 'all' && (
              <button
                className="search-date-clear-btn"
                onClick={() => setFrontmatterMemoFilter('all')}
                title={t('resetMemoFilter', language)}
              >
                <X size={12} />
              </button>
            )}
          </div>
          {/* Folder notes visibility toggle */}
          <div className="search-date-filter-row">
            <label className="search-date-filter-label">{t('folderNotesLabel', language)}</label>
            <button
              className={`search-filter-toggle-btn ${showFolderNotes ? 'active' : ''}`}
              onClick={() => setShowFolderNotes(!showFolderNotes)}
            >
              {showFolderNotes ? t('showLabel', language) : t('hideLabel', language)}
            </button>
          </div>
          {/* Date: created */}
          <div className="search-date-filter-row">
            <label className="search-date-filter-label">{t('createdDate', language)}</label>
            <input
              type="date"
              className="search-date-input"
              value={createdAfter}
              onChange={e => setCreatedAfter(e.target.value)}
              placeholder={t('startDate', language)}
            />
            <span className="search-date-separator">~</span>
            <input
              type="date"
              className="search-date-input"
              value={createdBefore}
              onChange={e => setCreatedBefore(e.target.value)}
              placeholder={t('endDate', language)}
            />
            {(createdAfter || createdBefore) && (
              <button
                className="search-date-clear-btn"
                onClick={() => { setCreatedAfter(''); setCreatedBefore(''); }}
                title={t('resetCreatedFilter', language)}
              >
                <X size={12} />
              </button>
            )}
          </div>
          {/* Date: modified */}
          <div className="search-date-filter-row">
            <label className="search-date-filter-label">{t('modifiedDate', language)}</label>
            <input
              type="date"
              className="search-date-input"
              value={modifiedAfter}
              onChange={e => setModifiedAfter(e.target.value)}
              placeholder={t('startDate', language)}
            />
            <span className="search-date-separator">~</span>
            <input
              type="date"
              className="search-date-input"
              value={modifiedBefore}
              onChange={e => setModifiedBefore(e.target.value)}
              placeholder={t('endDate', language)}
            />
            {(modifiedAfter || modifiedBefore) && (
              <button
                className="search-date-clear-btn"
                onClick={() => { setModifiedAfter(''); setModifiedBefore(''); }}
                title={t('resetModifiedFilter', language)}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Contents filters panel */}
      {mode === 'contents' && showContentsFilters && (
        <div className="search-date-filters">
          <div className="search-date-filter-row">
            <label className="search-date-filter-label">{t('noteType', language)}</label>
            <select
              className="search-details-select"
              value={contentsTypeFilter}
              onChange={e => setContentsTypeFilter(e.target.value)}
            >
              {NOTE_TYPES.map(nt => (
                <option key={nt.value} value={nt.value}>{nt.value === '' ? t('allTypes', language) : nt.label}</option>
              ))}
            </select>
            {contentsTypeFilter && (
              <button
                className="search-date-clear-btn"
                onClick={() => setContentsTypeFilter('')}
                title={t('resetTypeFilter', language)}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Attachments filters panel */}
      {mode === 'attachments' && showAttachmentsFilters && (
        <div className="search-date-filters">
          <div className="search-date-filter-row">
            <label className="search-date-filter-label">{t('container', language)}</label>
            <input
              type="text"
              className="search-date-input"
              value={attachmentsContainerFilter}
              onChange={e => setAttachmentsContainerFilter(e.target.value)}
              placeholder={t('containerPlaceholder', language)}
              style={{ flex: 1 }}
            />
            {attachmentsContainerFilter && (
              <button
                className="search-date-clear-btn"
                onClick={() => setAttachmentsContainerFilter('')}
                title={t('resetContainerFilter', language)}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div className="search-date-filter-row">
            <label className="search-date-filter-label">{t('extension', language)}</label>
            <input
              type="text"
              className="search-date-input"
              value={attachmentsExtensionFilter}
              onChange={e => setAttachmentsExtensionFilter(e.target.value)}
              placeholder={t('extensionPlaceholder', language)}
              style={{ flex: 1 }}
            />
            {attachmentsExtensionFilter && (
              <button
                className="search-date-clear-btn"
                onClick={() => setAttachmentsExtensionFilter('')}
                title={t('resetExtensionFilter', language)}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div className="search-date-filter-row">
            <label className="search-date-filter-label">{t('attachedNote', language)}</label>
            <input
              type="text"
              className="search-date-input"
              value={attachmentsNotePathFilter}
              onChange={e => setAttachmentsNotePathFilter(e.target.value)}
              placeholder={t('notePathPlaceholder', language)}
              style={{ flex: 1 }}
            />
            {attachmentsNotePathFilter && (
              <button
                className="search-date-clear-btn"
                onClick={() => setAttachmentsNotePathFilter('')}
                title={t('resetNotePathFilter', language)}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div className="search-date-filter-row">
            <label className="search-date-filter-label">{t('dummyFile', language)}</label>
            <button
              className={`search-filter-toggle-btn ${attachmentsShowDummyOnly ? 'active' : ''}`}
              onClick={() => setAttachmentsShowDummyOnly(!attachmentsShowDummyOnly)}
            >
              {attachmentsShowDummyOnly ? t('dummyOnly', language) : t('showAll', language)}
            </button>
          </div>
          {/* Batch delete dummy files button in filter panel */}
          {filteredAttachments.some(a => a.note_relative_path === '-') && (
            <div className="search-date-filter-row">
              <button
                className="search-batch-delete-filter-btn"
                onClick={onBatchDeleteDummy}
                title={t('batchDeleteDummyTitle', language)}
              >
                {t('batchDeleteDummyTitle', language)} ({filteredAttachments.filter(a => a.note_relative_path === '-').length})
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
