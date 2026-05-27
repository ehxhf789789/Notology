/**
 * MobileMetadataSheet — BottomSheet showing tags, tasks, and memos for a note.
 * Accessed via icon buttons in the note editor header.
 */
import { useState, useEffect, useCallback } from 'react';
import { Tag, CheckSquare, MessageSquare, Square, CheckSquare2 } from 'lucide-react';
import { BottomSheet } from '../BottomSheet';
import { loadComments, saveComments } from '../../comments/comments';
import { parseFrontmatter } from '../../../core/utils/frontmatter';
import type { NoteComment } from '../../../core/types';

interface Props {
  open: boolean;
  onClose: () => void;
  notePath: string;
  frontmatterYaml: string | null;
}

type TabId = 'tags' | 'tasks' | 'memos';

export function MobileMetadataSheet({ open, onClose, notePath, frontmatterYaml }: Props) {
  const [tab, setTab] = useState<TabId>('tags');
  const [comments, setComments] = useState<NoteComment[]>([]);
  const [mtime, setMtime] = useState(0);
  const [tags, setTags] = useState<string[]>([]);

  // Parse tags from frontmatter
  useEffect(() => {
    if (!frontmatterYaml) {
      setTags([]);
      return;
    }
    try {
      const fm = parseFrontmatter(frontmatterYaml);
      const t = fm.tags;
      if (Array.isArray(t)) setTags(t.map(String));
      else if (typeof t === 'string') setTags([t]);
      else setTags([]);
    } catch {
      setTags([]);
    }
  }, [frontmatterYaml]);

  // Load comments/memos
  useEffect(() => {
    if (!open || !notePath) return;
    loadComments(notePath).then(result => {
      setComments(result.comments);
      setMtime(result.mtime);
    });
  }, [open, notePath]);

  const tasks = comments.filter(c => c.task);
  const memos = comments.filter(c => !c.task);

  const handleToggleResolved = useCallback(async (commentId: string) => {
    const updated = comments.map(c =>
      c.id === commentId ? { ...c, resolved: !c.resolved } : c
    );
    setComments(updated);
    const result = await saveComments(notePath, updated, mtime);
    setComments(result.comments);
    setMtime(result.mtime);
  }, [comments, notePath, mtime]);

  return (
    <BottomSheet open={open} onClose={onClose} title="메타데이터">
      {/* Tab bar */}
      <div className="mobile-meta-tabs">
        <button className={`mobile-meta-tab ${tab === 'tags' ? 'active' : ''}`} onClick={() => setTab('tags')}>
          <Tag size={14} />
          <span>태그</span>
          {tags.length > 0 && <span className="mobile-meta-tab-badge">{tags.length}</span>}
        </button>
        <button className={`mobile-meta-tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>
          <CheckSquare size={14} />
          <span>할일</span>
          {tasks.length > 0 && <span className="mobile-meta-tab-badge">{tasks.filter(t => !t.resolved).length}</span>}
        </button>
        <button className={`mobile-meta-tab ${tab === 'memos' ? 'active' : ''}`} onClick={() => setTab('memos')}>
          <MessageSquare size={14} />
          <span>메모</span>
          {memos.length > 0 && <span className="mobile-meta-tab-badge">{memos.length}</span>}
        </button>
      </div>

      {/* Content */}
      <div className="mobile-meta-content">
        {tab === 'tags' && (
          <div className="mobile-meta-tags">
            {tags.length === 0 ? (
              <div className="mobile-meta-empty">태그 없음</div>
            ) : (
              <div className="mobile-meta-tag-list">
                {tags.map((tag, i) => (
                  <span key={i} className="mobile-meta-tag-chip">{tag}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'tasks' && (
          <div className="mobile-meta-items">
            {tasks.length === 0 ? (
              <div className="mobile-meta-empty">할일 없음</div>
            ) : tasks.map(task => (
              <div key={task.id} className={`mobile-meta-item ${task.resolved ? 'resolved' : ''}`}>
                <button className="mobile-meta-checkbox" onClick={() => handleToggleResolved(task.id)}>
                  {task.resolved ? <CheckSquare2 size={18} /> : <Square size={18} />}
                </button>
                <div className="mobile-meta-item-content">
                  <div className="mobile-meta-item-text">{task.task?.summary || task.content}</div>
                  {task.task?.dueDate && (
                    <div className="mobile-meta-item-due">{task.task.dueDate}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'memos' && (
          <div className="mobile-meta-items">
            {memos.length === 0 ? (
              <div className="mobile-meta-empty">메모 없음</div>
            ) : memos.map(memo => (
              <div key={memo.id} className={`mobile-meta-item ${memo.resolved ? 'resolved' : ''}`}>
                <div className="mobile-meta-item-content">
                  <div className="mobile-meta-item-text">{memo.content}</div>
                  {memo.anchorText && (
                    <div className="mobile-meta-item-anchor">"{memo.anchorText}"</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
