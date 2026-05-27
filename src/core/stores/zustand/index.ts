// Zustand stores for optimized state management
// These stores replace React Context for better performance through selective subscriptions

export {
  useHoverStore,
  useHoverWindow,
  useActiveHoverWindows,
  useMinimizedHoverWindows,
  useHoverWindowCount,
  useSnapPreview,
  useClosingWindowIds,
  useMinimizingWindowIds,
  useIsClosing,
  useIsMinimizing,
  hoverActions,
  HOVER_ANIMATION,
} from '../../../features/hover-windows/stores/hoverStore';

export {
  useFileTreeStore,
  useFileTree,
  useSelectedContainer,
  useVaultPath,
  fileTreeActions,
  subscribeToFileTree,
} from '../fileTreeStore';

export {
  useRefreshStore,
  useSearchRefreshTrigger,
  useCalendarRefreshTrigger,
  useOntologyRefreshTrigger,
  useSearchReady,
  useSearchIndexing,
  refreshActions,
} from '../refreshStore';

export {
  useNoteTypeCacheStore,
  useNoteTypeCache,
  useNoteTypeCacheLoading,
  noteTypeCacheActions,
} from '../../../features/content-cache/stores/noteTypeCacheStore';

export {
  useContentCacheStore,
  useCachedContent,
  contentCacheActions,
} from '../../../features/content-cache/stores/contentCacheStore';

export {
  useModalStore,
  useTemplateSelectorState,
  useTitleInputModalState,
  useConfirmDeleteState,
  useAlertModalState,
  useRenameDialogState,
  useContextMenuState,
  useMoveNoteModalPath,
  useShowVaultSelectorModal,
  useVaultLockModalState,
  modalActions,
  type TitleInputResult,
} from '../../../features/modals/stores/modalStore';

export {
  useSettingsStore,
  useTheme,
  useFont,
  useLanguage,
  useDevMode,
  useAutoSaveDelay,
  useToolbarDefaultCollapsed,
  useGraphSettings,
  settingsActions,
  type ThemeSetting,
  type FontSetting,
  type LanguageSetting,
  type CustomFont,
} from '../settingsStore';

export {
  useTemplateStore,
  useNoteTemplates,
  useEnabledTemplateIds,
  useFolderTemplates,
  useDefaultTemplateType,
  useCustomShortcuts,
  templateActions,
} from '../../../features/templates/stores/templateStore';

export {
  useUIStore,
  useShowSearch,
  useShowCalendar,
  useShowHoverPanel,
  useShowSidebar,
  useSidebarAnimState,
  useHoverPanelAnimState,
  useSidebarWidth,
  useSidebarCollapsed,
  uiActions,
  SIDEBAR_ICON_WIDTH,
} from '../uiStore';

export {
  useVaultConfigStore,
  useContainerConfigs,
  useFolderStatuses,
  useRecentVaults,
  useIsNasSynced,
  useNasPlatform,
  useIsBulkSyncing,
  vaultConfigActions,
  type RecentVault,
} from '../../../features/vault-config/stores/vaultConfigStore';
