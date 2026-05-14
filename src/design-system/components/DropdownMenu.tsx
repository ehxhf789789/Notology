import {
  cloneElement,
  createContext,
  forwardRef,
  useContext,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  useFloating,
  useClick,
  useDismiss,
  useRole,
  useListNavigation,
  useInteractions,
  offset,
  flip,
  shift,
  FloatingPortal,
  FloatingFocusManager,
  FloatingList,
  useListItem,
  useTransitionStyles,
  useMergeRefs,
  type Placement,
} from '@floating-ui/react';
import { KeyboardHint } from './KeyboardHint';

interface MenuContextValue {
  getItemProps: (
    userProps?: HTMLAttributes<HTMLElement>,
  ) => Record<string, unknown>;
  activeIndex: number | null;
  setOpen: (open: boolean) => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

export interface DropdownMenuProps {
  trigger: ReactElement<{ ref?: React.Ref<unknown>; [key: string]: unknown }>;
  children: ReactNode;
  placement?: Placement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function DropdownMenu({
  trigger,
  children,
  placement = 'bottom-start',
  open: openProp,
  onOpenChange,
  className,
}: DropdownMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  const listRef = useRef<Array<HTMLElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const listNav = useListNavigation(context, {
    listRef,
    activeIndex,
    onNavigate: setActiveIndex,
    loop: true,
  });

  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    click,
    dismiss,
    role,
    listNav,
  ]);

  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: { open: 140, close: 100 },
    initial: { opacity: 0, transform: 'scale(0.97)' },
  });

  const childRef = (trigger as { ref?: React.Ref<unknown> }).ref;
  const mergedRef = useMergeRefs([refs.setReference, childRef]);
  const triggerProps = getReferenceProps({
    ref: mergedRef as React.Ref<unknown>,
    ...(trigger.props as Record<string, unknown>),
  });

  const cls = ['ds-menu', className ?? ''].filter(Boolean).join(' ');

  return (
    <>
      {cloneElement(trigger, triggerProps)}
      {isMounted && (
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
                <MenuContext.Provider value={{ getItemProps, activeIndex, setOpen }}>
                  {children}
                </MenuContext.Provider>
              </FloatingList>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  /** Selected callback — receives no args; close handled internally. */
  onSelect?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  icon?: ReactNode;
  shortcut?: string[];
  /** When true, render a label without item interactivity. */
  asLabel?: boolean;
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { onSelect, disabled, destructive, icon, shortcut, children, asLabel, className, ...rest },
  ref,
) {
  const ctx = useContext(MenuContext);
  const { ref: listItemRef, index } = useListItem();

  if (asLabel) {
    const cls = ['ds-menu__label', className ?? ''].filter(Boolean).join(' ');
    return <div className={cls}>{children}</div>;
  }

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

export function MenuSeparator() {
  return <div className="ds-menu__sep" role="separator" aria-hidden="true" />;
}
