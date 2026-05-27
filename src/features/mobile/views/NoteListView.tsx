/**
 * NoteListView — Container interior with meta card + note list.
 * Features:
 *   - Container meta card with inline description editing
 *   - Note cards with template color dot + type badge
 *   - FAB → new note bottom sheet with template radio list
 *   - Sub-containers navigation
 */
import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight, FileText, Plus, Folder, MoreHorizontal } from 'lucide-react';
import { useFileTreeStore } from '../../../core/stores/fileTreeStore';
import { fileCommands, noteCommands } from '../../../core/services/tauriCommands';
import { parseFrontmatter } from '../../../core/utils/frontmatter';
import { useTemplateStore } from '../../templates/stores/templateStore';
import { applyNoteTemplateVariables } from '../../templates/templates';
import { useSettingsStore } from '../../../core/stores/settingsStore';
import { t, tf } from '../../../core/utils/i18n';
import { EmptyState } from '../components/common';
import { SwipeableRow } from '../components/common/SwipeableRow';
import { ActionSheet } from '../components/common/ActionSheet';
import { BottomSheet } from '../BottomSheet';
import { ContainerNotePreview } from '../components/ContainerNotePreview';
import { useLongPress } from '../../../hooks/useLongPress';
import { isTouchDevice } from '../../../core/utils/platform';
import { colors as tokenColors } from '../../../styles/tokens/colors';
import type { FileNode, NoteTemplate } from '../../../core/types';

interface Props {
  containerPath: string;
  onOpenNote: (notePath: string, name: string) => void;
  onOpenContainer?: (containerPath: string, name: string) => void;
}

function getContainerNotePath(containerPath: string, containerName: string): string {
  return `${containerPath}/${containerName}.md`.replace(/\\/g, '/');
}

function collectNotes(nodes: FileNode[], containerNotePath: string): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.is_dir && node.name.endsWith('_att')) continue;
    if (node.is_dir) continue;
    if (node.path.replace(/\\/g, '/') === containerNotePath) continue;
    if (node.name.endsWith('.md')) result.push(node);
  }
  return result;
}

