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
} from './hoverStore';

export {
  useFileTreeStore,
  useFileTree,
  useSelectedContainer,
  useVaultPath,
  fileTreeActions,
  subscribeToFileTree,
} from './fileTreeStore';

export {
  useRefreshStore,
  useSearchRefreshTrigger,
  useCalendarRefreshTrigger,
  useOntologyRefreshTrigger,
  useSearchReady,
  useSearchIndexing,
  refreshActions,
} from './refreshStore';

export {
  useNoteTypeCacheStore,
  useNoteTypeCache,
  useNoteTypeCacheLoading,
  noteTypeCacheActions,
} from './noteTypeCacheStore';

export {
  useContentCacheStore,
  useCachedContent,
  contentCacheActions,
} from './contentCacheStore';

export {
  useModalStore,
  useTemplateSelectorState,
  useContactInputModalState,
  useTitleInputModalState,
  useMeetingInputModalState,
  usePaperInputModalState,
  useLiteratureInputModalState,
  useEventInputModalState,
  useConfirmDeleteState,
  useAlertModalState,
  useRenameDialogState,
  useContextMenuState,
  useMoveNoteModalPath,
  useShowVaultSelectorModal,
  useVaultLockModalState,
  modalActions,
  type TitleInputResult,
} from './modalStore';

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
} from './settingsStore';

export {
  useTemplateStore,
  useNoteTemplates,
  useEnabledTemplateIds,
  useFolderTemplates,
  useDefaultTemplateType,
  useCustomShortcuts,
  templateActions,
} from './templateStore';

export {
  useUIStore,
  useShowSearch,
  useShowCalendar,
  useShowHoverPanel,
  useShowSidebar,
  useSidebarAnimState,
  useHoverPanelAnimState,
  useSidebarWidth,
  uiActions,
} from './uiStore';

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
} from './vaultConfigStore';
