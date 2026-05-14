import {
  createContext,
  useContext,
  useId,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

export type TabsOrientation = 'horizontal' | 'vertical';

interface TabsCtx {
  value: string;
  onChange: (value: string) => void;
  baseId: string;
  orientation: TabsOrientation;
  registerTab: (value: string, el: HTMLButtonElement | null) => void;
  focusTab: (value: string) => void;
}

const Ctx = createContext<TabsCtx | null>(null);

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  onChange: (value: string) => void;
  orientation?: TabsOrientation;
  children: ReactNode;
}

export function Tabs({
  value,
  onChange,
  orientation = 'horizontal',
  className,
  children,
  ...rest
}: TabsProps) {
  const baseId = useId();
  const tabRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  const registerTab = (v: string, el: HTMLButtonElement | null) => {
    if (el) tabRefs.current.set(v, el);
    else tabRefs.current.delete(v);
  };
  const focusTab = (v: string) => {
    tabRefs.current.get(v)?.focus();
  };

  const cls = ['ds-tabs', `ds-tabs--${orientation}`, className ?? ''].filter(Boolean).join(' ');

  return (
    <Ctx.Provider value={{ value, onChange, baseId, orientation, registerTab, focusTab }}>
      <div className={cls} {...rest}>{children}</div>
    </Ctx.Provider>
  );
}

export interface TabListProps extends HTMLAttributes<HTMLDivElement> {
  /** Accessible label for the tab strip. */
  'aria-label'?: string;
  children: ReactNode;
}

export function TabList({ className, children, ...rest }: TabListProps) {
  const ctx = useContext(Ctx);
  const cls = ['ds-tabs__list', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={cls} role="tablist" aria-orientation={ctx?.orientation} {...rest}>
      {children}
    </div>
  );
}

export interface TabProps extends HTMLAttributes<HTMLButtonElement> {
  value: string;
  disabled?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}

export function Tab({ value, disabled, icon, className, children, ...rest }: TabProps) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('<Tab> must be a child of <Tabs>');

  const selected = ctx.value === value;
  const tabId = `${ctx.baseId}-tab-${value}`;
  const panelId = `${ctx.baseId}-panel-${value}`;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const tabs = Array.from((e.currentTarget.parentElement?.children ?? []))
      .filter((el): el is HTMLButtonElement => el instanceof HTMLButtonElement && !el.disabled);
    const idx = tabs.indexOf(e.currentTarget);
    const horizontal = ctx.orientation === 'horizontal';
    const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';
    const prevKey = horizontal ? 'ArrowLeft' : 'ArrowUp';

    if (e.key === nextKey) {
      e.preventDefault();
      const next = tabs[(idx + 1) % tabs.length];
      next.focus();
      next.click();
    } else if (e.key === prevKey) {
      e.preventDefault();
      const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
      prev.focus();
      prev.click();
    } else if (e.key === 'Home') {
      e.preventDefault();
      tabs[0]?.focus();
      tabs[0]?.click();
    } else if (e.key === 'End') {
      e.preventDefault();
      tabs[tabs.length - 1]?.focus();
      tabs[tabs.length - 1]?.click();
    }
  };

  const cls = [
    'ds-tabs__tab',
    selected ? 'ds-tabs__tab--selected' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={(el) => ctx.registerTab(value, el)}
      type="button"
      role="tab"
      id={tabId}
      aria-controls={panelId}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      onClick={() => !disabled && ctx.onChange(value)}
      onKeyDown={onKeyDown}
      className={cls}
      {...rest}
    >
      {icon && <span className="ds-tabs__tab-icon">{icon}</span>}
      <span>{children}</span>
    </button>
  );
}

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  /** Keep mounted while hidden. Default false (unmounted to save work). */
  keepMounted?: boolean;
  children: ReactNode;
}

export function TabPanel({ value, keepMounted, className, children, ...rest }: TabPanelProps) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('<TabPanel> must be a child of <Tabs>');

  const selected = ctx.value === value;
  const tabId = `${ctx.baseId}-tab-${value}`;
  const panelId = `${ctx.baseId}-panel-${value}`;
  const cls = ['ds-tabs__panel', className ?? ''].filter(Boolean).join(' ');

  if (!selected && !keepMounted) return null;

  return (
    <div
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabId}
      hidden={!selected}
      tabIndex={0}
      className={cls}
      {...rest}
    >
      {children}
    </div>
  );
}