// 5.0.10a (2026-05-17, HanBin) — i18n-aware relative time. Pass `language`
// so the Korean / English suffixes flip with the user setting.
function formatDate(mtime: number | undefined, language: import('../../../core/utils/i18n').LanguageSetting): string {
  if (!mtime) return '';
  const d = new Date(mtime * 1000);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t('mRelJustNow', language);
  if (diffMin < 60) return tf('mRelMinAgo', language, { n: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return tf('mRelHrAgo', language, { n: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return tf('mRelDayAgo', language, { n: diffDay });
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 5.0.10a — NOTE_TYPE_COLORS hex map promoted to existing theme tokens
// from note-type-colors.css (same source as desktop search/graph). The
// CSS vars are theme-aware (light + dark variants) so this works for
// both modes without reload.
const NOTE_TYPE_COLOR_VARS: Record<string, string> = {
  NOTE:    'var(--note-color)',
  MTG:     'var(--mtg-color)',
  SEM:     'var(--sem-color)',
  EVENT:   'var(--event-color)',
  CONTACT: 'var(--contact-color)',
  PAPER:   'var(--paper-color)',
  TASK:    'var(--task-color, var(--data-color))',
  DATA:    'var(--data-color)',
  SKETCH:  'var(--sketch-color)',
  SETUP:   'var(--setup-color)',
};

function getTypeColor(type?: string): string {
  return NOTE_TYPE_COLOR_VARS[type?.toUpperCase() ?? ''] ?? 'var(--setup-color)';
}

export default function NoteListView({ containerPath, onOpenNote, onOpenContainer }: Props) {
  const findNode = useFileTreeStore(s => s.findNodeByPath);
  const refreshFileTree = useFileTreeStore(s => s.refreshFileTree);
  const container = findNode(containerPath);
  const containerName = containerPath.split(/[/\\]/).pop() ?? '';
  const containerNotePath = getContainerNotePath(containerPath, containerName);

  const [containerMarkdown, setContainerMarkdown] = useState('');
  const [containerFrontmatterRaw, setContainerFrontmatterRaw] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [editHeading, setEditHeading] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [noteTypes, setNoteTypes] = useState<Map<string, string>>(new Map());
  const [showNewNote, setShowNewNote] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLInputElement>(null);

  const noteTemplates = useTemplateStore(s => s.noteTemplates);
  const enabledTemplateIds = useTemplateStore(s => s.enabledTemplateIds);
  const language = useSettingsStore(s => s.language);
  const [noteActionTarget, setNoteActionTarget] = useState<{ path: string; name: string } | null>(null);
  const isTouch = isTouchDevice();

  const availableTemplates = useMemo(() => {
    const skipTypes = new Set(['CONTACT', 'SKETCH', 'SETUP', 'CONTAINER']);
    return noteTemplates.filter(t =>
      enabledTemplateIds.includes(t.id) &&
      !skipTypes.has(t.frontmatter.type as string)
    );
  }, [noteTemplates, enabledTemplateIds]);

  // Auto-select first template when available
  useEffect(() => {
    if (!selectedTemplateId && availableTemplates.length > 0) {
      setSelectedTemplateId(availableTemplates[0].id);
    }
  }, [availableTemplates, selectedTemplateId]);

  // Load container note markdown (preserve formatting)
  useEffect(() => {
    fileCommands.readFile(containerNotePath.replace(/\//g, '\\')).then(content => {
      setContainerMarkdown(content.body.trim());
      setContainerFrontmatterRaw(content.frontmatter ?? '');
    }).catch(() => { setContainerMarkdown(''); setContainerFrontmatterRaw(''); });
  }, [containerNotePath]);

  const subContainers = useMemo(() => {
    if (!container?.children) return [];
    return container.children.filter((n: FileNode) =>
      n.is_dir && !n.name.startsWith('.') && !n.name.endsWith('_att')
    );
  }, [container]);

  const notes = useMemo(() => {
    if (!container?.children) return [];
    return collectNotes(container.children, containerNotePath)
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  }, [container, containerNotePath]);

  // Load note types from frontmatter
  useEffect(() => {
    const types = new Map<string, string>();
    Promise.all(notes.map(n =>
      fileCommands.readFile(n.path).then(c => {
        if (c.frontmatter) {
          try {
            const fm = parseFrontmatter(c.frontmatter);
            if (fm.type) types.set(n.path, fm.type);
          } catch { /* ignore */ }
        }
      }).catch(() => {})
    )).then(() => setNoteTypes(new Map(types)));
  }, [notes]);

  // Parse markdown into heading + description for 2-field editing
  const startEditDesc = useCallback(() => {
    const lines = containerMarkdown.split('\n');
    let heading = '';
    const descLines: string[] = [];
    let pastHeading = false;
    for (const line of lines) {
      if (!pastHeading && /^#{1,6}\s+/.test(line)) {
        heading = line.replace(/^#{1,6}\s+/, '');
        pastHeading = true;
      } else if (pastHeading || heading === '') {
        // Strip blockquote prefix if present
        const stripped = line.startsWith('> ') ? line.slice(2) : line;
        descLines.push(stripped);
        pastHeading = true;
      }
    }
    setEditHeading(heading);
    setEditDescription(descLines.join('\n').trim());
    setEditingDesc(true);
    setTimeout(() => headingRef.current?.focus(), 50);
  }, [containerMarkdown]);

  const saveDesc = useCallback(async () => {
    setEditingDesc(false);
    const h = editHeading.trim();
    const d = editDescription.trim();
    // Reconstruct markdown: # heading + > description
    const parts: string[] = [];
    if (h) parts.push(`# ${h}`);
    if (d) {
      parts.push('');
      parts.push(...d.split('\n').map(l => `> ${l}`));
    }
    const newBody = parts.join('\n');
    if (newBody === containerMarkdown) return;
    setContainerMarkdown(newBody);
    try {
      const filePath = containerNotePath.replace(/\//g, '\\');
      await fileCommands.writeFile(filePath, containerFrontmatterRaw || null, newBody);
    } catch (e) {
      console.error('Failed to save description:', e);
    }
  }, [editHeading, editDescription, containerMarkdown, containerNotePath, containerFrontmatterRaw]);

  // Create note — always uses a template (no blank note)
  const handleCreateNote = useCallback(async () => {
    const title = newTitle.trim();
    if (!title || !selectedTemplateId || creating) return;
    setCreating(true);
    try {
      const template = noteTemplates.find(t => t.id === selectedTemplateId);
      if (!template) return;

      const { fileName, frontmatter, body } = applyNoteTemplateVariables(
        template, { title }, undefined, language
      );
      const newPath = await noteCommands.createNoteWithTemplate(containerPath, fileName, frontmatter, body);
      await refreshFileTree();
      setShowNewNote(false);
      setNewTitle('');
      setSelectedTemplateId(null);
      onOpenNote(newPath, title);
    } catch (e) {
      console.error('Failed to create note:', e);
    } finally {
      setCreating(false);
    }
  }, [newTitle, containerPath, creating, refreshFileTree, onOpenNote, selectedTemplateId, noteTemplates, language]);

  const handleDeleteNote = useCallback(async (notePath: string) => {
    try {
      await noteCommands.deleteNote(notePath);
      await refreshFileTree();
    } catch (e) {
      console.error('Failed to delete note:', e);
    }
  }, [refreshFileTree]);

  const displayName = (name: string) => name.replace(/\.md$/, '');

  const colorIndex = containerPath.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const containerColor = tokenColors.folder[colorIndex % tokenColors.folder.length];

  return (
    <div className="mobile-note-list">
      {/* Container meta card */}
      <div className="m-container-meta">
        <div className="m-container-meta-header">
          <span className="m-container-meta-icon" style={{ background: `${containerColor}1A`, borderRadius: 8 }}>
            <Folder size={16} color={containerColor} />
          </span>
          <span className="m-container-meta-name">{containerName}</span>
        </div>

        {/* Description — 2-field edit or markdown preview */}
        <div className="m-container-meta-desc">
          {editingDesc ? (
            <>
              <div className="m-container-meta-field-label">제목</div>
              <input
                ref={headingRef}
                className="m-container-meta-heading-input"
                type="text"
                value={editHeading}
                onChange={e => setEditHeading(e.target.value)}
                placeholder="컨테이너 제목"
              />
              <div className="m-container-meta-field-label">설명</div>
              <textarea
                ref={descRef}
                className="m-container-meta-desc-textarea"
                value={editDescription}
                onChange={e => setEditDescription(e.target.value)}
                placeholder="설명을 입력하세요"
                rows={3}
              />
              <button className="m-container-meta-done-btn" onClick={saveDesc}>완료</button>
            </>
          ) : containerMarkdown ? (
            <ContainerNotePreview
              markdown={containerMarkdown}
              onEdit={startEditDesc}
              maxLines={6}
            />
          ) : (
            <p className="m-container-meta-desc-placeholder" onClick={startEditDesc}>
              설명을 추가하려면 탭하세요
            </p>
          )}
        </div>

        <div className="m-container-meta-stats">
          {notes.length}개 노트
          {subContainers.length > 0 && ` · ${subContainers.length}개 하위 컨테이너`}
        </div>
      </div>

      <div className="mobile-grouped-list">
        {/* Sub-containers */}
        {subContainers.length > 0 && onOpenContainer && (
          <div className="mobile-group">
            <div className="mobile-group-header">하위 컨테이너</div>
            <div className="mobile-group-content">
              {subContainers.map(sc => (
                <button
                  key={sc.path}
                  className="mobile-group-item"
                  onClick={() => onOpenContainer(sc.path, sc.name)}
                >
                  <Folder size={16} style={{ color: 'var(--c-blue)', flexShrink: 0 }} />
                  <div className="mobile-group-item-text">
                    <div className="mobile-group-item-title">{sc.name}</div>
                  </div>
                  <ChevronRight size={16} className="mobile-group-item-chevron" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Notes */}
        {notes.length === 0 && subContainers.length === 0 ? (
          <EmptyState
            icon={<FileText size={48} />}
            title="아직 노트가 없습니다"
            description="+ 버튼으로 첫 노트를 만들어보세요"
          />
        ) : notes.length > 0 ? (
          <div className="m-note-card-list">
            {notes.map((n, i) => {
              const type = noteTypes.get(n.path);
              const typeColor = getTypeColor(type);
              const card = (
                <NoteCard
                  key={n.path}
                  node={n}
                  type={type}
                  typeColor={typeColor}
                  index={i}
                  onOpen={() => onOpenNote(n.path, displayName(n.name))}
                  onLongPress={() => setNoteActionTarget({ path: n.path, name: displayName(n.name) })}
                  isTouch={isTouch}
                  displayName={displayName}
                />
              );
              return isTouch ? (
                <SwipeableRow key={n.path} onDelete={() => handleDeleteNote(n.path)}>
                  {card}
                </SwipeableRow>
              ) : card;
            })}
          </div>
        ) : null}
      </div>

      {/* Note long-press Action Sheet */}
      {noteActionTarget && (
        <ActionSheet
          title={noteActionTarget.name}
          message="노트"
          actions={[
            { label: '열기', onPress: () => { onOpenNote(noteActionTarget.path, noteActionTarget.name); setNoteActionTarget(null); } },
            { label: '이름 변경', onPress: () => { /* TODO: rename flow */ setNoteActionTarget(null); } },
            { label: '다른 컨테이너로 이동', onPress: () => { /* TODO: move flow */ setNoteActionTarget(null); } },
            { label: '복제', onPress: () => { /* TODO: duplicate flow */ setNoteActionTarget(null); } },
            { label: '태그 관리', onPress: () => { /* TODO: tag flow */ setNoteActionTarget(null); } },
            { label: '삭제', destructive: true, onPress: () => { handleDeleteNote(noteActionTarget.path); setNoteActionTarget(null); } },
          ]}
          onCancel={() => setNoteActionTarget(null)}
        />
      )}

      {/* FAB */}
      <div className="m-fab-container">
        <button className="m-fab-btn" onClick={() => setShowNewNote(true)} aria-label="새 노트">
          <Plus size={24} />
        </button>
      </div>

      {/* New note Bottom Sheet with template radio list */}
      <BottomSheet open={showNewNote} onClose={() => { setShowNewNote(false); setSelectedTemplateId(null); setNewTitle(''); }} title="새 노트">
        <div className="m-new-note-form">
          <div className="m-new-note-field-label">제목</div>
          <input
            className="m-text-input"
            type="text"
            placeholder="노트 제목을 입력하세요"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateNote()}
            autoFocus
          />

          <div className="m-new-note-field-label" style={{ marginTop: 16 }}>템플릿 선택</div>
          <div className="m-template-radio-list">
            {/* Template options — template selection is required */}
            {availableTemplates.map(t => {
              const type = (t.frontmatter.type as string)?.toUpperCase() ?? '';
              const typeColor = getTypeColor(type) || '#98989D';
              const isSelected = selectedTemplateId === t.id;
              return (
                <label key={t.id} className={`m-template-radio-item ${isSelected ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="template"
                    checked={isSelected}
                    onChange={() => setSelectedTemplateId(t.id)}
                    className="m-template-radio-input"
                  />
                  <span className={`m-template-radio-circle ${isSelected ? 'checked' : ''}`} />
                  <span className="m-template-radio-dot" style={{ background: typeColor }} />
                  <div className="m-template-radio-body">
                    <span className="m-template-radio-name">{t.name}</span>
                    <span className="m-template-radio-desc">{type || '기본'} 템플릿</span>
                  </div>
                </label>
              );
            })}
          </div>

          <div className="m-new-note-actions">
            <button
              className="m-new-container-btn m-new-container-btn--cancel"
              onClick={() => { setShowNewNote(false); setSelectedTemplateId(null); setNewTitle(''); }}
            >
              취소
            </button>
            <button
              className="m-new-container-btn m-new-container-btn--confirm"
              onClick={handleCreateNote}
              disabled={!newTitle.trim() || !selectedTemplateId || creating}
            >
              {creating ? '생성 중...' : '생성'}
            </button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}

/** Note card with long-press support */
function NoteCard({
  node, type, typeColor, index, onOpen, onLongPress, isTouch, displayName,
}: {
  node: FileNode; type?: string; typeColor: string; index: number;
  onOpen: () => void; onLongPress: () => void; isTouch: boolean;
  displayName: (name: string) => string;
}) {
  const longPressProps = useLongPress({
    onLongPress,
    onPress: onOpen,
    disabled: !isTouch,
  });

  const handlers = isTouch ? longPressProps : { onClick: onOpen };

  return (
    <button
      className="m-note-card stagger-item"
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
      {...(handlers as any)}
    >
      <span className="m-note-card-dot" style={{ background: typeColor }} />
      <div className="m-note-card-body">
        <span className="m-note-card-title">{displayName(node.name)}</span>
        <span className="m-note-card-meta">
          {type && (
            <span className="m-note-card-badge" style={{ color: typeColor, background: `${typeColor}18` }}>
              {type}
            </span>
          )}
          <span>{formatDate(node.mtime, language)}</span>
        </span>
      </div>
      <ChevronRight size={16} className="m-note-card-chevron" />
    </button>
  );
}
