/**
 * MobileApp — Root component for mobile/tablet layout.
 * Calendar-first design: 캘린더가 홈 화면.
 * 5-tab navigation: 캘린더 | 노트 | 검색 | 그래프 | 설정
 * Uses same Zustand stores + Tauri commands as desktop.
 */
import { useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { TabBar, type TabId } from './TabBar';
import { NavBar } from './NavBar';
import { isTablet, isNativeMobile } from '../../core/utils/platform';
import { useTheme, useSettingsStore } from '../../core/stores/settingsStore';
import { useFileTreeStore } from '../../core/stores/fileTreeStore';
import { useResponsiveLayout } from '../../hooks/useResponsiveLayout';
import { useKeyboardLayout } from '../../hooks/useKeyboardLayout';
import { useEdgeSwipeBack } from '../../hooks/useEdgeSwipeBack';
import { injectThemeCSS } from '../../styles/theme';
import { ToastContainer } from './components/common';
import '../../design-system/mobile-tokens.css';
// Shared CSS needed for TipTap editor rendering (note-type colors, wikilinks, tables, etc.)
import '../../styles/base/note-type-colors.css';
import '../../styles/components/editor.css';
import '../../styles/components/editor-attachments.css';
import '../../styles/editor-extensions/tiptap-elements.css';
import '../../styles/editor-extensions/code-highlight.css';
import '../../styles/editor-extensions/heading-fold.css';
import '../../styles/editor-extensions/comment-marks.css';
import '../../styles/viewers/document-viewers.css';
// 5.0.9a — document-viewers-dark.css merged into document-viewers.css.
// Mobile-specific styles (loaded AFTER shared styles to allow overrides)
import '../../styles/features/mobile.css';

const MobileSidebar = lazy(() => import('./Sidebar'));
const CalendarHomeView = lazy(() => import('./views/CalendarHomeView'));
const ContainerListView = lazy(() => import('./views/ContainerListView'));
const NoteListView = lazy(() => import('./views/NoteListView'));
const NoteEditorView = lazy(() => import('./views/NoteEditorView'));
const SearchView = lazy(() => import('./views/SearchView'));
const SettingsView = lazy(() => import('./views/SettingsView'));

export interface MobileRoute {
  view: 'container-list' | 'note-list' | 'note-editor';
  title: string;
  containerPath?: string;
  notePath?: string;
}

const TAB_TITLES: Record<TabId, string> = {
  calendar: '캘린더',
  notes: '노트',
  search: '검색',
  settings: '설정',
};

export default function MobileApp() {
  const [activeTab, setActiveTab] = useState<TabId>('calendar');
  const [routeStack, setRouteStack] = useState<MobileRoute[]>([]);
  const tablet = isTablet();
  const theme = useTheme();
  const language = useSettingsStore(s => s.language);
  const vaultPath = useFileTreeStore(s => s.vaultPath);
  const navMode = useResponsiveLayout();
  const { keyboardVisible } = useKeyboardLayout();

  // Inject design token CSS variables
  useEffect(() => { injectThemeCSS(); }, []);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // System theme detection (if no vault-specific theme set)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      // Only auto-switch if user hasn't manually set theme
      if (!vaultPath) {
        document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
      }
    };
    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, [vaultPath]);

  const [tabHistory, setTabHistory] = useState<TabId[]>([]);

  const pushRoute = useCallback((route: MobileRoute) => {
    setRouteStack(prev => [...prev, route]);
  }, []);

  const popRoute = useCallback(() => {
    setRouteStack(prev => prev.slice(0, -1));
  }, []);

  // Edge swipe back navigation
  useEdgeSwipeBack({
    onBack: popRoute,
    disabled: routeStack.length === 0,
  });

  // Android hardware back button — always register (MobileApp only runs on mobile)
  useEffect(() => {
    let lastBackPress = 0;
    let unlisten: (() => void) | null = null;

    import('../../web/event').then(({ listen }) => {
      listen('tauri://back-button', () => {
        console.log('[back] routeStack:', routeStack.length, 'tabHistory:', tabHistory.length);
        if (routeStack.length > 0) {
          popRoute();
        } else if (tabHistory.length > 0) {
          const prevTab = tabHistory[tabHistory.length - 1];
          setTabHistory(prev => prev.slice(0, -1));
          setActiveTab(prevTab);
        } else {
          // Root level: show toast, double-tap to go home (not exit)
          const now = Date.now();
          if (now - lastBackPress < 2000) {
            // Move app to background (Android home)
            history.back(); // Standard browser back — moves WebView to background on Android
          } else {
            lastBackPress = now;
            const toast = document.createElement('div');
            toast.textContent = '한번 더 누르면 홈으로 이동합니다';
            toast.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#fff;padding:10px 20px;border-radius:20px;font-size:14px;z-index:9999;pointer-events:none;transition:opacity 0.3s;';
            document.body.appendChild(toast);
            setTimeout(() => { toast.style.opacity = '0'; }, 1500);
            setTimeout(() => toast.remove(), 2000);
          }
        }
      }).then(fn => { unlisten = fn; });
    }).catch(e => console.error('[back] Failed to register:', e));

    return () => { unlisten?.(); };
  }, [routeStack.length, popRoute, tabHistory]);

  const currentRoute = routeStack[routeStack.length - 1];
  const currentTitle = currentRoute?.title ?? TAB_TITLES[activeTab];

  const handleTabChange = useCallback((tab: TabId) => {
    setTabHistory(prev => [...prev.slice(-9), activeTab]); // Keep last 10
    setActiveTab(tab);
    setRouteStack([]);
  }, []);

  const handleOpenContainer = useCallback((containerPath: string, name: string) => {
    pushRoute({ view: 'note-list', title: name, containerPath });
  }, [pushRoute]);

  const handleOpenNote = useCallback((notePath: string, name: string) => {
    pushRoute({ view: 'note-editor', title: name, notePath });
  }, [pushRoute]);

  /** Navigate to a note from calendar/graph/search */
  const handleOpenNoteFromCalendar = useCallback((notePath: string, name: string) => {
    setActiveTab('notes');
    setRouteStack([{ view: 'note-editor', title: name, notePath }]);
  }, []);


  const renderNotesTab = () => {
    if (!currentRoute) {
      return <ContainerListView onOpenContainer={handleOpenContainer} onOpenNote={handleOpenNote} />;
    }
    if (currentRoute.view === 'note-list' && currentRoute.containerPath) {
      return (
        <NoteListView
          containerPath={currentRoute.containerPath}
          onOpenNote={handleOpenNote}
          onOpenContainer={handleOpenContainer}
        />
      );
    }
    if (currentRoute.view === 'note-editor' && currentRoute.notePath) {
      return <NoteEditorView notePath={currentRoute.notePath} onNavigateToNote={handleOpenNote} />;
    }
    return null;
  };

  // NavBar: only show when navigated into a sub-page (route stack not empty).
  // Tab home screens (calendar, notes root, search, settings) use their own large titles.
  const navTitle = currentRoute ? currentRoute.title : undefined;

  const showNavBar = navMode !== 'sidebar' && navTitle !== undefined;
  const showTabBar = navMode !== 'sidebar' && !keyboardVisible;
  const showSidebar = navMode === 'sidebar';

  return (
    <div
      className={`mobile-app ${tablet ? 'mobile-app--tablet' : ''}`}
      data-nav={navMode}
    >
      {showNavBar && (
        <NavBar
          title={navTitle!}
          canGoBack={routeStack.length > 0}
          onBack={popRoute}
          backLabel={routeStack.length > 1 ? routeStack[routeStack.length - 2].title : routeStack.length === 1 ? (activeTab === 'notes' ? '노트' : activeTab === 'calendar' ? '캘린더' : '') : undefined}
        />
      )}
      {/* MobileSyncBanner 제거 (2026-09-08): 데스크톱 sync_v2 잔재 —
          import 없는 훅(useSyncV2Events)을 불러 **모바일 전체가 부팅에서
          죽고 있었다** (ReferenceError · 실측). 웹은 서버가 진실 원천 + SSE 라
          동기화 배너 자체가 뜻이 없다. */}
      {showSidebar && (
        <Suspense fallback={null}>
          <MobileSidebar activeTab={activeTab} onChange={handleTabChange} language={language} />
        </Suspense>
      )}
      <main className="mobile-content">
        <Suspense fallback={<div className="mobile-loading">로딩 중...</div>}>
          {activeTab === 'calendar' && (
            <CalendarHomeView onOpenNote={handleOpenNoteFromCalendar} />
          )}
          {activeTab === 'notes' && renderNotesTab()}
          {activeTab === 'search' && (
            <SearchView
              onOpenNote={handleOpenNoteFromCalendar}
              onOpenContainer={handleOpenContainer}
            />
          )}
          {activeTab === 'settings' && <SettingsView />}
        </Suspense>
      </main>
      {showTabBar && (
        <TabBar activeTab={activeTab} onChange={handleTabChange} mode={navMode} language={language} />
      )}
      <ToastContainer />
    </div>
  );
}
