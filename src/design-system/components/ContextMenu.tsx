import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import {
  useFloating,
  useDismiss,
  useRole,
  useListNavigation,
  useInteractions,
  flip,
  shift,
  FloatingPortal,
  FloatingFocusManager,
  FloatingList,
  useListItem,
  useTransitionStyles,
  useMergeRefs,
} from '@floating-ui/react';
import { KeyboardHint } from './KeyboardHint';

interface ContextMenuItemCtx {
  getItemProps: (
    userProps?: HTMLAttributes<HTMLElement>,
  ) => Record<string, unknown>;
  activeIndex: number | null;
  setOpen: (open: boolean) => void;
}

const Ctx = createContext<ContextMenuItemCtx | null>(null);

export interface ContextMenuProps {
  open: boolean;
  /** Anchor point in viewport coords. */
  position: { x: number; y: number };
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

export function ContextMenu({ open, position, onClose, children, className }: ContextMenuProps) {
  const listRef = useRef<Array<HTMLElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Build a virtual reference element from the position.
  const virtualRef = useMemo(
    () => ({
      getBoundingClientRect: () => ({
        x: position.x,
        y: position.y,
        top: position.y,
        left: position.x,
        right: position.x,
        bottom: position.y,
        width: 0,
        height: 0,
      }),
    }),
    [position.x, position.y],
  );

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next) => { if (!next) onClose(); },
    placement: 'right-start',
    middleware: [flip({ padding: 8 }), shift({ padding: 8 })],
  });

  // Sync the virtual element each time position changes.
  useEffect(() => {
    refs.setPositionReference(virtualRef);
  }, [refs, virtualRef]);

  const dismiss = useDismiss(context, { outsidePress: true, escapeKey: true });
  const role = useRole(context, { role: 'menu' });
  const listNav = useListNavigation(context, {
    listRef,
    activeIndex,
    onNavigate: setActiveIndex,
    loop: true,
  });

  const { getFloatingProps, getItemProps } = useInteractions([dismiss, role, listNav]);
  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: { open: 120, close: 80 },
    initial: { opacity: 0, transform: 'scale(0.96)' },
  });

  const cls = ['ds-menu', 'ds-menu--context', className ?? ''].filter(Boolean).join(' ');

  if (!isMounted) return null;

  return (
    <FloatingPortal>
      <FloatingFocusManager
        context={context}
        modal={false}
        initialFocus={activeIndex ?? -1}
        returnFocus
      >
        <div
          ref={refs.setFloating}
          className={cls}
          style={{ ...floatingStyles, ...transitionStyles }}
          {...getFloatingProps()}
        >
          <FloatingList elementsRef={listRef}>
            <Ctx.Provider value={{ getItemProps, activeIndex, setOpen: (n) => { if (!n) onClose(); } }}>
              {children}
            </Ctx.Provider>
          </FloatingList>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}

export interface ContextMenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  onSelect?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  icon?: ReactNode;
  shortcut?: string[];
}

export const ContextMenuItem = forwardRef<HTMLButtonElement, ContextMenuItemProps>(function ContextMenuItem(
  { onSelect, disabled, destructive, icon, shortcut, children, className, ...rest },
  ref,
) {
  const ctx = useContext(Ctx);
  const { ref: listItemRef, index } = useListItem();
  const merged = useMergeRefs([ref, listItemRef]);
  const isActive = ctx?.activeIndex === index;
  const cls = [
    'ds-menu__item',
    destructive ? 'ds-menu__item--destructive' : '',
    isActive ? 'ds-menu__item--active' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={merged}
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cls}
      tabIndex={isActive ? 0 : -1}
      {...ctx?.getItemProps({
        onClick: () => {
          if (disabled) return;
          onSelect?.();
          ctx.setOpen(false);
        },
      })}
      {...rest}
    >
      {icon && <span className="ds-menu__icon">{icon}</span>}
      <span className="ds-menu__label-text">{children}</span>
      {shortcut && <KeyboardHint keys={shortcut} size="sm" className="ds-menu__shortcut" />}
    </button>
  );
});

export function ContextMenuSeparator() {
  return <div className="ds-menu__sep" role="separator" aria-hidden="true" />;
}
