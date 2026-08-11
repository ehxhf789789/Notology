import { DobbinButton } from '../../features/dobbin/DobbinPanel';
import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Search, Plus, Settings as SettingsIcon, FolderClosed, ChevronDown, FolderPlus, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Slot } from '../infrastructure/slotRegistry';
import {
  useVaultPath,
  useFileTree,
  useSelectedContainer,
} from '../stores/zustand';
import { useShowSearch, useSidebarCollapsed, useUIStore, uiActions } from '../stores/uiStore';
import { IconButton, Tooltip } from '../../design-system/components';
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
  const sidebarCollapsed = useSidebarCollapsed();
  const containerConfigs = useContainerConfigs();
  const language = useSettingsStore(s => s.language);

  // Get vault name from path
  const vaultName = vaultPath ? vaultPath.split(/[/\\]/).filter(Boolean).pop() : '';
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
        {/* 🔴 dobbin은 사이드바 하단에 상주한다. 사용자 요구:
              "사용자가 편리하게 AI를 쉽게 대화하고 호출하고 지시할 수 있도록"
              — 화면을 옮겨 다니게 하면 "쉽게"가 아니다. Ctrl+K로도 열린다. */}
        <div className="sidebar-dobbin"><DobbinButton /></div>
        <div className="sidebar-footer">
          {!sidebarCollapsed && (
            <>
              <button
                className="sidebar-footer-btn vault-btn"
                onClick={() => modalActions.setShowVaultSelectorModal(true)}
                title={t('openVault', language)}
              >
                <FolderClosed size={14} strokeWidth={2} />
                <span className="sidebar-footer-btn-text">{vaultName || t('openVault', language)}</span>
              </button>
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
