// Read-only TipTap preview of a branch's content.

import { useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { syncV2Commands } from '../syncV2Commands';

interface BranchPreviewProps {
  noteId: string;
  branchId: string;
}

export function BranchPreview({ noteId, branchId }: BranchPreviewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContent(null);
    setError(null);
    syncV2Commands.getBranchContent(noteId, branchId)
      .then(setContent)
      .catch(e => setError(String(e)));
  }, [noteId, branchId]);

  const editor = useEditor({
    extensions: [StarterKit],
    content: content || '',
    editable: false,
  }, [content]);

  if (error) {
    return <div className="sync-v2-preview-error">{error}</div>;
  }

  if (content === null) {
    return <div className="sync-v2-preview-loading">Loading...</div>;
  }

  return (
    <div className="sync-v2-preview">
      <EditorContent editor={editor} />
    </div>
  );
}
