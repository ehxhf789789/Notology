import { startLive, onLive } from '../../web/liveSync';
import { DobbinPanel, useDobbinShortcut } from '../../features/dobbin/DobbinPanel';
import { Ingest } from '../../features/ingest/Ingest';
import { contentCacheActions } from '../../features/content-cache/stores/contentCacheStore';
import { fileTreeActions } from '../stores/fileTreeStore';
import { TrashPanel } from '../../features/attachments/components/TrashPanel';
import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { PanelRightOpen } from 'lucide-react';
import { AppInitializer } from '../stores/appStore';
import { ToastContainer } from '../../features/shared/Toast';
import { syncV2Commands } from '../../features/attachments/attachmentCommands';
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
  useHoverPanelAnimState,
  useSidebarWidth,
  useSidebarCollapsed,
  SIDEBAR_ICON_WIDTH,
  uiActions,
  useUIStore,
  useNoteTemplates,
} from '../stores/zustand';
import { useSearchIndexing } from '../stores/refreshStore';
import Sidebar from '../layout/Sidebar';
import ContainerView from '../../features/note-editor/ContainerView';
import Search from '../../features/search/Search';
import HoverEditorLayer from '../../features/hover-windows/HoverEditorLayer';
import RightPanel from '../layout/RightPanel';
import ContextMenu from '../../features/context-menu/ContextMenu';
import { Slot } from '../infrastructure/slotRegistry';
const MoveNoteModal = lazy(() => import('../../features/modals/MoveNoteModal'));
import TemplateSelector from '../../features/templates/TemplateSelector';
import TitleInputModal from '../../features/modals/TitleInputModal';
const NoteTemplateEditorModal = lazy(() => import('../../features/templates/NoteTemplateEditorModal'));
// v20 (2026-05-16, HanBin) — NoteCreationWizard removed; TitleInputModal now
// renders inline variable inputs ("이 창에서 진행되어야 한다"). Import
// dropped to avoid bundling dead code; old file stays on disk for now in
// case any rollback is needed.
import ConfirmDeleteModal from '../../features/modals/ConfirmDeleteModal';
import AlertModal from '../../features/modals/AlertModal';
const VaultLockModal = lazy(() => import('../../features/vault-config/VaultLockModal'));
import RenameDialog from '../../features/modals/RenameDialog';
import LoadingScreen from '../../features/shared/LoadingScreen';
import { CommandPalette } from '../../features/command-palette';
import { TemplateMigrationPromptModal } from '../../features/templates/TemplateMigrationPromptModal';
import { useDragDropListener } from '../hooks/useDragDrop';
import { initAttachmentStoreSubscriptions } from '../../features/attachments/stores/attachmentStore';
import { useAppKeyboardShortcuts } from '../hooks/useAppKeyboardShortcuts';
import { t } from '../utils/i18n';
import { initializeSnippets, loadSnippets, clearSnippets } from '../utils/snippetLoader';
import { detectGpuPerformance } from '../utils/gpuDetect';
import { flushAllEditorSaves } from '../editor/editorSaveRegistry';
import { getCurrentWindow } from '../../web/window';
import '../../styles/index.css';

const HOVER_PANEL_WIDTH = 280;

