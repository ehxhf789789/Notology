/**
 * BottomSheet — 3-snap iOS-style bottom sheet.
 * Snap points: peek (64px), half (50vh), full (100vh - safe).
 * Uses touch gesture for drag.
 */
import { useRef, useCallback, useEffect, useState, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
}

type Snap = 'peek' | 'half' | 'full';

const SNAP_POSITIONS: Record<Snap, number> = {
  peek: 64,
  half: window.innerHeight * 0.5,
  full: window.innerHeight - 60,
};

export function BottomSheet({ open, onClose, children, title }: Props) {
  const [snap, setSnap] = useState<Snap>('half');
  const [dragging, setDragging] = useState(false);
  const [translateY, setTranslateY] = useState(0);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  useEffect(() => {
    if (open) setSnap('half');
  }, [open]);

  const height = dragging
    ? Math.max(64, startHeightRef.current - translateY)
    : SNAP_POSITIONS[snap];

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    startYRef.current = e.touches[0].clientY;
    startHeightRef.current = SNAP_POSITIONS[snap];
    setDragging(true);
  }, [snap]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragging) return;
    const dy = e.touches[0].clientY - startYRef.current;
    setTranslateY(dy);
  }, [dragging]);

  const handleTouchEnd = useCallback(() => {
    setDragging(false);
    const finalHeight = startHeightRef.current - translateY;
    setTranslateY(0);

    if (finalHeight < 100) {
      onClose();
      return;
    }

    const halfH = SNAP_POSITIONS.half;
    const fullH = SNAP_POSITIONS.full;
    if (finalHeight > (halfH + fullH) / 2) setSnap('full');
    else if (finalHeight > (64 + halfH) / 2) setSnap('half');
    else setSnap('peek');
  }, [translateY, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="mobile-sheet-backdrop" onClick={onClose} />
      <div
        className={`mobile-sheet ${dragging ? 'dragging' : ''}`}
        style={{ height }}
      >
        <div
          className="mobile-sheet-handle-area"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div className="mobile-sheet-handle" />
          {title && <div className="mobile-sheet-title">{title}</div>}
        </div>
        <div className="mobile-sheet-content">{children}</div>
      </div>
    </>
  );
}
