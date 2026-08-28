// 🔴 버튼이 아니라 **거기 있는 존재**로 바꿨다 (DobbinPresence.tsx)
import { useState, useRef, useEffect, useCallback } from 'react';
import { displayName, rootLabel } from '../utils/rootPath';
import { VaultPicker } from '../../features/vault-config/VaultPicker';
import { createPortal } from 'react-dom';
import { Search, Plus, UploadCloud, Settings as SettingsIcon, FolderClosed, ChevronDown, FolderPlus, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Slot } from '../infrastructure/slotRegistry';
import {
  useVaultPath,
  useFileTree,
  useSelectedContainer,
} from '../stores/zustand';
import { useShowSearch, useShowDobbinHome, useSidebarCollapsed, useUIStore, uiActions } from '../stores/uiStore';
import { IconButton, Tooltip } from '../../design-system/components';
import { PenguinFace } from '../../features/dobbin/PenguinFace';
import { useDobbinPulse } from '../../features/dobbin/useDobbinPulse';
import { useContainerConfigs, vaultConfigActions } from '../../features/vault-config/stores/vaultConfigStore';
import { modalActions } from '../../features/modals/stores/modalStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useModalClose } from '../hooks/useModalListeners';
import { openVault, createFolder, selectContainer } from '../stores/appActions';
import Settings from '../../features/settings/Settings';
import RibbonBar from './RibbonBar';
import FolderTree from '../../features/folder-tree/FolderTree';
import type { ContainerType } from '../types';
import { t } from '../utils/i18n';

