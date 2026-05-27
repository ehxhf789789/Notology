/**
 * ContainerListView — "보관소" home.
 * Templates removed from here (they only appear in new note dialog).
 * Features: list/grid toggle, FAB → new container bottom sheet.
 */
import { useMemo, useState, useCallback, lazy, Suspense } from 'react';
import { ChevronRight, Folder, List, LayoutGrid, GitBranch, Plus } from 'lucide-react';
import { useFileTreeStore } from '../../../core/stores/fileTreeStore';
import { useSettingsStore } from '../../../core/stores/settingsStore';
import { noteCommands } from '../../../core/services/tauriCommands';
import { EmptyState, TextInput } from '../components/common';
import { SwipeableRow } from '../components/common/SwipeableRow';
import { ActionSheet } from '../components/common/ActionSheet';
import { BottomSheet } from '../BottomSheet';
import { useLongPress } from '../../../hooks/useLongPress';
import { usePullToRefresh } from '../../../hooks/usePullToRefresh';
import { isTouchDevice } from '../../../core/utils/platform';
import { colors } from '../../../styles/tokens/colors';
// v1 sync stub (M-4b에서 v2로 재구현 예정)
const syncCommands = { syncNow: async () => {} };
import { t, tf } from '../../../core/utils/i18n';

interface Props {
  onOpenContainer: (path: string, name: string) => void;
  onOpenNote?: (notePath: string, name: string) => void;
}

type ViewMode = 'list' | 'grid' | 'graph';

function countNotes(children: any[]): number {
  let count = 0;
  for (const c of children) {
    if (!c.is_dir && c.name.endsWith('.md') && c.name !== c.path?.split(/[/\\]/).slice(-2, -1)[0] + '.md') {
      count++;
    }
    if (c.children) count += countNotes(c.children);
  }
  return count;
}

function formatLastModified(children: any[]): string {
  let latest = 0;
  for (const c of children) {
    if (c.mtime && c.mtime > latest) latest = c.mtime;
    if (c.children) {
      const sub = getLatestMtime(c.children);
      if (sub > latest) latest = sub;
    }
  }
  if (!latest) return '';
  const d = new Date(latest * 1000);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '방금 수정';
  if (diffMin < 60) return `${diffMin}분 전 수정`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전 수정`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}일 전 수정`;
  return `${d.getMonth() + 1}/${d.getDate()} 수정`;
}

function getLatestMtime(children: any[]): number {
  let latest = 0;
  for (const c of children) {
    if (c.mtime && c.mtime > latest) latest = c.mtime;
    if (c.children) {
      const sub = getLatestMtime(c.children);
      if (sub > latest) latest = sub;
    }
  }
  return latest;
}

const GraphView = lazy(() => import('./GraphView'));

