/**
 * SegmentControl — TimeBlocks-style sliding pill selector.
 * Outer: bg-tertiary, radius lg, padding 3px.
 * Selected pill: bg-primary (light) / bg-secondary (dark), radius md, shadow xs.
 * Pill slides with translateX (200ms easeInOut).
 */
import { useRef, useEffect, useState } from 'react';

interface Segment<T extends string> {
  id: T;
  label: string;
}

interface Props<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function SegmentControl<T extends string>({ segments, value, onChange }: Props<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pillStyle, setPillStyle] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const idx = segments.findIndex(s => s.id === value);
    const buttons = container.querySelectorAll<HTMLButtonElement>('.segment-btn');
    if (buttons[idx]) {
      const btn = buttons[idx];
      setPillStyle({ left: btn.offsetLeft, width: btn.offsetWidth });
    }
  }, [value, segments]);

  return (
    <div className="segment-control" ref={containerRef}>
      <div
        className="segment-pill"
        style={{
          transform: `translateX(${pillStyle.left}px)`,
          width: pillStyle.width || `${100 / segments.length}%`,
        }}
      />
      {segments.map(s => (
        <button
          key={s.id}
          className={`segment-btn ${value === s.id ? 'active' : ''}`}
          onClick={() => onChange(s.id)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
