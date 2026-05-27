import { memo, useCallback, startTransition } from 'react';
import { X, Maximize2, Minimize2, PanelRightClose, Image, FileText, BookOpen, Globe, FileCode } from 'lucide-react';
import {
  useActiveHoverWindows,
  useMinimizedHoverWindows,
  useHoverWindowCount,
  useHoverStore,
  hoverActions,
} from './stores/hoverStore';
import { useTemplateStore } from '../templates/stores/templateStore';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { useUIStore } from '../../core/stores/uiStore';
import type { HoverWindow } from '../../core/types';
import { t } from '../../core/utils/i18n';
import { getNoteTypeFromFileName, getTemplateCustomColor } from '../content-cache/noteTypeHelpers';
import { EmptyState } from '../../design-system/components';

interface HoverWindowsPanelProps {
  width: number;
}

// File type icon component
function FileTypeIcon({ type }: { type: HoverWindow['type'] }) {
  switch (type) {
    case 'pdf': return <BookOpen size={14} />;
    case 'image': return <Image size={14} />;
    case 'code': return <FileCode size={14} />;
    case 'web': return <Globe size={14} />;
    default: return <FileText size={14} />;
  }
}

const HoverWindowsPanel = memo(function HoverWindowsPanel({ width }: HoverWindowsPanelProps) {
  // OPTIMIZATION: Use selective zustand subscriptions instead of full useAppStore()
  // This prevents re-renders when unrelated state changes
  const activeWindows = useActiveHoverWindows();
  const minimizedWindows = useMinimizedHoverWindows();
  const hoverCount = useHoverWindowCount();

  // Get values from individual Zustand stores
  const noteTemplates = useTemplateStore((s) => s.noteTemplates);
  const language = useSettingsStore((s) => s.language);
  const setShowHoverPanel = useUIStore((s) => s.setShowHoverPanel);

  // Use stable action references from hoverActions (never cause re-renders)
  const minimizeHoverFile = hoverActions.minimize;
  const closeHoverFile = hoverActions.close;
  const restoreHoverFile = hoverActions.restore;

  // Get custom color from template by note type
  const getColor = useCallback((noteType: string | null): string | undefined => {
    return getTemplateCustomColor(noteType, noteTemplates);
  }, [noteTemplates]);

  // Find the focused window (highest zIndex among non-minimized windows)
  const focusedWindow = activeWindows.length > 0
    ? activeWindows.reduce((max, win) => win.zIndex > max.zIndex ? win : max, activeWindows[0])
    : null;

  // Handle window click - Windows taskbar behavior:
  // minimized → restore+focus, active but not focused → focus, active and focused → minimize
  const handleWindowClick = useCallback((windowId: string) => {
    const state = useHoverStore.getState();
    const win = state.hoverFiles.find(h => h.id === windowId);
    if (!win) return;

    // Determine if this is the focused window (highest zIndex among non-minimized)
    const activeWins = state.hoverFiles.filter(w => !w.minimized && !w.cached);
    const topWindow = activeWins.length > 0
      ? activeWins.reduce((max, w) => w.zIndex > max.zIndex ? w : max, activeWins[0])
      : null;
    const isTopFocused = topWindow?.id === win.id;

    if (win.minimized) {
      restoreHoverFile(windowId);
    } else if (isTopFocused) {
      minimizeHoverFile(windowId);
    } else {
      hoverActions.focus(windowId);
    }
  }, [minimizeHoverFile, restoreHoverFile]);

  return (
    <div className="hover-windows-panel" style={{ width }}>
      <div className="hover-windows-panel-header">
        <div className="hover-windows-panel-header-left">
          <span className="hover-windows-panel-title">{t('hoverWindows', language)}</span>
          <span className="hover-windows-panel-count">{hoverCount}</span>
        </div>
        <button
          className="hover-windows-panel-close"
          onClick={() => setShowHoverPanel(false)}
          title={t('close', language)}
        >
          <PanelRightClose size={18} />
        </button>
      </div>

      <div className="hover-windows-panel-content">
        {/* Active Windows Section */}
        {activeWindows.length > 0 && (
          <div className="hover-windows-section">
            <div className="hover-windows-section-header">
              <span className="hover-windows-section-title">{t('activeWindows', language)}</span>
              <span className="hover-windows-section-count">{activeWindows.length}</span>
            </div>
            <div className="hover-windows-list">
              {activeWindows.map(win => {
                const fileName = win.filePath.split(/[/\\]/).pop()?.replace(/\.md$/, '') || 'Untitled';
                const noteType = win.type === 'editor' ? (win.noteType || getNoteTypeFromFileName(fileName)) : null;
                const typeClass = noteType ? `${noteType}-type` : '';
                const iconClass = noteType ? `icon-${noteType}` : '';
                const isFocused = focusedWindow?.id === win.id;
                const stateClass = isFocused ? 'focused' : 'active';
                const customColor = getColor(noteType);

                return (
                  <div
                    key={win.id}
                    className={`hover-window-item ${stateClass} ${typeClass}${customColor ? ' has-custom-color' : ''}`}
                    style={customColor ? { '--template-color': customColor } as React.CSSProperties : undefined}
                  >
                    <button
                      className="hover-window-item-btn"
                      onClick={() => startTransition(() => handleWindowClick(win.id))}
                      title={`${fileName} (${isFocused ? t('focused', language) : t('active', language)})`}
                    >
                      {win.type === 'editor' && noteType ? (
                        <span
                          className={`hover-window-item-icon template-selector-icon ${iconClass}`}
                          style={customColor ? { backgroundColor: customColor } : undefined}
                        />
                      ) : (
                        <span className="hover-window-item-icon lucide-icon">
                          <FileTypeIcon type={win.type} />
                        </span>
                      )}
                      <span className="hover-window-item-name">{fileName}</span>
                    </button>
                    <div className="hover-window-item-actions">
                      <button
                        className="hover-window-item-action"
                        onClick={() => startTransition(() => minimizeHoverFile(win.id))}
                        title={t('minimize', language)}
                      >
                        <Minimize2 size={12} />
                      </button>
                      <button
                        className="hover-window-item-action hover-window-item-close"
                        onClick={() => startTransition(() => closeHoverFile(win.id))}
                        title={t('close', language)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Minimized Windows Section */}
        {minimizedWindows.length > 0 && (
          <div className="hover-windows-section">
            <div className="hover-windows-section-header">
              <span className="hover-windows-section-title">{t('minimizedWindows', language)}</span>
              <span className="hover-windows-section-count">{minimizedWindows.length}</span>
            </div>
            <div className="hover-windows-list">
              {minimizedWindows.map(win => {
                const fileName = win.filePath.split(/[/\\]/).pop()?.replace(/\.md$/, '') || 'Untitled';
                const noteType = win.type === 'editor' ? (win.noteType || getNoteTypeFromFileName(fileName)) : null;
                const typeClass = noteType ? `${noteType}-type` : '';
                const iconClass = noteType ? `icon-${noteType}` : '';
                const customColor = getColor(noteType);

                return (
                  <div
                    key={win.id}
                    className={`hover-window-item minimized ${typeClass}${customColor ? ' has-custom-color' : ''}`}
                    style={customColor ? { '--template-color': customColor } as React.CSSProperties : undefined}
                  >
                    <button
                      className="hover-window-item-btn"
                      onClick={() => startTransition(() => handleWindowClick(win.id))}
                      title={`${fileName} (${t('minimize', language)})`}
                    >
                      {win.type === 'editor' && noteType ? (
                        <span
                          className={`hover-window-item-icon template-selector-icon ${iconClass}`}
                          style={customColor ? { backgroundColor: customColor } : undefined}
                        />
                      ) : (
                        <span className="hover-window-item-icon lucide-icon">
                          <FileTypeIcon type={win.type} />
                        </span>
                      )}
                      <span className="hover-window-item-name">{fileName}</span>
                    </button>
                    <div className="hover-window-item-actions">
                      <button
                        className="hover-window-item-action"
                        onClick={() => startTransition(() => restoreHoverFile(win.id))}
                        title={t('restore', language)}
                      >
                        <Maximize2 size={12} />
                      </button>
                      <button
                        className="hover-window-item-action hover-window-item-close"
                        onClick={() => startTransition(() => closeHoverFile(win.id))}
                        title={t('close', language)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state */}
        {hoverCount === 0 && (
          <EmptyState
            icon={<FileText size={24} strokeWidth={1.5} />}
            title={t('noOpenWindows', language)}
          />
        )}
      </div>
    </div>
  );
});

export default HoverWindowsPanel;
