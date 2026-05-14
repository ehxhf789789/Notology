import { cloneElement, useState, type ReactElement, type ReactNode } from 'react';
import {
  useFloating,
  useHover,
  useFocus,
  useDismiss,
  useRole,
  useInteractions,
  offset,
  flip,
  shift,
  arrow,
  FloatingPortal,
  FloatingArrow,
  useTransitionStyles,
  useMergeRefs,
  type Placement,
} from '@floating-ui/react';
import { useRef } from 'react';

export interface TooltipProps {
  /** Content shown inside the tooltip. */
  content: ReactNode;
  /** Side and alignment for the tooltip. */
  placement?: Placement;
  /** Open/close delay in ms. */
  delay?: number | { open?: number; close?: number };
  /** Disable rendering — useful for conditional tooltips. */
  disabled?: boolean;
  /** The element that triggers the tooltip. Receives ref + ARIA. */
  children: ReactElement<{ ref?: React.Ref<unknown>; [key: string]: unknown }>;
}

const ARROW_SIZE = 6;

export function Tooltip({
  content,
  placement = 'top',
  delay = { open: 300, close: 80 },
  disabled,
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const arrowRef = useRef<SVGSVGElement | null>(null);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [
      offset(ARROW_SIZE + 2),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      arrow({ element: arrowRef }),
    ],
  });

  const hover = useHover(context, {
    delay,
    move: false,
    enabled: !disabled,
  });
  const focus = useFocus(context, { enabled: !disabled });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'tooltip' });

  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);
  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: { open: 150, close: 100 },
    initial: { opacity: 0, transform: 'scale(0.96)' },
  });

  // Merge our ref with the child's existing ref (if any).
  const childRef = (children as { ref?: React.Ref<unknown> }).ref;
  const mergedRef = useMergeRefs([refs.setReference, childRef]);

  const triggerProps = getReferenceProps({
    ref: mergedRef as React.Ref<unknown>,
    ...(children.props as Record<string, unknown>),
  });

  if (disabled) return children;

  return (
    <>
      {cloneElement(children, triggerProps)}
      {isMounted && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            className="ds-tooltip"
            style={{ ...floatingStyles, ...transitionStyles }}
            {...getFloatingProps()}
          >
            {content}
            <FloatingArrow
              ref={arrowRef}
              context={context}
              className="ds-tooltip__arrow"
              width={ARROW_SIZE * 2}
              height={ARROW_SIZE}
            />
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
