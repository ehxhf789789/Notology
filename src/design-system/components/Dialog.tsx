import { useId, type ReactNode } from 'react';
import {
  useFloating,
  useDismiss,
  useRole,
  useClick,
  useInteractions,
  FloatingPortal,
  FloatingFocusManager,
  FloatingOverlay,
  useTransitionStyles,
} from '@floating-ui/react';
import { IconButton } from './IconButton';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  /** Footer content (typically Cancel + Confirm buttons). */
  footer?: ReactNode;
  size?: DialogSize;
  children: ReactNode;
  /** Disable backdrop click + ESC dismissal. */
  forcedAction?: boolean;
  /** Hide the close X button. Implies forcedAction usually. */
  hideCloseButton?: boolean;
  /** Initial focus target — see Floating-UI initialFocus prop. */
  initialFocus?: number | React.RefObject<HTMLElement>;
  className?: string;
  /** Add aria-label when no visible title is used. */
  ariaLabel?: string;
  /** Localized aria-label for the close X button. Defaults to "Close" so
   *  primitives stay decoupled from i18n; consumers thread `t('dsClose')`. */
  closeAriaLabel?: string;
}

/** Close-X glyph as inline SVG to avoid a lucide-react dep cycle here. */
function CloseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  size = 'md',
  children,
  forcedAction,
  hideCloseButton,
  initialFocus,
  className,
  ariaLabel,
  closeAriaLabel,
}: DialogProps) {
  const headingId = useId();
  const descId = useId();

  const { refs, context } = useFloating({
    open,
    onOpenChange: (next) => { if (!next) onClose(); },
  });

  const click = useClick(context);
  const dismiss = useDismiss(context, {
    outsidePress: !forcedAction,
    escapeKey: !forcedAction,
  });
  const role = useRole(context, { role: 'dialog' });

  const { getFloatingProps } = useInteractions([click, dismiss, role]);

  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: { open: 180, close: 120 },
    initial: { opacity: 0, transform: 'scale(0.97) translateY(8px)' },
  });

  const overlayCls = ['ds-dialog__overlay', open ? 'ds-dialog__overlay--open' : ''].filter(Boolean).join(' ');
  const cls = [
    'ds-dialog',
    `ds-dialog--${size}`,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  if (!isMounted) return null;

  return (
    <FloatingPortal>
      <FloatingOverlay className={overlayCls} lockScroll>
        <FloatingFocusManager context={context} initialFocus={initialFocus}>
          <div
            ref={refs.setFloating}
            className={cls}
            style={transitionStyles}
            aria-labelledby={title ? headingId : undefined}
            aria-label={!title ? ariaLabel : undefined}
            aria-describedby={description ? descId : undefined}
            {...getFloatingProps()}
          >
            {(title || !hideCloseButton) && (
              <header className="ds-dialog__header">
                {title && <h2 id={headingId} className="ds-dialog__title">{title}</h2>}
                {!hideCloseButton && (
                  <IconButton
                    icon={<CloseGlyph />}
                    aria-label={closeAriaLabel ?? 'Close'}
                    variant="ghost"
                    size="sm"
                    onClick={onClose}
                    className="ds-dialog__close"
                  />
                )}
              </header>
            )}
            {description && (
              <p id={descId} className="ds-dialog__desc">{description}</p>
            )}
            <div className="ds-dialog__body">{children}</div>
            {footer && <footer className="ds-dialog__footer">{footer}</footer>}
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  );
}