function Sidebar() {
  // ========== ZUSTAND SELECTIVE SUBSCRIPTIONS (prevents cascade re-renders) ==========
  const vaultPath = useVaultPath();
  const fileTree = useFileTree();
  const selectedContainer = useSelectedContainer();

  // ========== ZUSTAND UI STATE ==========
  const showSearch = useShowSearch();
  const showDobbinHome = useShowDobbinHome();
  const pulse = useDobbinPulse();
  const sidebarCollapsed = useSidebarCollapsed();
  const containerConfigs = useContainerConfigs();
  const language = useSettingsStore(s => s.language);

  // Get vault name from path
  // 🔴 뿌리표(`vault:`)가 그대로 바닥 칸에 나오던 자리 (rootPath.ts 머리말).
  //    `vault:` 에는 `/` 가 없어 `pop()` 이 통째로 돌려줬다.
  const vaultName = vaultPath ? (displayName(vaultPath) || rootLabel(vaultPath)) : '';
  const [showSettings, setShowSettings] = useState(false);

  // Listen for 'open-settings' custom event (from sync_v2 popover, Ctrl+, etc.)
  useEffect(() => {
    const handler = () => setShowSettings(true);
    window.addEventListener('open-settings', handler);
    return () => window.removeEventListener('open-settings', handler);
  }, []);

  // Listen for 'open-new-folder' (Ctrl+Shift+N) — Stage 5.0.4a.
  // If sidebar is collapsed (icon-only), expand it first so the input modal
  // has visible context. Skip if no vault open.
  useEffect(() => {
    const handler = () => {
      if (!vaultPath) return;
      if (useUIStore.getState().sidebarCollapsed) {
        uiActions.setSidebarCollapsed(false);
      }
      setShowNewContainer(true);
    };
    window.addEventListener('open-new-folder', handler);
    return () => window.removeEventListener('open-new-folder', handler);
  }, [vaultPath]);

  const [showNewContainer, setShowNewContainer] = useState(false);
  const [newContainerName, setNewContainerName] = useState('');
  const [showTypeSelector, setShowTypeSelector] = useState(false);
  const [pendingContainerPath, setPendingContainerPath] = useState<string | null>(null);
  const [typeSelectorPos, setTypeSelectorPos] = useState({ x: 0, y: 0 });
  const [rootContainer, setRootContainer] = useState<string | null>(null);
  const [showNewSubfolder, setShowNewSubfolder] = useState(false);
  const [newSubfolderName, setNewSubfolderName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const subfolderInputRef = useRef<HTMLInputElement>(null);
  const typeSelectorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showNewContainer && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showNewContainer]);

  useEffect(() => {
    if (showNewSubfolder && subfolderInputRef.current) {
      subfolderInputRef.current.focus();
    }
  }, [showNewSubfolder]);

  // Handle type selector close with hook
  const closeTypeSelector = useCallback(() => {
    setShowTypeSelector(false);
    setPendingContainerPath(null);
  }, []);
  useModalClose(typeSelectorRef, closeTypeSelector, showTypeSelector);

  const cancelNew = () => {
    setShowNewContainer(false);
    setNewContainerName('');
  };

  const handleCreateContainer = async () => {
    if (!newContainerName.trim()) {
      cancelNew();
      return;
    }
    try {
      const containerPath = await createFolder(newContainerName.trim());
      setShowNewContainer(false);
      setNewContainerName('');
      // Position type selector at center of screen
      setTypeSelectorPos({
        x: Math.round(window.innerWidth / 2 - 100),
        y: Math.round(window.innerHeight / 2 - 60)
      });
      setPendingContainerPath(containerPath);
      setShowTypeSelector(true);
    } catch (e) {
      console.error('Failed to create container:', e);
    }
  };

  const handleSelectType = useCallback((type: ContainerType) => {
    if (!pendingContainerPath) return;
    if (type === 'standard') {
      vaultConfigActions.setContainerConfig(pendingContainerPath, { type: 'standard' });
      setShowTypeSelector(false);
      setPendingContainerPath(null);
    } else {
      setShowTypeSelector(false);
      const pos = typeSelectorPos;
      modalActions.showTemplateSelector(pos, (templateId: string) => {
        if (pendingContainerPath) {
          vaultConfigActions.setContainerConfig(pendingContainerPath, {
            type: 'storage',
            assignedTemplateId: templateId,
          });
        }
        setPendingContainerPath(null);
      });
    }
  }, [pendingContainerPath, typeSelectorPos]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCreateContainer();
    if (e.key === 'Escape') cancelNew();
  };

  const cancelNewSubfolder = () => {
    setShowNewSubfolder(false);
    setNewSubfolderName('');
  };

  const handleCreateSubfolder = async () => {
    // Use selectedContainer (can be root or subfolder) as parent
    if (!newSubfolderName.trim() || !selectedContainer) {
      cancelNewSubfolder();
      return;
    }
    try {
      const newFolderPath = await createFolder(newSubfolderName.trim(), selectedContainer);
      setShowNewSubfolder(false);
      setNewSubfolderName('');
      // Auto-select the newly created folder
      selectContainer(newFolderPath);
    } catch (e) {
      console.error('Failed to create subfolder:', e);
    }
  };

  const handleSubfolderKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCreateSubfolder();
    if (e.key === 'Escape') cancelNewSubfolder();
  };

  // Top-level folders = containers (exclude system folders)
  const containers = fileTree.filter(node => node.is_dir && node.name !== '.notology');

  // Find the root container for the selected container
  const getRootContainerPath = (containerPath: string | null): string | null => {
    if (!containerPath || !vaultPath) return null;
    const normalizedPath = containerPath.replace(/\\/g, '/');
    const normalizedVault = vaultPath.replace(/\\/g, '/');
    // Remove vault path prefix
    const relativePath = normalizedPath.startsWith(normalizedVault)
      ? normalizedPath.slice(normalizedVault.length + 1)
      : normalizedPath;
    // Get first segment (root container name)
    const firstSegment = relativePath.split('/')[0];
    if (!firstSegment) return null;
    return `${normalizedVault}/${firstSegment}`.replace(/\//g, '\\');
  };

  // Check if the selected container is inside a Storage container
  const isInsideStorageContainer = (): boolean => {
    const rootPath = getRootContainerPath(selectedContainer);
    if (!rootPath) return false;
    const config = containerConfigs[rootPath];
    return config?.type === 'storage';
  };

  // Handle new subfolder button click with Storage check
  const handleNewSubfolderClick = () => {
    if (isInsideStorageContainer()) {
      modalActions.showAlertModal(
        t('cannotCreateFolder', language),
        t('storageNoFolderMsg', language)
      );
      return;
    }
    setShowNewSubfolder(true);
  };

  return (
    <>
      <aside className={`sidebar${sidebarCollapsed ? ' sidebar--icon-only' : ''}`}>
        {/* Sidebar Header */}
        <div className="sidebar-header">
          <div className="sidebar-header-left">
            <button
              className={`sidebar-toggle-btn ${sidebarCollapsed ? 'collapsed' : ''}`}
              onClick={() => uiActions.setSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? t('sidebarExpand', language) : t('sidebarCollapse', language)}
              aria-label={sidebarCollapsed ? t('sidebarExpand', language) : t('sidebarCollapse', language)}
              aria-pressed={sidebarCollapsed}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
          </div>
          {!sidebarCollapsed && (
            <div className="sidebar-actions">
              <button
                className="sidebar-action-btn"
                onClick={() => setShowNewContainer(!showNewContainer)}
                title={t('newFolder', language)}
                disabled={!vaultPath}
              >
                <Plus size={18} strokeWidth={2} />
              </button>
              <button
                className={`sidebar-action-btn ${showSearch ? 'active' : ''}`}
                onClick={() => uiActions.setShowSearch(true)}
                title={t('search', language)}
                disabled={!vaultPath}
              >
                <Search size={16} strokeWidth={2} />
              </button>
              {/* 🔴 **무대를 바꾸는 것은 왼쪽에 둔다** (2026-08-27 사용자:
                  "탭 구조가 아니라 좌측 슬라이드에 버튼으로"). 검색이 이미
                  그 규칙이었다 — 좌측 = 중앙 뷰, 우측 탭 = 곁에 두는 패널.
                  2026-08-11 에 좌측에서 뺐던 dobbin 단추와는 성격이 다르다:
                  그때는 «패널을 여는» 단추였고 지금은 «홈을 여는» 단추다. */}
              <button
                className={`sidebar-action-btn sidebar-action-btn--dobbin ${showDobbinHome ? 'active' : ''}`}
                onClick={() => uiActions.setShowDobbinHome(!showDobbinHome)}
                title={pulse.unseen > 0
                  ? `dobbin — 알림 ${pulse.unseen}건`
                  : 'dobbin — 이 서재의 사서'}
                disabled={!vaultPath}
              >
                {/* 🔴 상태가 있어야 애니메이션이 있다 (2-14-2-2) — 읽는 중이면
                    생각하고, 알릴 것이 있으면 붉게 맥박한다. 장식이 아니다. */}
                <PenguinFace mood={pulse.mood} size={22} />
                {pulse.unseen > 0 && (
                  <span className="sidebar-action-btn__n"
                        aria-label={`${pulse.unseen}건 알림`}>{pulse.unseen}</span>
                )}
              </button>

            </div>
          )}
        </div>

        {sidebarCollapsed ? (
          /* ── Icon-only collapsed mode (Stage 5.0.3b) ── */
          <nav className="sidebar-icon-rail">
            <Tooltip content={t('newFolder', language)} placement="right">
              <IconButton
                icon={<Plus size={18} strokeWidth={2} />}
                aria-label={t('newFolder', language)}
                variant="ghost"
                size="md"
                disabled={!vaultPath}
                onClick={() => {
                  uiActions.setSidebarCollapsed(false);
                  setShowNewContainer(true);
                }}
              />
            </Tooltip>
            <Tooltip content={t('search', language)} placement="right">
              <IconButton
                icon={<Search size={16} strokeWidth={2} />}
                aria-label={t('search', language)}
                variant="ghost"
                size="md"
                pressed={showSearch}
                disabled={!vaultPath}
                onClick={() => uiActions.setShowSearch(true)}
              />
            </Tooltip>
            <Tooltip content="dobbin — 이 서재의 사서" placement="right">
              <IconButton
                icon={<PenguinFace mood={pulse.mood} size={22} />}
                aria-label="dobbin"
                variant="ghost"
                size="md"
                pressed={showDobbinHome}
                disabled={!vaultPath}
                onClick={() => uiActions.setShowDobbinHome(!showDobbinHome)}
              />
            </Tooltip>
          </nav>
        ) : (
          <>
            {/* Unified Container and Folder Tree */}
            <nav className="sidebar-content">
              {vaultPath ? (
                <FolderTree
                  containers={containers}
                  rootContainer={rootContainer}
                  onRootContainerChange={setRootContainer}
                  onNewSubfolder={handleNewSubfolderClick}
                />
              ) : (
                <div className="sidebar-empty">
                  <button className="open-vault-btn" onClick={() => openVault()}>
                    {t('openVault', language)}
                  </button>
                  <p className="sidebar-empty-text">{t('noVaultOpen', language)}</p>
                </div>
              )}
            </nav>

            {/* Ribbon Bar */}
            {vaultPath && <RibbonBar />}
          </>
        )}

        {/* Sidebar Footer — vault button + sync status + settings + collapse toggle */}
        {/* 🔴 **dobbin과 자료 넣기는 오른쪽 탭으로 옮겼다** (사용자 지시,
            2026-08-11: *"좌측 슬라이드의 dobbin, 파일 넣기 버튼 제거.
            우측 슬라이드의 버튼(탭)으로 모든 기능 이동. 말풍선 및 알림
            기능도 우측 슬라이드 버튼으로 이동."*).

            **같은 일을 두 곳에서 부르면 어느 쪽이 진짜인지 모른다.**
            왼쪽은 탐색기(무엇이 있나), 오른쪽은 dobbin에게 맡기는 자리다. */}
        <div className="sidebar-footer">
          {!sidebarCollapsed && (
            <>
              {/* 🔴 **데스크톱 창 흐름의 잔재를 걷어냈다** (2026-08-25).
                  옛 단추는 `switch_vault_requested` 를 보내 Tauri 네이티브
                  창을 띄우려 했고, 웹에는 그런 창이 없어 **눌러도 조용히
                  아무 일이 없었다** (사용자: *"보관소 선택 및 생성 기능도
                  여전히 없다"*). `VaultPicker` 가 서버 등록부를 그대로
                  보여 주고 거기서 만든다. */}
              <VaultPicker />
              <Slot name="sidebar-footer-status" />
            </>
          )}
          <button
            className="sidebar-footer-btn settings-btn"
            onClick={() => setShowSettings(true)}
            title={t('settings', language)}
          >
            <SettingsIcon size={14} strokeWidth={2} />
          </button>
        </div>
      </aside>

      {/* Container Type Selector Popup - Portal to body for correct positioning */}
      {showTypeSelector && createPortal(
        <div className="container-type-selector-overlay">
          <div
            ref={typeSelectorRef}
            className="container-type-selector-v2"
          >
            <div className="container-type-selector-header-v2">
              <span>{t('containerTypeSelect', language)}</span>
              <span className="container-type-selector-hint">{t('newContainerHint', language)}</span>
            </div>
            <div className="container-type-selector-content">
              <button
                className="container-type-selector-item-v2 standard"
                onClick={() => handleSelectType('standard')}
              >
                <div className="container-type-icon-wrapper standard">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    <line x1="12" y1="11" x2="12" y2="17"/>
                    <line x1="9" y1="14" x2="15" y2="14"/>
                  </svg>
                </div>
                <div className="container-type-info-v2">
                  <span className="container-type-name-v2">Standard</span>
                  <span className="container-type-desc-v2">
                    {t('standardContainerDesc', language)}
                  </span>
                </div>
              </button>
              <button
                className="container-type-selector-item-v2 storage"
                onClick={() => handleSelectType('storage')}
              >
                <div className="container-type-icon-wrapper storage">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    <path d="M9 13h6"/>
                    <path d="M9 17h6"/>
                  </svg>
                </div>
                <div className="container-type-info-v2">
                  <span className="container-type-name-v2">Storage</span>
                  <span className="container-type-desc-v2">
                    {t('storageContainerDesc', language)}
                  </span>
                </div>
              </button>
            </div>
            <div className="container-type-selector-footer">
              <button
                className="container-type-cancel-btn"
                onClick={() => {
                  setShowTypeSelector(false);
                  setPendingContainerPath(null);
                }}
              >
                {t('cancel', language)}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Settings Modal - Portal to body for correct positioning */}
      {showSettings && createPortal(
        <Settings onClose={() => setShowSettings(false)} />,
        document.body
      )}

      {/* New Container Modal - Portal to body for correct positioning */}
      {showNewContainer && createPortal(
        <div className="modal-overlay" onClick={cancelNew}>
          <div className="modal-shell new-container-modal" onClick={(e) => e.stopPropagation()}>
            <div className="new-container-modal-header">{t('newContainerTitle', language)}</div>
            <input
              ref={inputRef}
              className="new-container-modal-input"
              type="text"
              placeholder={t('containerNamePlaceholder', language)}
              value={newContainerName}
              onChange={(e) => setNewContainerName(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <div className="new-container-modal-actions">
              <button className="new-container-modal-btn cancel" onClick={cancelNew}>
                {t('cancel', language)}
              </button>
              <button
                className="new-container-modal-btn create"
                onClick={handleCreateContainer}
                disabled={!newContainerName.trim()}
              >
                {t('create', language)}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* New Subfolder Modal - Portal to body for correct positioning */}
      {showNewSubfolder && createPortal(
        <div className="modal-overlay" onClick={cancelNewSubfolder}>
          <div className="modal-shell new-container-modal" onClick={(e) => e.stopPropagation()}>
            <div className="new-container-modal-header">
              <FolderPlus size={16} style={{ marginRight: '8px' }} />
              {t('newFolder', language)}
            </div>
            <input
              ref={subfolderInputRef}
              className="new-container-modal-input"
              type="text"
              placeholder={t('folderNamePlaceholder', language)}
              value={newSubfolderName}
              onChange={(e) => setNewSubfolderName(e.target.value)}
              onKeyDown={handleSubfolderKeyDown}
            />
            <div className="new-container-modal-actions">
              <button className="new-container-modal-btn cancel" onClick={cancelNewSubfolder}>
                {t('cancel', language)}
              </button>
              <button
                className="new-container-modal-btn create"
                onClick={handleCreateSubfolder}
                disabled={!newSubfolderName.trim()}
              >
                {t('create', language)}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export default Sidebar;
