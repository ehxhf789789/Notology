/**
 * Toast — Bottom-center notification with auto-dismiss.
 * Inverted bg (dark on light, light on dark), 3s auto-hide.
 */
import { useEffect, useState, useCallback, useRef } from 'react';

interface ToastItem {
  id: number;
  message: string;
  type?: 'success' | 'error' | 'info';
}

let toastId = 0;
const listeners = new Set<(toast: ToastItem) => void>();

/** Show a toast notification. Call from anywhere. */
export function showToast(message: string, type?: 'success' | 'error' | 'info') {
  const item: ToastItem = { id: ++toastId, message, type };
  listeners.forEach(fn => fn(item));
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const handler = (toast: ToastItem) => {
      setToasts(prev => [...prev, toast]);
      const timer = setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toast.id));
        timers.current.delete(toast.id);
      }, 3000);
      timers.current.set(toast.id, timer);
    };
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
      timers.current.forEach(clearTimeout);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="m-toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`m-toast m-toast--${t.type ?? 'info'}`}>
          {t.type === 'success' && '✅ '}
          {t.type === 'error' && '❌ '}
          {t.message}
        </div>
      ))}
    </div>
  );
}
