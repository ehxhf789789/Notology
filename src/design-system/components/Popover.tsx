import {
  cloneElement,
  useState,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  useFloating,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  offset,
  flip,
  shift,
  arrow,
  FloatingPortal,
  FloatingFocusManager,
  FloatingArrow,
  useTransitionStyles,
  useMergeRefs,
  type Placement,
} from '@floating-ui/react';

export interface PopoverProps {
  /** The element that opens the popover when clicked. */
  trigger: ReactElement<{ ref?: React.Ref<unknown>; [key: string]: unknown }>;
  /** Popover content. */
  children: ReactNode;
  /** Controlled open state. Omit for uncontrolled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: Placement;
  /** Padding from viewport edges (px). */
  edgePadding?: number;
  /** Render an arrow pointing to the trigger. */
  withArrow?: boolean;
  /** Initial focus inside the popover when it opens. */
  initialFocus?: number | React.RefObject<HTMLElement>;
  className?: string;
}

const ARROW_SIZE = 6;

export function Popover({
  trigger,
  children,
  open: openProp,
  onOpenChange,
  placement = 'bottom-start',
  edgePadding = 8,
  withArrow,
  initialFocus,
  className,
}: PopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  const arrowRef = useRef<SVGSVGElement | null>(null);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [
      offset(withArrow ? ARROW_SIZE + 4 : 6),
      flip({ padding: edgePadding }),
      shift({ padding: edgePadding }),
      ...(withArrow ? [arrow({ element: arrowRef })] : []),
    ],
  });

  const click = useClick(context);
  const dismiss = useDismiss(context, { outsidePressEvent: 'mousedown' });
  const role = useRole(context, { role: 'dialog' });

  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);
  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: { open: 150, close: 100 },
    initial: { opacity: 0, transform: 'scale(0.97)' },
  });

  const childRef = (trigger as { ref?: React.Ref<unknown> }).ref;
  const mergedRef = useMergeRefs([refs.setReference, childRef]);
  const triggerProps = getReferenceProps({
    ref: mergedRef as React.Ref<unknown>,
    ...(trigger.props as Record<string, unknown>),
  });

  const cls = ['ds-popover', className ?? ''].filter(Boolean).join(' ');

  return (
    <>
      {cloneElement(trigger, triggerProps)}
      {isMounted && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={initialFocus}>
            <div
              ref={refs.setFloating}
              className={cls}
              style={{ ...floatingStyles, ...transitionStyles }}
              {...getFloatingProps()}
            >
              {children}
              {withArrow && (
                <FloatingArrow
                  ref={arrowRef}
                  context={context}
                  className="ds-popover__arrow"
                  width={ARROW_SIZE * 2}
                  height={ARROW_SIZE}
                />
              )}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
