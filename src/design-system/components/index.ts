/**
 * Notology Design System — primitive component library.
 * Stage 5.0.2a (simple primitives) + 5.0.2b (Floating-UI dependent)
 * + 5.0.11 utilities (HanBin 2026-05-22, iOS-style helpers).
 *
 * Importing any primitive pulls in primitives.css + utilities.css once
 * via the side-effect imports below. The order matters — primitives
 * define base shapes, utilities layer iOS-style overrides on top.
 */
import './primitives.css';
import '../utilities.css';

// Action
export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';
export { IconButton } from './IconButton';
export type { IconButtonProps, IconButtonVariant, IconButtonSize } from './IconButton';

// Form fields
export { Input } from './Input';
export type { InputProps, InputSize } from './Input';
export { Textarea } from './Textarea';
export type { TextareaProps } from './Textarea';
export { Checkbox } from './Checkbox';
export type { CheckboxProps } from './Checkbox';
export { Radio } from './Radio';
export type { RadioProps } from './Radio';
export { Toggle } from './Toggle';
export type { ToggleProps, ToggleSize } from './Toggle';

// Feedback
export { Spinner } from './Spinner';
export type { SpinnerProps, SpinnerSize } from './Spinner';
export { Skeleton } from './Skeleton';
export type { SkeletonProps, SkeletonVariant, SkeletonRadius } from './Skeleton';
export { ProgressBar } from './ProgressBar';
export type { ProgressBarProps, ProgressVariant } from './ProgressBar';

// Display
export { Badge } from './Badge';
export type { BadgeProps, BadgeVariant, BadgeSize } from './Badge';
export { Card } from './Card';
export type { CardProps, CardDensity } from './Card';
export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';
export { KeyboardHint } from './KeyboardHint';
export type { KeyboardHintProps, KeyboardHintSize } from './KeyboardHint';
export { PathDisplay } from './PathDisplay';
export type { PathDisplayProps } from './PathDisplay';

// ── 5.0.2b: Floating-UI dependent ──
export { Tooltip } from './Tooltip';
export type { TooltipProps } from './Tooltip';
export { Popover } from './Popover';
export type { PopoverProps } from './Popover';
export { Dialog } from './Dialog';
export type { DialogProps, DialogSize } from './Dialog';
export { DropdownMenu, MenuItem, MenuSeparator } from './DropdownMenu';
export type { DropdownMenuProps, MenuItemProps } from './DropdownMenu';
export { ContextMenu, ContextMenuItem, ContextMenuSeparator } from './ContextMenu';
export type { ContextMenuProps, ContextMenuItemProps } from './ContextMenu';
export { Tabs, TabList, Tab, TabPanel } from './Tabs';
export type { TabsProps, TabListProps, TabProps, TabPanelProps, TabsOrientation } from './Tabs';
export { SegmentedControl } from './SegmentedControl';
export type { SegmentedControlProps, SegmentedOption, SegmentedSize } from './SegmentedControl';
export { Select } from './Select';
export type { SelectProps, SelectOption, SelectSize } from './Select';
export { Toaster, toast, useToast } from './Toast';
export type { ToasterProps, ToastOptions, ToastVariant } from './Toast';

// ── 2026-05-22: Iconographic glyph constants ──
// Single source for sort/chevron/check/dismiss/dot glyphs.
// Used inline next to text (column labels, menu rows, status badges).
// Lucide React components stay the choice for interactive affordances.
export {
  SORT_ASC, SORT_DESC, sortGlyph,
  CHEVRON_RIGHT, CHEVRON_LEFT, CHEVRON_DOWN,
  CHECK, DISMISS,
  DOT, DOT_HOLLOW, STATUS_WARN,
  ELLIPSIS_V, ELLIPSIS_H,
} from '../glyphs';
