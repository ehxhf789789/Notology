import { forwardRef, type HTMLAttributes } from 'react';
import { FolderOpen } from 'lucide-react';
import { IconButton } from './IconButton';

export interface PathDisplayProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The filesystem path to display. Shown verbatim in a monospace block. */
  path: string;
  /** When set, an "open folder" affordance is rendered to the right. */
  onReveal?: (path: string) => void;
  /** aria-label for the reveal button. Required when onReveal is passed. */
  revealLabel?: string;
}

/**
 * PathDisplay — minimal primitive for showing a filesystem path with an
 * optional "Reveal in Explorer/Finder" action. Monospace, hover-tooltip
 * (native `title`) for the full path, middle-truncate via CSS for long
 * paths.
 *
 * Stage 5.0.8d (2026-05-17, HanBin). Footprint kept narrow per plan
 * delta — `path` + `onReveal` are the only props. Future variants
 * (truncate strategy, copy button, multi-action) gated by 3+ concrete
 * consumer sites.
 *
 * Initial consumers:
 *   • FaststartMigrationModal done view (backup_dir block)
 *   • Future TrashPanel per-entry path (5.0.8 followup)
 *   • Future NasFolderBrowser pick-mode footer (replaces inline `<code>`)
 */
export const PathDisplay = forwardRef<HTMLDivElement, PathDisplayProps>(function PathDisplay(
  { path, onReveal, revealLabel, className, ...rest },
  ref,
) {
  const cls = ['ds-path-display', className ?? ''].filter(Boolean).join(' ');
  return (
    <div ref={ref} className={cls} {...rest}>
      <code className="ds-path-display__path" title={path}>{path}</code>
      {onReveal && (
        <IconButton
          icon={<FolderOpen size={14} />}
          aria-label={revealLabel ?? 'Open folder'}
          title={revealLabel ?? 'Open folder'}
          size="sm"
          variant="ghost"
          onClick={() => onReveal(path)}
        />
      )}
    </div>
  );
});
