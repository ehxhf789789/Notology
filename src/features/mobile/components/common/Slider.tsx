/**
 * Slider — Track + handle with accent fill.
 */
import { useRef, useCallback } from 'react';

interface Props {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  label?: string;
}

export function Slider({ min, max, step = 1, value, onChange, label }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pct = ((value - min) / (max - min)) * 100;

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(Number(e.target.value));
  }, [onChange]);

  return (
    <div className="m-slider">
      <div className="m-slider-track" ref={trackRef}>
        <div className="m-slider-fill" style={{ width: `${pct}%` }} />
      </div>
      <input
        className="m-slider-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handleInput}
      />
      {label && <span className="m-slider-value">{label}</span>}
    </div>
  );
}
