import { useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { AppInitializer } from '../stores/appStore';
import {
  useVaultPath,
  useSelectedContainer,
  useSearchRefreshTrigger,
  useSearchReady,
  refreshActions,
  noteTypeCacheActions,
  useShowVaultSelectorModal,
  modalActions,
  useLanguage,
  useShowSearch,
  useShowHoverPanel,
  useShowSidebar,
  useSidebarAnimState,
  useHoverPanelAnimState,
  useSidebarWidth,
  uiActions,
} from '../stores/zustand';
import { useSearchIndexing } from '../stores/refreshStore';
import TitleBar from '../layout/TitleBar';
import Sidebar from '../layout/Sidebar';
import ContainerView from '../../features/note-editor/ContainerView';
import Search from '../../features/search/Search';
import HoverEditorLayer from '../../features/hover-windows/HoverEditorLayer';
import RightPanel from '../layout/RightPanel';
import CollapsedHoverBar from '../../features/hover-windows/CollapsedHoverBar';
import ContextMenu from '../../features/context-menu/ContextMenu';
const MoveNoteModal = lazy(() => import('../../features/modals/MoveNoteModal'));
import TemplateSelector from '../../features/templates/TemplateSelector';
const ContactInputModal = lazy(() => import('../../features/modals/ContactInputModal'));
import TitleInputModal from '../../features/modals/TitleInputModal';
const MeetingInputModal = lazy(() => import('../../features/modals/MeetingInputModal'));
const PaperInputModal = lazy(() => import('../../features/modals/PaperInputModal'));
const LiteratureInputModal = lazy(() => import('../../features/modals/LiteratureInputModal'));
const EventInputModal = lazy(() => import('../../features/modals/EventInputModal'));
import ConfirmDeleteModal from '../../features/modals/ConfirmDeleteModal';
import AlertModal from '../../features/modals/AlertModal';
const VaultLockModal = lazy(() => import('../../features/vault-config/VaultLockModal'));
import RenameDialog from '../../features/modals/RenameDialog';
import VaultSelector from '../../features/vault-config/VaultSelector';
import UpdateChecker from '../../features/shared/UpdateChecker';
import LoadingScreen from '../../features/shared/LoadingScreen';
import { useDragDropListener } from '../hooks/useDragDrop';
import { useAppKeyboardShortcuts } from '../hooks/useAppKeyboardShortcuts';
import { t } from '../utils/i18n';
import { initializeSnippets, loadSnippets, clearSnippets } from '../utils/snippetLoader';
import { detectGpuPerformance } from '../utils/gpuDetect';
import { closeAllHoverWindows } from '../utils/multiWindow';
import { flushAllEditorSaves } from '../editor/editorSaveRegistry';
import { getCurrentWindow } from '@tauri-apps/api/window';
import '../../styles/index.css';

const HOVER_PANEL_WIDTH = 280;

function AppLayout() {
  // ========== ZUSTAND SELECTIVE SUBSCRIPTIONS (prevents cascade re-renders) ==========
  const vaultPath = useVaultPath();
  const selectedContainer = useSelectedContainer();
  const searchRefreshTrigger = useSearchRefreshTrigger();
  const searchReady = useSearchReady();
  const searchIndexing = useSearchIndexing();

  // UI state (individual Zustand subscriptions - only re-renders when specific value changes)
  const showSearch = useShowSearch();
  const showHoverPanel = useShowHoverPanel();
  const showSidebar = useShowSidebar();
  const sidebarAnimState = useSidebarAnimState();
  const hoverPanelAnimState = useHoverPanelAnimState();

  // Modal state
  const showVaultSelectorModal = useShowVaultSelectorModal();

  const language = useLanguage();

  // ========== SAVE & CLOSE HOVER WINDOWS ON MAIN WINDOW CLOSE / REFRESH ==========
  useEffect(() => {
    // Tauri close handler: save all dirty editors, then close hover windows
    const mainWindow = getCurrentWindow();
    const unlistenPromise = mainWindow.onCloseRequested(async () => {
      flushAllEditorSaves();
      await closeAllHoverWindows();
    });

    // Page refresh/navigation handler: flush all pending saves before unload
    const handleBeforeUnload = () => {
      flushAllEditorSaves();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      unlistenPromise.then(unlisten => unlisten());
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  // ========== GLOBAL NOTE TYPE CACHE REFRESH (runs once globally, not per hover window) ==========
  // Triggered by searchRefreshTrigger (incremented on actual file operations)
  // NOT by fileTree (which changes reference on every refreshFileTree call)
  useEffect(() => {
    if (searchReady && !searchIndexing) {
      noteTypeCacheActions.refreshCache();
    }
  }, [searchRefreshTrigger, searchReady, searchIndexing]);

  const sidebarWidth = useSidebarWidth();
  const isResizing = useRef(false);

  useDragDropListener();

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      uiActions.setSidebarWidth(e.clientX);
    };

    const handleMouseUp = () => {
      if (!isResizing.current) return;
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Auto-detect GPU rendering performance (runs once on first launch)
  useEffect(() => {
    detectGpuPerformance();
  }, []);

  // Close vault selector when vault changes
  useEffect(() => {
    if (vaultPath) {
      modalActions.setShowVaultSelectorModal(false);
    }
  }, [vaultPath]);

  // Load custom CSS snippets from .notology/snippets when vault opens
  useEffect(() => {
    if (vaultPath) {
      // Initialize snippets directory and load custom CSS
      initializeSnippets(vaultPath).then(() => {
        loadSnippets(vaultPath);
      });
    } else {
      // Clear snippets when vault closes
      clearSnippets();
    }
  }, [vaultPath]);

  // Global keyboard shortcuts (extracted to custom hook)
  useAppKeyboardShortcuts();

  // Listen for vault selection from the VaultSelector window
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ localPath: string; vaultName: string }>('vault-selected', (e) => {
        import('../stores/appActions').then(m => m.openVault(e.payload.localPath));
      }).then(fn => { unlisten = fn; });
    });
    return () => unlisten?.();
  }, []);

  // Main window is hidden until vault is selected (via Rust setup).
  // If vaultPath is null, try reopening VaultSelector (handles HMR recovery)
  if (!vaultPath) {
    // Auto-reopen vault selector if main window is visible (HMR recovery)
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().isVisible().then(visible => {
        if (visible) {
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('sync_open_vault_selector').catch(() => {});
          });
        }
      });
    }).catch(() => {});
    return <LoadingScreen isLoading={true} />;
  }

  // Open vault selector window when manually triggered (e.g. from sidebar)
  if (showVaultSelectorModal) {
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('sync_open_vault_selector').catch(console.warn);
    });
    modalActions.setShowVaultSelectorModal(false);
  }

  // Guard: keep VaultSelector import for type compatibility
  if (false as boolean) {
    return <VaultSelector />;
  }

  // Show loading screen while initializing vault and search index
  if (!searchReady) {
    return <LoadingScreen isLoading={true} />;
  }

  return (
    <div className="app-container">
      <TitleBar />
      <div className="app-layout">
        {/* Left Sidebar with slide animation */}
        <div className={`sidebar-wrapper ${showSidebar ? 'open' : 'closed'} ${sidebarAnimState}`} style={{ width: showSidebar || sidebarAnimState === 'closing' ? sidebarWidth : undefined }}>
          {showSidebar || sidebarAnimState === 'closing' ? (
            <>
              <Sidebar />
              <div className="divider" onMouseDown={startResize} />
            </>
          ) : (
            <div className="sidebar-collapsed-bar">
              <button
                className="sidebar-collapsed-toggle"
                onClick={() => uiActions.setShowSidebar(true)}
                title={t('sidebarToggle', language)}
              >
                <PanelLeftOpen size={18} />
              </button>
            </div>
          )}
        </div>
        <div className="editor-area">
          {showSearch ? (
            <Search refreshTrigger={searchRefreshTrigger} />
          ) : selectedContainer ? (
            <ContainerView />
          ) : (
            <div className="editor-empty-area">
              <p className="editor-empty-text">{t('editorEmptyText', language)}</p>
            </div>
          )}
        </div>
        {/* Right Panel with slide animation */}
        <div className={`hover-panel-wrapper ${showHoverPanel ? 'open' : 'closed'} ${hoverPanelAnimState}`} style={{ width: showHoverPanel || hoverPanelAnimState === 'closing' ? HOVER_PANEL_WIDTH : undefined }}>
          {showHoverPanel || hoverPanelAnimState === 'closing' ? (
            <RightPanel width={HOVER_PANEL_WIDTH} />
          ) : (
            <CollapsedHoverBar />
          )}
        </div>
      </div>
      <HoverEditorLayer />
      <ContextMenu />
      <Suspense fallback={null}>
        <MoveNoteModal />
        <ContactInputModal />
        <MeetingInputModal />
        <PaperInputModal />
        <LiteratureInputModal />
        <EventInputModal />
        <VaultLockModal />
      </Suspense>
      <TemplateSelector />
      <TitleInputModal />
      <ConfirmDeleteModal />
      <AlertModal />
      <RenameDialog />
      <UpdateChecker />
    </div>
  );
}

function App() {
  return (
    <AppInitializer>
      <AppLayout />
    </AppInitializer>
  );
}

export default App;
