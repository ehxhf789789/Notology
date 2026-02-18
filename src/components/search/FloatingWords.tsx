import { useState, useEffect, useRef, useCallback } from 'react';
import { searchCommands } from '../../services/tauriCommands';

interface FloatingWordsProps {
  onWordClick: (word: string) => void;
  searchReady: boolean;
}

interface FloatingWordItem {
  id: number;
  word: string;
  style: React.CSSProperties;
}

// 5 columns × 4 rows grid for position distribution
const GRID_COLS = 5;
const GRID_ROWS = 4;
const TOTAL_CELLS = GRID_COLS * GRID_ROWS;

let nextId = 0;

function FloatingWords({ onWordClick, searchReady }: FloatingWordsProps) {
  const [words, setWords] = useState<FloatingWordItem[]>([]);
  const [termsLoaded, setTermsLoaded] = useState(false);
  const termsRef = useRef<[string, number][]>([]);
  const prevCellsRef = useRef<Set<number>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load terms once when search is ready
  useEffect(() => {
    if (!searchReady) return;

    let cancelled = false;
    searchCommands.getSuggestionTerms(200).then((terms) => {
      if (!cancelled && terms.length > 0) {
        termsRef.current = terms;
        setTermsLoaded(true);
      }
    }).catch((err) => {
      console.error('[FloatingWords] Failed to load terms:', err);
    });

    return () => { cancelled = true; };
  }, [searchReady]);

  // Pick random cells avoiding previous batch
  const pickCells = useCallback((count: number): number[] => {
    const available: number[] = [];
    for (let i = 0; i < TOTAL_CELLS; i++) {
      if (!prevCellsRef.current.has(i)) {
        available.push(i);
      }
    }
    // Shuffle and pick
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }
    const picked = available.slice(0, Math.min(count, available.length));
    prevCellsRef.current = new Set(picked);
    return picked;
  }, []);

  // Create a batch of floating words
  const spawnBatch = useCallback(() => {
    const terms = termsRef.current;
    if (terms.length === 0) return;

    const batchSize = 6 + Math.floor(Math.random() * 3); // 6~8
    const cells = pickCells(batchSize);
    const maxFreq = terms[0][1];

    const newWords: FloatingWordItem[] = cells.map((cell) => {
      // Pick weighted-random term (bias toward higher frequency)
      const idx = Math.floor(Math.pow(Math.random(), 1.5) * terms.length);
      const [word, freq] = terms[idx];

      // Grid cell → position with random offset within cell
      const col = cell % GRID_COLS;
      const row = Math.floor(cell / GRID_COLS);
      const cellW = 100 / GRID_COLS;
      const cellH = 100 / GRID_ROWS;
      const left = col * cellW + Math.random() * cellW * 0.7;
      const top = row * cellH + Math.random() * cellH * 0.6;

      // Frequency-based styling
      const ratio = Math.log(freq + 1) / Math.log(maxFreq + 1);
      const fontSize = 12 + ratio * 8; // 12~20px
      const opacity = 0.25 + ratio * 0.4; // 0.25~0.65

      // Random drift direction
      const dx = (Math.random() - 0.5) * 30; // -15~15px
      const dy = (Math.random() - 0.5) * 20; // -10~10px
      const duration = 7 + Math.random() * 3; // 7~10s
      const delay = Math.random() * 1.5; // 0~1.5s stagger

      return {
        id: nextId++,
        word,
        style: {
          left: `${left}%`,
          top: `${top}%`,
          fontSize: `${fontSize}px`,
          '--op': opacity,
          '--dx': `${dx}px`,
          '--dy': `${dy}px`,
          '--dur': `${duration}s`,
          '--delay': `${delay}s`,
        } as React.CSSProperties,
      };
    });

    setWords((prev) => [...prev, ...newWords]);
  }, [pickCells]);

  // Spawn batches on interval once terms are loaded
  useEffect(() => {
    if (!termsLoaded) return;

    // Initial batch after a short delay
    const initTimer = setTimeout(() => {
      spawnBatch();
      intervalRef.current = setInterval(spawnBatch, 4000);
    }, 500);

    return () => {
      clearTimeout(initTimer);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [termsLoaded, spawnBatch]);

  // Remove word when its animation ends
  const handleAnimationEnd = useCallback((id: number) => {
    setWords((prev) => prev.filter((w) => w.id !== id));
  }, []);

  if (!termsLoaded) {
    return null;
  }

  return (
    <div className="floating-words-container">
      {words.map((w) => (
        <span
          key={w.id}
          className="floating-word"
          style={w.style}
          onClick={() => onWordClick(w.word)}
          onAnimationEnd={() => handleAnimationEnd(w.id)}
        >
          {w.word}
        </span>
      ))}
    </div>
  );
}

export default FloatingWords;