export default function ContainerListView({ onOpenContainer, onOpenNote }: Props) {
  const fileTree = useFileTreeStore(s => s.fileTree);
  const vaultPath = useFileTreeStore(s => s.vaultPath);
  const refreshFileTree = useFileTreeStore(s => s.refreshFileTree);
  const language = useSettingsStore(s => s.language);

  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [showNewContainer, setShowNewContainer] = useState(false);
  const [newName, setNewName] = useState('');

  const { scrollRef, pulling, pullDistance, refreshing, handlers: pullHandlers } = usePullToRefresh({
    onRefresh: async () => {
      await syncCommands.syncNow().catch(() => {});
      await refreshFileTree();
    },
  });
  const [selectedColor, setSelectedColor] = useState(0);
  const [creating, setCreating] = useState(false);
  const [actionTarget, setActionTarget] = useState<{ path: string; name: string } | null>(null);

  const isTouch = isTouchDevice();

  const folders = useMemo(() =>
    fileTree.filter(n => n.is_dir && !n.name.startsWith('.') && !n.name.endsWith('_att')),
    [fileTree]
  );

  const handleCreateContainer = useCallback(async () => {
    const name = newName.trim();
    if (!name || creating || !vaultPath) return;
    setCreating(true);
    try {
      const folderPath = `${vaultPath}/${name}`;
      await noteCommands.createNote(folderPath, name); // creates folder + container note
      await refreshFileTree();
      setShowNewContainer(false);
      setNewName('');
      onOpenContainer(folderPath, name);
    } catch (e) {
      console.error('Failed to create container:', e);
    } finally {
      setCreating(false);
    }
  }, [newName, creating, vaultPath, refreshFileTree, onOpenContainer]);

  const handleDeleteContainer = useCallback(async (folderPath: string, _name: string) => {
    try {
      await noteCommands.deleteNote(folderPath);
      await refreshFileTree();
    } catch (e) {
      console.error('Failed to delete container:', e);
    }
  }, [refreshFileTree]);

  return (
    <div className="mobile-container-list" ref={scrollRef} {...pullHandlers}>
      {/* Pull-to-refresh indicator */}
      {pulling && (
        <div className="mobile-pull-indicator" style={{ height: pullDistance, opacity: Math.min(pullDistance / 60, 1) }}>
          <div className={`mobile-pull-spinner ${refreshing ? 'active' : ''}`}>
            {refreshing ? '동기화 중...' : '↓ 당겨서 동기화'}
          </div>
        </div>
      )}
      <h1 className="mobile-large-title">{t('mVaultLabel', language)}</h1>

      {/* Sort label + View toggle */}
      {folders.length > 0 && (
        <div className="m-toolbar-row">
          <span className="m-sort-label">{t('mSortRecent', language)}</span>
          <div className="m-view-toggle">
            <button
              className={`m-view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
              aria-label="리스트 보기"
            >
              <List size={18} />
            </button>
            <button
              className={`m-view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              aria-label="그리드 보기"
            >
              <LayoutGrid size={18} />
            </button>
            <button
              className={`m-view-toggle-btn ${viewMode === 'graph' ? 'active' : ''}`}
              onClick={() => setViewMode('graph')}
              aria-label="그래프 보기"
            >
              <GitBranch size={18} />
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      {viewMode === 'graph' ? (
        <Suspense fallback={<div className="mobile-loading">로딩 중...</div>}>
          <div className="m-graph-inline" style={{ flex: 1, minHeight: 0, height: 'calc(100vh - 200px)' }}>
            <GraphView onOpenNote={onOpenNote} onOpenContainer={onOpenContainer} />
          </div>
        </Suspense>
      ) : folders.length === 0 ? (
        <EmptyState
          icon={<Folder size={48} />}
          title={t('mEmptyContainer', language)}
          description={t('mEmptyContainerHint', language)}
          actionLabel={t('mCreateContainer', language)}
          onAction={() => setShowNewContainer(true)}
        />
      ) : viewMode === 'grid' ? (
        <div className="m-card-grid">
          {folders.map((f, i) => {
            const noteCount = f.children ? countNotes(f.children) : 0;
            const color = colors.folder[i % colors.folder.length];
            const lastMod = f.children ? formatLastModified(f.children) : '';
            return (
              <button
                key={f.path}
                className="m-card-grid-item stagger-item"
                style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
                onClick={() => onOpenContainer(f.path, f.name)}
              >
                <div className="m-card-grid-item-color" style={{ background: `${color}14` }}>
                  <Folder size={24} color={color} />
                </div>
                <div className="m-card-grid-item-name">{f.name}</div>
                <div className="m-card-grid-item-meta">
                  {noteCount}개 노트{lastMod ? ` · ${lastMod}` : ''}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="m-card-list">
          {folders.map((f, i) => {
            const noteCount = f.children ? countNotes(f.children) : 0;
            const color = colors.folder[i % colors.folder.length];
            const lastMod = f.children ? formatLastModified(f.children) : '';
            const card = (
              <ContainerCard
                key={f.path}
                folder={f}
                color={color}
                noteCount={noteCount}
                lastMod={lastMod}
                index={i}
                onOpen={() => onOpenContainer(f.path, f.name)}
                onLongPress={() => setActionTarget({ path: f.path, name: f.name })}
                isTouch={isTouch}
              />
            );
            return isTouch ? (
              <SwipeableRow
                key={f.path}
                onDelete={() => handleDeleteContainer(f.path, f.name)}
              >
                {card}
              </SwipeableRow>
            ) : card;
          })}
        </div>
      )}

      {/* FAB — single action: new container */}
      <div className="m-fab-container">
        <button className="m-fab-btn" onClick={() => setShowNewContainer(true)} aria-label="새 컨테이너">
          <Plus size={24} />
        </button>
      </div>

      {/* Long-press Action Sheet */}
      {actionTarget && (
        <ActionSheet
          title={actionTarget.name}
          message="컨테이너"
          actions={[
            { label: '이름 변경', onPress: () => { /* TODO: rename flow */ setActionTarget(null); } },
            { label: '복제', onPress: () => { /* TODO: duplicate flow */ setActionTarget(null); } },
            { label: '삭제', destructive: true, onPress: () => { handleDeleteContainer(actionTarget.path, actionTarget.name); setActionTarget(null); } },
          ]}
          onCancel={() => setActionTarget(null)}
        />
      )}

      {/* New container Bottom Sheet */}
      <BottomSheet open={showNewContainer} onClose={() => { setShowNewContainer(false); setNewName(''); }} title="새 컨테이너">
        <div className="m-new-container-form">
          <TextInput
            placeholder="컨테이너 이름"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateContainer()}
            autoFocus
          />

          <div className="m-new-container-color-label">컬러</div>
          <div className="m-new-container-colors">
            {colors.folder.map((c, i) => (
              <button
                key={c}
                className={`m-new-container-color-swatch ${selectedColor === i ? 'active' : ''}`}
                style={{ background: c }}
                onClick={() => setSelectedColor(i)}
              />
            ))}
          </div>

          <div className="m-new-container-actions">
            <button
              className="m-new-container-btn m-new-container-btn--cancel"
              onClick={() => { setShowNewContainer(false); setNewName(''); }}
            >
              취소
            </button>
            <button
              className="m-new-container-btn m-new-container-btn--confirm"
              onClick={handleCreateContainer}
              disabled={!newName.trim() || creating}
            >
              {creating ? '생성 중...' : '생성'}
            </button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}

/** Container card with long-press support */
function ContainerCard({
  folder, color, noteCount, lastMod, index, onOpen, onLongPress, isTouch,
}: {
  folder: any; color: string; noteCount: number; lastMod: string;
  index: number; onOpen: () => void; onLongPress: () => void; isTouch: boolean;
}) {
  const longPressProps = useLongPress({
    onLongPress,
    onPress: onOpen,
    disabled: !isTouch,
  });

  const handlers = isTouch ? longPressProps : { onClick: onOpen };

  return (
    <button
      className="m-card-item stagger-item"
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
      {...(handlers as any)}
    >
      <span className="m-card-item-icon" style={{ background: `${color}1A`, borderRadius: 8 }}>
        <Folder size={16} color={color} />
      </span>
      <div className="m-card-item-body">
        <span className="m-card-item-title">{folder.name}</span>
        <span className="m-card-item-subtitle">
          {noteCount}개 노트{lastMod ? ` · ${lastMod}` : ''}
        </span>
      </div>
      <span className="m-card-item-trailing">
        <ChevronRight size={16} />
      </span>
    </button>
  );
}
