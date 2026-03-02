import { useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { AppInitializer } from './stores/appStore';
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
} from './stores/zustand';
import { useSearchIndexing } from './stores/zustand/refreshStore';
import TitleBar from './components/layout/TitleBar';
import Sidebar from './components/layout/Sidebar';
import ContainerView from './components/layout/ContainerView';
import Search from './components/Search';
import HoverEditorLayer from './components/hover/HoverEditorLayer';
import RightPanel from './components/layout/RightPanel';
import CollapsedHoverBar from './components/layout/CollapsedHoverBar';
import ContextMenu from './components/ContextMenu';
const MoveNoteModal = lazy(() => import('./components/modals/MoveNoteModal'));
import TemplateSelector from './components/modals/TemplateSelector';
const ContactInputModal = lazy(() => import('./components/modals/ContactInputModal'));
import TitleInputModal from './components/modals/TitleInputModal';
const MeetingInputModal = lazy(() => import('./components/modals/MeetingInputModal'));
const PaperInputModal = lazy(() => import('./components/modals/PaperInputModal'));
const LiteratureInputModal = lazy(() => import('./components/modals/LiteratureInputModal'));
const EventInputModal = lazy(() => import('./components/modals/EventInputModal'));
import ConfirmDeleteModal from './components/modals/ConfirmDeleteModal';
import AlertModal from './components/modals/AlertModal';
const VaultLockModal = lazy(() => import('./components/modals/VaultLockModal'));
import RenameDialog from './components/modals/RenameDialog';
import VaultSelector from './components/modals/VaultSelector';
import UpdateChecker from './components/shared/UpdateChecker';
import LoadingScreen from './components/shared/LoadingScreen';
import { useDragDropListener } from './hooks/useDragDrop';
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts';
import { t } from './utils/i18n';
import { initializeSnippets, loadSnippets, clearSnippets } from './utils/snippetLoader';
import { detectGpuPerformance } from './utils/gpuDetect';
import { closeAllHoverWindows } from './utils/multiWindow';
import { flushAllEditorSaves } from './utils/editorSaveRegistry';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './styles/index.css';

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

  // Show vault selector if no vault is open
  if (!vaultPath) {
    return <VaultSelector />;
  }

  // Show vault selector overlay when manually triggered (while vault is open)
  if (showVaultSelectorModal) {
    return (
      <>
        <VaultSelector
          showCloseButton={true}
          onClose={() => modalActions.setShowVaultSelectorModal(false)}
        />
      </>
    );
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
