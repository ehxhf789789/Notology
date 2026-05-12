import { useEffect, useState } from 'react';

export interface ToastMessage {
  id: number;
  type: 'success' | 'info' | 'warning' | 'error';
  title: string;
  description?: string;
  duration?: number;
}

let nextId = 1;
const listeners: Array<(t: ToastMessage) => void> = [];

/** Show a toast notification from anywhere in the app. */
export function showToast(t: Omit<ToastMessage, 'id'>) {
  const msg: ToastMessage = { id: nextId++, ...t };
  listeners.forEach(l => l(msg));
}

/** Mount once at app root to display toasts. */
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const listener = (t: ToastMessage) => {
      setToasts(prev => [...prev, t]);
      setTimeout(() => {
        setToasts(prev => prev.filter(x => x.id !== t.id));
      }, t.duration || 4000);
    };
    listeners.push(listener);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div style={{
      position: 'fixed', top: 16, right: 16, zIndex: 99999,
      display: 'flex', flexDirection: 'column', gap: 8,
      pointerEvents: 'none',
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          background: 'var(--bg-elevated, #fff)',
          borderRadius: 8,
          padding: '10px 14px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
          borderLeft: `4px solid ${
            t.type === 'success' ? '#10b981' :
            t.type === 'warning' ? '#f59e0b' :
            t.type === 'error' ? '#ef4444' : '#3b82f6'
          }`,
          minWidth: 260, maxWidth: 380,
          pointerEvents: 'auto',
          color: 'var(--fg-default, #333)',
          fontSize: 13,
        }}>
          <strong>{t.title}</strong>
          {t.description && <div style={{ marginTop: 2, opacity: 0.8, fontSize: 12 }}>{t.description}</div>}
        </div>
      ))}
    </div>
  );
}
