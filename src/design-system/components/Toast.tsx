import { createPortal } from 'react-dom';
import {
  useEffect,
  useState,
  type ReactNode,
} from 'react';

/** Toast queue is module-level so callers outside React (e.g. Tauri event
 *  handlers, async backends) can emit toasts without holding a ref. */

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  variant?: ToastVariant;
  /** ms; default 4000. 0 = persistent until dismissed. */
  duration?: number;
  /** Single inline action. */
  action?: { label: ReactNode; onClick: () => void };
}

interface ToastEntry extends ToastOptions {
  id: string;
}

type Listener = (entries: ToastEntry[]) => void;

let entries: ToastEntry[] = [];
let listeners: Listener[] = [];
let nextId = 0;

function notify() {
  for (const l of listeners) l(entries);
}

function pushToast(options: ToastOptions): string {
  const id = `ds-toast-${++nextId}`;
  const entry: ToastEntry = { id, ...options };
  entries = [...entries, entry];
  notify();

  const duration = options.duration ?? 4000;
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration);
  }
  return id;
}

function dismissToast(id: string) {
  const before = entries.length;
  entries = entries.filter((e) => e.id !== id);
  if (entries.length !== before) notify();
}

function dismissAll() {
  if (entries.length === 0) return;
  entries = [];
  notify();
}

/** Imperative API — call from anywhere. */
export const toast = Object.assign(
  (options: ToastOptions): string => pushToast(options),
  {
    info: (title: ReactNode, opts?: Omit<ToastOptions, 'title' | 'variant'>) =>
      pushToast({ ...opts, title, variant: 'info' }),
    success: (title: ReactNode, opts?: Omit<ToastOptions, 'title' | 'variant'>) =>
      pushToast({ ...opts, title, variant: 'success' }),
    warning: (title: ReactNode, opts?: Omit<ToastOptions, 'title' | 'variant'>) =>
      pushToast({ ...opts, title, variant: 'warning' }),
    danger: (title: ReactNode, opts?: Omit<ToastOptions, 'title' | 'variant'>) =>
      pushToast({ ...opts, title, variant: 'danger' }),
    dismiss: dismissToast,
    dismissAll,
  },
);

/** Hook variant for code already inside a React component. */
export function useToast() {
  return { toast, dismiss: dismissToast, dismissAll };
}

export interface ToasterProps {
  /** Where the stack appears. Default: bottom-right. */
  position?:
    | 'top-left' | 'top-right' | 'top-center'
    | 'bottom-left' | 'bottom-right' | 'bottom-center';
  className?: string;
}

export function Toaster({ position = 'bottom-right', className }: ToasterProps) {
  const [list, setList] = useState<ToastEntry[]>(entries);

  useEffect(() => {
    const l: Listener = (next) => setList([...next]);
    listeners.push(l);
    return () => {
      listeners = listeners.filter((x) => x !== l);
    };
  }, []);

  if (typeof document === 'undefined') return null;

  const cls = ['ds-toast-stack', `ds-toast-stack--${position}`, className ?? '']
    .filter(Boolean)
    .join(' ');

  return createPortal(
    <div className={cls} role="region" aria-label="알림">
      {list.map((t) => (
        <ToastItem key={t.id} entry={t} />
      ))}
    </div>,
    document.body,
  );
}

function ToastItem({ entry }: { entry: ToastEntry }) {
  const variant = entry.variant ?? 'info';
  const cls = ['ds-toast', `ds-toast--${variant}`].join(' ');

  return (
    <div
      className={cls}
      role={variant === 'danger' || variant === 'warning' ? 'alert' : 'status'}
      aria-live={variant === 'danger' ? 'assertive' : 'polite'}
    >
      <div className="ds-toast__body">
        <div className="ds-toast__title">{entry.title}</div>
        {entry.description && <div className="ds-toast__desc">{entry.description}</div>}
      </div>
      {entry.action && (
        <button
          type="button"
          className="ds-toast__action"
          onClick={() => {
            entry.action!.onClick();
            dismissToast(entry.id);
          }}
        >
          {entry.action.label}
        </button>
      )}
      <button
        type="button"
        className="ds-toast__close"
        aria-label="닫기"
        onClick={() => dismissToast(entry.id)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
