import { useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import { AppInitializer } from '../stores/appStore';
import { ToastContainer } from '../../features/shared/Toast';
import { NasDeletionsBanner } from '../../features/sync_v2/components/NasDeletionsBanner';
import { TrashPanel } from '../../features/sync_v2/components/TrashPanel';
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
  useSidebarCollapsed,
  SIDEBAR_ICON_WIDTH,
  uiActions,
} from '../stores/zustand';
import { useSearchIndexing } from '../stores/refreshStore';
import TitleBar from '../layout/TitleBar';
import Sidebar from '../layout/Sidebar';
import ContainerView from '../../features/note-editor/ContainerView';
import Search from '../../features/search/Search';
import HoverEditorLayer from '../../features/hover-windows/HoverEditorLayer';
import MigrationModal from '../../features/migration/components/MigrationModal';
import { useMigrationProgress } from '../../features/migration/hooks/useMigrationProgress';
import FaststartMigrationModal from '../../features/faststart-migration/components/FaststartMigrationModal';
import { useFaststartMigrationProgress } from '../../features/faststart-migration/hooks/useFaststartMigrationProgress';
import RightPanel from '../layout/RightPanel';
import ContextMenu from '../../features/context-menu/ContextMenu';
import { Slot } from '../infrastructure/slotRegistry';
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
import { ConnectionVaultSelector } from '../../features/connection/components/ConnectionVaultSelector';
import UpdateChecker from '../../features/shared/UpdateChecker';
import LoadingScreen from '../../features/shared/LoadingScreen';
import { CommandPalette } from '../../features/command-palette';
import { useDragDropListener } from '../hooks/useDragDrop';
import { initAttachmentStoreSubscriptions } from '../../features/sync_v2/stores/attachmentStore';
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
  // Subscribe to `migration:progress` Tauri events → migrationStore.
  // Single mount-point in the app shell, runs for the entire app lifetime.
  useMigrationProgress();
  // Stage 4.6.2: same pattern for faststart bulk migration progress.
  useFaststartMigrationProgress();

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
  const sidebarCollapsed = useSidebarCollapsed();
  const sidebarAnimState = useSidebarAnimState();
  const hoverPanelAnimState = useHoverPanelAnimState();

  // Modal state
  const showVaultSelectorModal = useShowVaultSelectorModal();

  const language = useLanguage();

  // ========== OPEN VAULT SELECTOR ON DEMAND (from Sidebar etc.) ==========
  // Stage A: dispatch through the backend WindowDispatcher so the strict
  // B-policy ordering (flush → close hovers → hide main → show selector)
  // is authoritative and atomic. See state.rs / docs/window_lifecycle_cases.md.
  useEffect(() => {
    if (!showVaultSelectorModal) return;
    let cancelled = false;
    (async () => {
      try {
        const { dispatchWindowEvent } = await import('../../features/window-lifecycle/windowLifecycle');
        if (cancelled) return;
        await dispatchWindowEvent({ type: 'switch_vault_requested' });
      } catch (e) {
        console.warn('[App] dispatch switch_vault_requested failed:', e);
      } finally {
        modalActions.setShowVaultSelectorModal(false);
      }
    })();
    return () => { cancelled = true; };
  }, [showVaultSelectorModal]);

  // ========== FLUSH-SAVES LISTENER ==========
  // The dispatcher emits 'flush-saves' before any window hide/close so
  // dirty editor content gets persisted. We respond by calling the same
  // flush mechanism the existing onCloseRequested handler uses.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('flush-saves', async () => {
        try {
          flushAllEditorSaves();
          // Also signal hover windows (they have their own editor pools).
          const { emit } = await import('@tauri-apps/api/event');
          await emit('hover:flush-saves');
        } catch (e) {
          console.warn('[App] flush-saves handler failed:', e);
        }
      }).then(fn => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []);

  // ========== SAVE & CLOSE HOVER WINDOWS ON MAIN WINDOW CLOSE / REFRESH ==========
  useEffect(() => {
    // Tauri close handler: save all dirty editors, then close hover windows
    const mainWindow = getCurrentWindow();
    const unlistenPromise = mainWindow.onCloseRequested(async () => {
      flushAllEditorSaves();
      // Persist current theme to global store so VaultSelector opens with correct theme
      try {
        const { getGlobalStore } = await import('../stores/persistenceUtils');
        const { useSettingsStore } = await import('../stores/settingsStore');
        const globalStore = await getGlobalStore();
        await globalStore.set('last_theme', useSettingsStore.getState().theme);
      } catch {}
      // Signal hover windows to flush saves before closing them
      try {
        const { emit } = await import('@tauri-apps/api/event');
        await emit('hover:flush-saves');
        // Brief wait for hover windows to process the flush
        await new Promise(r => setTimeout(r, 50));
      } catch {}
      await closeAllHoverWindows();
    });

    // Page refresh/navigation handler: flush all pending saves AND
    // close every hover window. The latter enforces the strict
    // hierarchy rule (H subordinate to M) even on dev-mode HMR / F5
    // refresh — without this, the hovers survive while main's React
    // state resets, leaving stale ghosts. Two layers of insurance:
    //   1. emit `main:reloading` — each hover listens (HoverWindowApp)
    //      and self-closes. Robust against openWindows cache going
    //      stale.
    //   2. fire-and-forget closeAllHoverWindows — closes via the
    //      frontend cache. Tauri queues the close IPCs immediately;
    //      they reach the runtime before the page actually unloads.
    const handleBeforeUnload = () => {
      flushAllEditorSaves();
      void (async () => {
        try {
          const { emit } = await import('@tauri-apps/api/event');
          await emit('main:reloading', null);
        } catch {}
      })();
      void closeAllHoverWindows();
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

  // Track B Phase B-3: hydrate attachment index on vault open + invalidate
  // on attachment events. Wikilink chips depend on this for proper coloring,
  // and the Attachments tab reads from it instead of walking `_att/` folders.
  useEffect(() => {
    const unsubscribe = initAttachmentStoreSubscriptions();
    return unsubscribe;
  }, []);

  // Black-screen guard (HanBin 2026-05-13): the WebView2-embedded PDF
  // viewer has an overflow-menu item that navigates to `chrome://settings`
  // / `edge://...`. The top-frame can't load those URLs and the whole
  // Notology webview goes blank. We can't sandbox the PDF iframe (it
  // breaks PDF rendering — the viewer is itself served from
  // `chrome-extension://`), so we intercept the navigation at the window
  // level: any beforeunload triggered by a chrome:// / edge:// nav is
  // cancelled before the webview commits to it.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Read the pending location if possible. document.activeElement
      // sometimes still references the iframe at this point, and
      // `location.href` at the moment of beforeunload is the
      // destination, not the current page. We can sniff for the
      // chrome:// / edge:// / about: prefixes that the PDF viewer
      // attempts to navigate to.
      const next = window.location.href;
      if (/^(chrome|edge|about):/i.test(next)) {
        e.preventDefault();
        e.returnValue = '';
        console.warn('[NavGuard] blocked navigation to', next);
        return '';
      }
      return undefined;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

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

  // No vault selected — show inline vault selector in main window.
  // initializeApp() will show the main window when no saved vault is found.
  if (!vaultPath) {
    return (
      <div className="app-container" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        {/* Custom titlebar for decorations:false window — drag + close */}
        <div
          style={{
            height: 36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '0 4px',
            // @ts-ignore — WebKit-specific CSS property
            WebkitAppRegion: 'drag',
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => import('@tauri-apps/api/window').then(m => m.getCurrentWindow().close())}
            style={{
              // @ts-ignore
              WebkitAppRegion: 'no-drag',
              background: 'none',
              border: 'none',
              color: 'var(--tx-2)',
              fontSize: 18,
              cursor: 'pointer',
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 6,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ConnectionVaultSelector onVaultSelected={(localPath, vaultName) => {
            import('../stores/appActions').then(m => m.openVault(localPath));
            import('@tauri-apps/api/event').then(({ emit }) => {
              emit('vault-selected', { localPath, vaultName });
            });
          }} />
        </div>
      </div>
    );
  }

  // (Render-body side effect removed — was firing async hide+open in the
  // render path which is racy; moved to a useEffect below.)

  // Search index initializes in background — app is usable immediately
  // searchReady=false only means search/graph results may be stale temporarily

  return (
    <div className="app-container">
      <ToastContainer />
      <TitleBar />
      {/* Track H bulk-delete banner. Self-hides when count is 0. */}
      <NasDeletionsBanner />
      {/* Trash panel — opens via store flag (toast button / settings / etc.). */}
      <TrashPanel />
      <div className="app-layout">
        {/* Left Sidebar with slide animation.
            Stage 5.0.3b: when sidebarCollapsed is true, width locks to
            SIDEBAR_ICON_WIDTH and the divider/resize hides — only the
            collapse toggle in the footer expands it back. */}
        <div className={`sidebar-wrapper ${showSidebar ? 'open' : 'closed'} ${sidebarAnimState}${sidebarCollapsed ? ' sidebar-wrapper--icon-only' : ''}`} style={{ width: showSidebar || sidebarAnimState === 'closing' ? (sidebarCollapsed ? SIDEBAR_ICON_WIDTH : sidebarWidth) : undefined }}>
          {showSidebar || sidebarAnimState === 'closing' ? (
            <>
              <Sidebar />
              {!sidebarCollapsed && <div className="divider" onMouseDown={startResize} />}
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
          <Slot name="editor-banner" />
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
        {/* Right Panel with slide animation. Stage 5.0.3a-rework
            (2026-05-15) restored the collapsed-bar with toggle button
            — see report 5_0_3_a_rework.md §4. Width adjusts between
            collapsed (~48px strip) and open (HOVER_PANEL_WIDTH). */}
        <div
          className={`hover-panel-wrapper ${showHoverPanel ? 'open' : 'closed'} ${hoverPanelAnimState}`}
          style={{
            width: showHoverPanel || hoverPanelAnimState === 'closing'
              ? HOVER_PANEL_WIDTH
              : undefined,
          }}
        >
          {showHoverPanel || hoverPanelAnimState === 'closing' ? (
            <RightPanel width={HOVER_PANEL_WIDTH} />
          ) : (
            <div className="hover-panel-collapsed-bar">
              <button
                className="hover-panel-collapsed-toggle"
                onClick={() => uiActions.setShowHoverPanel(true)}
                title={t('rightPanelToggle', language)}
                aria-label={t('rightPanelToggle', language)}
              >
                <PanelRightOpen size={18} />
              </button>
            </div>
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
      <MigrationModal />
      <FaststartMigrationModal />
      <CommandPalette />
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
