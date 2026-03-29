import { useState, useEffect, useRef } from 'react';
import { useModalStore } from './stores/modalStore';
import { renameFile } from '../../core/stores/appActions';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t, tf } from '../../core/utils/i18n';

function RenameDialog() {
  const renameDialogState = useModalStore(s => s.renameDialogState);
  const hideRenameDialog = useModalStore(s => s.hideRenameDialog);
  const language = useSettingsStore(s => s.language);
  const [newName, setNewName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Track where mousedown started to prevent drag-select from closing the dialog
  const overlayMouseDownRef = useRef(false);

  useEffect(() => {
    if (renameDialogState?.visible) {
      // Set initial name:
      // - Folders: show as-is (no extension)
      // - Notes (.md files): strip .md extension for display
      // - Attachments: show with extension
      // Display underscores as spaces for readability (converted back on save)
      const name = renameDialogState.currentName;
      if (renameDialogState.isFolder) {
        setNewName(name.replace(/_/g, ' '));
      } else if (renameDialogState.isAttachment) {
        // Strip extension for display - extension is preserved on rename
        setNewName(name.replace(/\.[^.]+$/, '').replace(/_/g, ' '));
      } else {
        // Note: strip .md extension for display
        setNewName(name.replace(/\.md$/, '').replace(/_/g, ' '));
      }
      setTimeout(() => inputRef.current?.select(), 50);
    }
  }, [renameDialogState]);

  if (!renameDialogState || !renameDialogState.visible) return null;

  const handleRename = async () => {
    if (!newName.trim()) return;
    try {
      const fsName = newName.trim();
      let finalName: string;
      if (renameDialogState.isFolder) {
        // For folders, use the name as-is (no extension)
        finalName = fsName;
      } else if (renameDialogState.isAttachment) {
        // For attachments, preserve the original extension
        const originalName = renameDialogState.currentName;
        const originalExt = originalName.includes('.') ? originalName.substring(originalName.lastIndexOf('.')) : '';

        // Check if user provided the extension
        if (originalExt && !fsName.endsWith(originalExt)) {
          // User didn't include extension or changed it - force the original extension
          const inputBaseName = fsName.includes('.') ? fsName.substring(0, fsName.lastIndexOf('.')) : fsName;
          finalName = `${inputBaseName}${originalExt}`;
        } else {
          finalName = fsName;
        }
      } else {
        // For notes, add .md extension
        finalName = `${fsName}.md`;
      }
      await renameFile(renameDialogState.path, finalName);
      hideRenameDialog();
    } catch (e) {
      console.error('Failed to rename:', e);
      alert(tf('renameFailed', language, { error: String(e) }));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRename();
    } else if (e.key === 'Escape') {
      hideRenameDialog();
    }
  };

  return (
    <div
      className="rename-dialog-overlay"
      onMouseDown={(e) => { overlayMouseDownRef.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => {
        // Only close if BOTH mousedown and mouseup happened on the overlay itself
        // This prevents closing when dragging text selection outside the dialog
        if (overlayMouseDownRef.current && e.target === e.currentTarget) {
          hideRenameDialog();
        }
        overlayMouseDownRef.current = false;
      }}
    >
      <div className="rename-dialog" onMouseDown={e => e.stopPropagation()}>
        <div className="rename-dialog-title">{t('renameTitle', language)}</div>
        <input
          ref={inputRef}
          className="rename-dialog-input"
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <div className="rename-dialog-actions">
          <button className="rename-dialog-btn cancel" onClick={hideRenameDialog}>{t('cancel', language)}</button>
          <button className="rename-dialog-btn confirm" onClick={handleRename}>{t('change', language)}</button>
        </div>
      </div>
    </div>
  );
}

export default RenameDialog;
