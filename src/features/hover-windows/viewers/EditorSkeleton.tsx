import { memo } from 'react';

/**
 * Skeleton loading state for editor content
 * Shows placeholder lines while content is loading
 */
export const EditorSkeleton = memo(function EditorSkeleton() {
  return (
    <div className="hover-editor-skeleton">
      <div className="skeleton-line skeleton-title" />
      <div className="skeleton-line skeleton-full" />
      <div className="skeleton-line skeleton-full" />
      <div className="skeleton-line skeleton-short" />
      <div className="skeleton-line skeleton-full" />
      <div className="skeleton-line skeleton-medium" />
    </div>
  );
});
