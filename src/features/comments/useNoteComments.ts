import { useState, useCallback, useRef } from 'react';
import { refreshActions } from '../../core/stores/refreshStore';
import { saveComments, loadComments } from './comments';
import { notifyMemoChanged } from '../../core/utils/windowSync';
import type { NoteComment } from '../../core/types';

interface UseNoteCommentsOptions {
  filePath: string;
  onRefreshCalendar?: () => void;
}

interface UseNoteCommentsReturn {
  comments: NoteComment[];
  setComments: React.Dispatch<React.SetStateAction<NoteComment[]>>;
  commentsMtimeRef: React.MutableRefObject<number>;
  handleAddComment: (comment: NoteComment) => Promise<void>;
  handleDeleteComment: (commentId: string) => Promise<void>;
  handleResolveComment: (commentId: string) => Promise<void>;
  handleUpdateComment: (commentId: string, updatedComment: NoteComment) => Promise<void>;
  loadInitialComments: () => Promise<void>;
}

/**
 * Custom hook for managing note comments
 * Extracts comment CRUD operations from HoverEditor for better code organization
 */
export function useNoteComments({
  filePath,
  onRefreshCalendar,
}: UseNoteCommentsOptions): UseNoteCommentsReturn {
  const [comments, setComments] = useState<NoteComment[]>([]);
  const commentsMtimeRef = useRef<number>(0);

  const handleAddComment = useCallback(async (comment: NoteComment) => {
    const updated = [...comments, comment];
    setComments(updated);
    const result = await saveComments(filePath, updated, commentsMtimeRef.current);
    commentsMtimeRef.current = result.mtime;
    if (result.comments !== updated) setComments(result.comments);
    refreshActions.batchRefresh({ search: true, calendar: true });
    onRefreshCalendar?.();
    notifyMemoChanged(filePath).catch(() => {});
  }, [comments, filePath, onRefreshCalendar]);

  const handleDeleteComment = useCallback(async (commentId: string) => {
    const updated = comments.filter(c => c.id !== commentId);
    setComments(updated);
    const result = await saveComments(filePath, updated, commentsMtimeRef.current);
    commentsMtimeRef.current = result.mtime;
    if (result.comments !== updated) setComments(result.comments);
    refreshActions.batchRefresh({ search: true, calendar: true });
    onRefreshCalendar?.();
    notifyMemoChanged(filePath).catch(() => {});
  }, [comments, filePath, onRefreshCalendar]);

  const handleResolveComment = useCallback(async (commentId: string) => {
    const updated = comments.map(c => c.id === commentId ? { ...c, resolved: !c.resolved } : c);
    setComments(updated);
    const result = await saveComments(filePath, updated, commentsMtimeRef.current);
    commentsMtimeRef.current = result.mtime;
    if (result.comments !== updated) setComments(result.comments);
    refreshActions.batchRefresh({ search: true, calendar: true });
    onRefreshCalendar?.();
    notifyMemoChanged(filePath).catch(() => {});
  }, [comments, filePath, onRefreshCalendar]);

  const handleUpdateComment = useCallback(async (commentId: string, updatedComment: NoteComment) => {
    const updated = comments.map(c => c.id === commentId ? updatedComment : c);
    setComments(updated);
    const result = await saveComments(filePath, updated, commentsMtimeRef.current);
    commentsMtimeRef.current = result.mtime;
    if (result.comments !== updated) setComments(result.comments);
    refreshActions.batchRefresh({ search: true, calendar: true });
    onRefreshCalendar?.();
    notifyMemoChanged(filePath).catch(() => {});
  }, [comments, filePath, onRefreshCalendar]);

  const loadInitialComments = useCallback(async () => {
    if (!filePath) return;
    const { comments: loaded, mtime } = await loadComments(filePath);
    setComments(loaded);
    commentsMtimeRef.current = mtime;
  }, [filePath]);

  return {
    comments,
    setComments,
    commentsMtimeRef,
    handleAddComment,
    handleDeleteComment,
    handleResolveComment,
    handleUpdateComment,
    loadInitialComments,
  };
}
