import { useState, useCallback, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { fileCommands } from '../../core/services/tauriCommands';
import { refreshActions } from '../../core/stores/refreshStore';
import type { NoteFrontmatter, NoteComment, SketchData, SketchSelection } from '../../core/types';
import type { FacetedTags } from '../../core/types/frontmatter';
import { getCurrentTimestamp } from '../../core/utils/frontmatter';
import { getFlatTags } from '../../core/utils/frontmatterUtils';
import { saveComments } from './comments';
import { notifyMemoChanged } from '../../core/utils/windowSync';

/**
 * Hook that manages note comments: CRUD operations, optimistic patching,
 * tag panel saved callback, and memo/task context menu actions.
 */
export interface UseNoteCommentHandlersParams {
  winFilePath: string;
  frontmatterRef: React.MutableRefObject<NoteFrontmatter | null>;
  bodyRef: React.MutableRefObject<string>;
  commentsRef: React.MutableRefObject<NoteComment[]>;
  commentsMtimeRef: React.MutableRefObject<number>;
  mtimeOnLoadRef: React.MutableRefObject<number>;
  editor: Editor | null;
}

export function useNoteCommentHandlers({
  winFilePath,
  frontmatterRef,
  bodyRef,
  commentsRef,
  commentsMtimeRef,
  mtimeOnLoadRef,
  editor,
}: UseNoteCommentHandlersParams) {
  const [comments, setComments] = useState<NoteComment[]>([]);
  const [showComments, setShowComments] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [preservedSelection, setPreservedSelection] = useState<{ text: string; range: { from: number; to: number } } | null>(null);
  const [pendingTaskMode, setPendingTaskMode] = useState(false);

  // Helper: optimistic patch for comment changes (instant Search UI update)
  const patchNoteForComments = useCallback((commentCount: number) => {
    const fm = frontmatterRef.current;
    if (!fm || !winFilePath) return;
    refreshActions.patchNote({
      path: winFilePath,
      title: fm.title || winFilePath.split(/[\\/]/).pop()?.replace(/\.md$/, '') || '',
      note_type: fm.type || '',
      tags: fm.tags || [],
      created: fm.created || '',
      modified: getCurrentTimestamp(),
      has_body: bodyRef.current.length > 0,
      comment_count: commentCount,
    });
  }, [winFilePath, frontmatterRef, bodyRef]);

  // Helper: after saveComments (which calls touchNoteModified), refresh the .md mtime
  const refreshMtimeAfterCommentSave = useCallback(() => {
    if (!winFilePath) return;
    setTimeout(() => {
      fileCommands.getFileMtime(winFilePath).then(mtime => {
        mtimeOnLoadRef.current = mtime;
      }).catch(() => {});
    }, 200);
  }, [winFilePath, mtimeOnLoadRef]);

  const handleAddComment = useCallback(async (comment: NoteComment) => {
    const updated = [...comments, comment];
    setComments(updated);
    patchNoteForComments(updated.length);
    const result = await saveComments(winFilePath, updated, commentsMtimeRef.current);
    commentsMtimeRef.current = result.mtime;
    if (result.comments !== updated) setComments(result.comments);
    refreshActions.batchRefresh({ calendar: true });
    notifyMemoChanged(winFilePath).catch(() => {});
    refreshMtimeAfterCommentSave();
    setPreservedSelection(null);
    setPendingTaskMode(false);
  }, [comments, winFilePath, patchNoteForComments, refreshMtimeAfterCommentSave, commentsMtimeRef]);

  const handleDeleteComment = useCallback(async (commentId: string) => {
    const updated = comments.filter(c => c.id !== commentId);
    setComments(updated);
    patchNoteForComments(updated.length);
    const result = await saveComments(winFilePath, updated, commentsMtimeRef.current);
    commentsMtimeRef.current = result.mtime;
    if (result.comments !== updated) setComments(result.comments);
    refreshActions.batchRefresh({ calendar: true });
    notifyMemoChanged(winFilePath).catch(() => {});
    refreshMtimeAfterCommentSave();
    if (activeCommentId === commentId) setActiveCommentId(null);
  }, [comments, winFilePath, activeCommentId, patchNoteForComments, refreshMtimeAfterCommentSave, commentsMtimeRef]);

  const handleResolveComment = useCallback(async (commentId: string) => {
    const updated = comments.map(c => c.id === commentId ? { ...c, resolved: !c.resolved } : c);
    setComments(updated);
    patchNoteForComments(updated.length);
    const result = await saveComments(winFilePath, updated, commentsMtimeRef.current);
    commentsMtimeRef.current = result.mtime;
    if (result.comments !== updated) setComments(result.comments);
    refreshActions.batchRefresh({ calendar: true });
    notifyMemoChanged(winFilePath).catch(() => {});
    refreshMtimeAfterCommentSave();
  }, [comments, winFilePath, patchNoteForComments, refreshMtimeAfterCommentSave, commentsMtimeRef]);

  const handleUpdateComment = useCallback(async (commentId: string, updatedComment: NoteComment) => {
    const updated = comments.map(c => c.id === commentId ? updatedComment : c);
    setComments(updated);
    patchNoteForComments(updated.length);
    const result = await saveComments(winFilePath, updated, commentsMtimeRef.current);
    commentsMtimeRef.current = result.mtime;
    if (result.comments !== updated) setComments(result.comments);
    refreshActions.batchRefresh({ calendar: true });
    notifyMemoChanged(winFilePath).catch(() => {});
    refreshMtimeAfterCommentSave();
  }, [comments, winFilePath, patchNoteForComments, refreshMtimeAfterCommentSave, commentsMtimeRef]);

  // Optimistic patch when tags are saved via TagPanel
  const handleTagPanelSaved = useCallback((newTags: FacetedTags) => {
    const fm = frontmatterRef.current;
    if (!fm || !winFilePath) return;

    refreshActions.patchNote({
      path: winFilePath,
      title: fm.title || winFilePath.split(/[\\/]/).pop()?.replace(/\.md$/, '') || '',
      note_type: fm.type || '',
      tags: getFlatTags(newTags),
      created: fm.created || '',
      modified: getCurrentTimestamp(),
      has_body: bodyRef.current.length > 0,
      comment_count: commentsRef.current.length,
    });

    fileCommands.getFileMtime(winFilePath).then(mtime => {
      mtimeOnLoadRef.current = mtime;
    }).catch(() => {});
  }, [winFilePath, frontmatterRef, bodyRef, commentsRef, mtimeOnLoadRef]);

  // Toggle comment panel
  const handleToggleComments = useCallback(() => {
    if (showComments) {
      setPreservedSelection(null);
      setPendingTaskMode(false);
    }
    setShowComments(!showComments);
  }, [showComments]);

  // Add memo from context menu
  const handleAddMemoFromMenu = useCallback(() => {
    if (!editor || editor.state.selection.empty) return;
    const selectedText = editor.state.doc.textBetween(
      editor.state.selection.from, editor.state.selection.to, ' '
    );
    setPreservedSelection({
      text: selectedText,
      range: { from: editor.state.selection.from, to: editor.state.selection.to },
    });
    setPendingTaskMode(false);
    setShowComments(true);
  }, [editor]);

  // Add task from context menu
  const handleAddTaskFromMenu = useCallback(() => {
    if (!editor || editor.state.selection.empty) return;
    const selectedText = editor.state.doc.textBetween(
      editor.state.selection.from, editor.state.selection.to, ' '
    );
    setPreservedSelection({
      text: selectedText,
      range: { from: editor.state.selection.from, to: editor.state.selection.to },
    });
    setPendingTaskMode(true);
    setShowComments(true);
  }, [editor]);

  return {
    comments,
    setComments,
    showComments,
    setShowComments,
    showTags,
    setShowTags,
    activeCommentId,
    setActiveCommentId,
    preservedSelection,
    setPreservedSelection,
    pendingTaskMode,
    setPendingTaskMode,
    handleAddComment,
    handleDeleteComment,
    handleResolveComment,
    handleUpdateComment,
    handleTagPanelSaved,
    handleToggleComments,
    handleAddMemoFromMenu,
    handleAddTaskFromMenu,
  };
}
