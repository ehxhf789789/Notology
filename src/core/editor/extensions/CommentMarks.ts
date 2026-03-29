import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { NoteComment } from '../../types';

export interface CommentMarksOptions {
  onCommentClick?: (commentId: string) => void;
}

export const CommentMarks = Extension.create<CommentMarksOptions>({
  name: 'commentMarks',

  addOptions() {
    return {
      onCommentClick: undefined,
    };
  },

  addStorage() {
    return {
      comments: [] as NoteComment[],
    };
  },

  addProseMirrorPlugins() {
    const { onCommentClick } = this.options;
    const extensionStorage = (this.editor.storage as unknown as { commentMarks: { comments: NoteComment[] } }).commentMarks;

    return [
      new Plugin({
        key: new PluginKey('commentMarks'),
        props: {
          decorations(state) {
            const comments: NoteComment[] = extensionStorage.comments || [];
            if (comments.length === 0) {
              return DecorationSet.empty;
            }

            const decorations: Decoration[] = [];
            const docSize = state.doc.content.size;

            for (const comment of comments) {
              if (comment.resolved) continue;
              const { from, to } = comment.position;
              if (from >= 0 && to <= docSize && from < to) {
                decorations.push(
                  Decoration.inline(from, to, {
                    class: 'comment-highlight',
                    'data-comment-id': comment.id,
                  })
                );
              }
            }

            return DecorationSet.create(state.doc, decorations);
          },
          handleClick(_view, _pos, event) {
            const target = event.target as HTMLElement;
            const commentEl = target.closest('[data-comment-id]');
            if (commentEl && onCommentClick) {
              const commentId = commentEl.getAttribute('data-comment-id');
              if (commentId) {
                onCommentClick(commentId);
                return true;
              }
            }
            return false;
          },
        },
      }),
    ];
  },
});

export default CommentMarks;
