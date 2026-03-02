import { useRef, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import logoWhite from '../../assets/logo-white.png';
import logoBlack from '../../assets/logo-black.png';
import { useSettingsStore } from '../../stores/zustand/settingsStore';

const appWindow = getCurrentWindow();

function TitleBar() {
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const theme = useSettingsStore(s => s.theme);

  // Determine effective theme (considering system preference)
  const getEffectiveTheme = () => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return theme;
  };
  const effectiveTheme = getEffectiveTheme();
  const logo = effectiveTheme === 'light' ? logoBlack : logoWhite;

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.titlebar-controls')) return;
    mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
  };

  // Use global mousemove to detect drag start
  useEffect(() => {
    const handleGlobalMouseMove = async (e: MouseEvent) => {
      if (!mouseDownPosRef.current || isDraggingRef.current) return;

      const dx = Math.abs(e.clientX - mouseDownPosRef.current.x);
      const dy = Math.abs(e.clientY - mouseDownPosRef.current.y);

      if (dx > 5 || dy > 5) {
        isDraggingRef.current = true;
        mouseDownPosRef.current = null;
        try {
          await appWindow.startDragging();
        } catch (err) {
          console.error('startDragging failed:', err);
        }
        isDraggingRef.current = false;
      }
    };

    const handleGlobalMouseUp = () => {
      mouseDownPosRef.current = null;
      isDraggingRef.current = false;
    };

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, []);

  const handleDoubleClick = async (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.titlebar-controls')) return;
    mouseDownPosRef.current = null;
    try {
      await appWindow.toggleMaximize();
    } catch (err) {
      console.error('toggleMaximize failed:', err);
    }
  };

  const handleMinimize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await appWindow.minimize();
    } catch (err) {
      console.error('minimize failed:', err);
    }
  };

  const handleMaximize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await appWindow.toggleMaximize();
    } catch (err) {
      console.error('toggleMaximize failed:', err);
    }
  };

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await appWindow.close();
    } catch (err) {
      console.error('close failed:', err);
    }
  };

  return (
    <header className="titlebar" onMouseDown={handleMouseDown} onDoubleClick={handleDoubleClick}>
      <div className="titlebar-left">
        <img src={logo} alt="" className="titlebar-icon" />
        <span className="titlebar-title">Notology</span>
      </div>
      <div className="titlebar-controls">
        <button
          className="titlebar-btn"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleMinimize}
          aria-label="Minimize"
          tabIndex={-1}
        >
          <svg width="10" height="1" viewBox="0 0 10 1">
            <rect width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className="titlebar-btn"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleMaximize}
          aria-label="Maximize"
          tabIndex={-1}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleClose}
          aria-label="Close"
          tabIndex={-1}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.2" />
            <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </header>
  );
}

export default TitleBar;