function AppLayout() {
  // Subscribe to `migration:progress` Tauri events → migrationStore.
  // Single mount-point in the app shell, runs for the entire app lifetime.
  // Stage 4.6.2: same pattern for faststart bulk migration progress.
  // v20 (2026-05-16, HanBin) — listen for template-change broadcasts so the
  // main window also stays in sync if a hover window mutates templates
  // (rare but possible: settings opened from a hover, future features).
  // Self-emits are filtered inside onTemplatesChanged, so the loopback is
  // a no-op and we don't trigger our own reload.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { onTemplatesChanged } = await import('../utils/windowSync');
        const { loadVaultConfig, clearVaultConfigCache } = await import('../utils/vaultConfigUtils');
        const { templateActions } = await import('../../features/templates/stores/templateStore');
        unlisten = await onTemplatesChanged((payload) => {
          clearVaultConfigCache();
          loadVaultConfig(payload.vaultPath)
            .then(cfg => templateActions.loadTemplates(payload.vaultPath, cfg))
            .catch(err => console.warn('[App] template-reload failed:', err));
        });
      } catch (err) {
        console.warn('[App] template sync subscribe failed:', err);
      }
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  // ========== ZUSTAND SELECTIVE SUBSCRIPTIONS (prevents cascade re-renders) ==========
  const vaultPath = useVaultPath();
  const selectedContainer = useSelectedContainer();
  const searchRefreshTrigger = useSearchRefreshTrigger();
  const searchReady = useSearchReady();
  const searchIndexing = useSearchIndexing();

  // UI state (individual Zustand subscriptions - only re-renders when specific value changes)
  const showSearch = useShowSearch();
  const showHoverPanel = useShowHoverPanel();
  const sidebarCollapsed = useSidebarCollapsed();
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
    import('../../web/event').then(({ listen }) => {
      listen('flush-saves', async () => {
        try {
          flushAllEditorSaves();
          // Also signal hover windows (they have their own editor pools).
          const { emit } = await import('../../web/event');
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
        const { emit } = await import('../../web/event');
        await emit('hover:flush-saves');
        // Brief wait for hover windows to process the flush
        await new Promise(r => setTimeout(r, 50));
      } catch {}
    });

    // Page refresh/navigation handler: flush all pending saves AND
    // close every hover window. The latter enforces the strict
    // hierarchy rule (H subordinate to M) even on dev-mode HMR / F5
    // refresh — without this, the hovers survive while main's React
    // state resets, leaving stale ghosts. Two layers of insurance:
    //   1. emit `main:reloading` — each hover listens (HoverWindowApp)
    //      and self-closes. Robust against openWindows cache going
    //      stale.
    //      frontend cache. Tauri queues the close IPCs immediately;
    //      they reach the runtime before the page actually unloads.
    const handleBeforeUnload = () => {
      flushAllEditorSaves();
      void (async () => {
        try {
          const { emit } = await import('../../web/event');
          await emit('main:reloading', null);
        } catch {}
      })();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      unlistenPromise.then(unlisten => unlisten());
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  // ========== GLOBAL NOTE TYPE CACHE REFRESH (runs once globally, not per hover window) ==========
  // Triggered by searchRefreshTrigger (incremented on actual file operations)
  // NOT by fileTree (which changes reference on every refreshFileTree call).
  //
  // 11th hotfix (2026-05-18, HanBin) — also depends on `noteTemplates`. The
  // `unmatchedTypes` Map is computed by comparing each note's frontmatter
  // type against the CURRENT registered-template set. Without this dep,
  // template add/edit/remove (Settings → Templates tab) didn't trigger
  // recomputation → badge kept showing stale "N개 정리 필요" using the OLD
  // template set as the registered list. invalidate() bypasses the 2-sec
  // debounce so the refresh fires immediately after template state change.
  const noteTemplates = useNoteTemplates();
  useEffect(() => {
    if (searchReady && !searchIndexing) {
      noteTypeCacheActions.invalidate();
      noteTypeCacheActions.refreshCache();
    }
  }, [searchRefreshTrigger, searchReady, searchIndexing, noteTemplates]);

  // 2026-05-24 (HanBin) — vault_repair auto-detect for first-time legacy
  // vault open. Runs 3s after vault is mounted so sync_engine bootstrap
  // can settle. Modal appears only when the scan finds auto-fixable
  // patterns AND this device hasn't shown the prompt for this vault yet.
  // 🔴 보관함 복구 자동감지를 걷어냈다 — 서버가 NAS를 직접 들어 어긋날 두 벌이 없다
  // 🔴 보관함 복구를 걷어냈다 — 서버가 NAS를 직접 들어 어긋날 두 벌이 없다

  // 2026-05-24 (HanBin) — re-open the repair modal when the TitleBar
  // indicator is clicked (user backgrounded the apply and wants to
  // monitor / cancel). Uses a custom event so we don't import App into
  // the indicator. The re-opened modal shows whatever liveProgress is
  // current — re-using the most recent report (or a fresh re-scan when
  // none exists).
  useEffect(() => {
    const handler = async () => {
      try {
        const r = await syncV2Commands.vaultRepairScan();
      } catch (err) {
        console.error('[App] re-open repair modal: scan failed', err);
      }
    };
    window.addEventListener('vault-repair:open-modal', handler);
    return () => window.removeEventListener('vault-repair:open-modal', handler);
  }, []);

  const sidebarWidth = useSidebarWidth();
  const isResizing = useRef(false);
  const sidebarWrapperRef = useRef<HTMLDivElement>(null);
  const resizeRafRef = useRef<number | null>(null);
  const resizePendingWidthRef = useRef<number | null>(null);

  useDragDropListener();

  // Track B Phase B-3: hydrate attachment index on vault open + invalidate
  // on attachment events. Wikilink chips depend on this for proper coloring,
  // and the Attachments tab reads from it instead of walking `_att/` folders.
  useEffect(() => {
    const unsubscribe = initAttachmentStoreSubscriptions();
    return unsubscribe;
  }, []);

  // R5 v4 — global sync indicator. Survives hover-window close/reopen.
  useEffect(() => {
    return () => {};   // 🔴 동기화 구독을 걷어낸 자리
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

  // Stage 5.0.3b-simplify follow-up (2026-05-15): drag-resize precision pass.
  // The previous loop felt laggy/imprecise because (1) the CSS `transition:
  // width 200ms` on `.sidebar-wrapper` was animating every mousemove update,
  // so the sidebar permanently chased the cursor with a 200ms ease curve,
  // (2) every move triggered a synchronous localStorage write, and (3) there
  // was no rAF coalescing nor offset compensation. Fix:
  //   • toggle a `.sidebar-wrapper--resizing` class to disable the transition
  //     during drag (re-enabled on mouseup so collapse animation still works)
  //   • coalesce mousemove → setSidebarWidth via requestAnimationFrame
  //   • compute width relative to wrapper's bounding rect (offset-safe)
  //   • skip localStorage during drag; persist once on mouseup
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    sidebarWrapperRef.current?.classList.add('sidebar-wrapper--resizing');
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const wrapper = sidebarWrapperRef.current;
      const left = wrapper ? wrapper.getBoundingClientRect().left : 0;
      resizePendingWidthRef.current = e.clientX - left;
      if (resizeRafRef.current == null) {
        resizeRafRef.current = requestAnimationFrame(() => {
          resizeRafRef.current = null;
          const next = resizePendingWidthRef.current;
          if (next != null) {
            uiActions.setSidebarWidth(next, false);
          }
        });
      }
    };

    const handleMouseUp = () => {
      if (!isResizing.current) return;
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      sidebarWrapperRef.current?.classList.remove('sidebar-wrapper--resizing');

      if (resizeRafRef.current != null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
      // Commit final width with localStorage persistence. If a pending rAF
      // tick was queued, use its width; otherwise re-persist the store's
      // current value so localStorage stays in sync with prior persist=false
      // updates from inside the drag loop.
      const pending = resizePendingWidthRef.current;
      resizePendingWidthRef.current = null;
      const finalWidth = pending != null ? pending : useUIStore.getState().sidebarWidth;
      uiActions.setSidebarWidth(finalWidth, true);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (resizeRafRef.current != null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
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
    import('../../web/event').then(({ listen }) => {
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
            onClick={() => import('../../web/window').then(m => m.getCurrentWindow().close())}
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
      {/* R5 v5 — permanent sync failure notification (hidden when empty). */}
      {/* Track H bulk-delete banner. Self-hides when count is 0. */}
      {/* Trash panel — opens via store flag (toast button / settings / etc.). */}
      <TrashPanel />
      <DobbinPanel />
      {/* 자료 투입 — 창 아무 데나 놓으면 받는다 (CLAUDE.md 1-2 ①) */}
      <Ingest />
      {/* 2026-05-24 (HanBin) — legacy vault repair prompt (one-shot per vault per device). */}
      {/* Re-opened repair modal when user clicks the TitleBar progress indicator. */}
      <div className="app-layout">
        {/* Left Sidebar. Stage 5.0.3b-simplify (2026-05-15): hidden-mode
            collapsed-bar removed — HanBin smoke test surfaced that two
            independent collapse axes (showSidebar = hidden, sidebarCollapsed
            = icon-only) were duplicative. Single state: sidebarCollapsed
            toggles between expanded (sidebarWidth) and icon-only
            (SIDEBAR_ICON_WIDTH). Width transition still animated via
            existing sidebar-wrapper animation class. */}
        <div
          ref={sidebarWrapperRef}
          className={`sidebar-wrapper open${sidebarCollapsed ? ' sidebar-wrapper--icon-only' : ''}`}
          style={{ width: sidebarCollapsed ? SIDEBAR_ICON_WIDTH : sidebarWidth }}
        >
          <Sidebar />
          {!sidebarCollapsed && <div className="divider" onMouseDown={startResize} />}
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
        <VaultLockModal />
        <NoteTemplateEditorModal />
      </Suspense>
      <TemplateSelector />
      <TitleInputModal />
      <ConfirmDeleteModal />
      <AlertModal />
      <RenameDialog />
      <CommandPalette />
      <TemplateMigrationPromptModal />
    </div>
  );
}

function App() {
  useDobbinShortcut();
  // 🔴 변화가 오면 화면을 따라가게 한다 — 이전 화면을 보며 편집하면 덮어쓴다
  useEffect(() => {
    startLive();
    return onLive((ev) => {
      // 🔴 **한 곳만 새로고침해서는 화면이 안 따라온다** (사용자 실측:
      //    *"여전히 과거 상태로 유지되고 있고 내가 수동으로 리프레시를 해야
      //    한다"*). `incrementSearchRefresh` 는 ContainerView 하나만 듣는다 —
      //    파일 트리·캐시·캘린더는 그대로였다. **바뀌면 다 흔든다.**
      if (ev.kind === 'file-changed' || ev.kind === 'vault-changed'
          || ev.kind === 'memos-changed' || ev.kind === 'inbox-changed') {
        refreshActions.incrementSearchRefresh();
        refreshActions.incrementCalendarRefresh?.();
        refreshActions.incrementOntologyRefresh?.();
        // 캐시를 비운다 — 안 비우면 새로 읽어도 옛 내용을 준다
        contentCacheActions.invalidateAll();
        // 파일 트리는 스스로 다시 읽어야 폴더 개수가 맞는다
        fileTreeActions.refreshFileTree();
      }
    });
  }, []);   // Ctrl+K — 어디서든 dobbin을 부른다
  return (
    <AppInitializer>
      <AppLayout />
    </AppInitializer>
  );
}

export default App;
