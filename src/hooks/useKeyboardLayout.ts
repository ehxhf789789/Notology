/**
 * useKeyboardLayout — Detects soft keyboard visibility and height.
 *
 * Uses VisualViewport API for reliable cross-platform detection.
 * Toggles `keyboard-open` class on document.body for CSS targeting.
 * Returns keyboardHeight for dynamic positioning (format bar, bottom sheets).
 */
import { useState, useEffect, useCallback } from 'react';

interface KeyboardLayoutState {
  keyboardVisible: boolean;
  keyboardHeight: number;
}

export function useKeyboardLayout(): KeyboardLayoutState {
  const [state, setState] = useState<KeyboardLayoutState>({
    keyboardVisible: false,
    keyboardHeight: 0,
  });

  const update = useCallback(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    // When keyboard is open, visualViewport.height < window.innerHeight
    const diff = window.innerHeight - vv.height;
    // Threshold: 150px to distinguish keyboard from minor UI chrome changes
    const visible = diff > 150;
    const height = visible ? diff : 0;

    setState(prev => {
      if (prev.keyboardVisible === visible && prev.keyboardHeight === height) return prev;
      return { keyboardVisible: visible, keyboardHeight: height };
    });

    // Toggle body class for CSS
    document.body.classList.toggle('keyboard-open', visible);
  }, []);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);

    // Initial check
    update();

    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.body.classList.remove('keyboard-open');
    };
  }, [update]);

  return state;
}
