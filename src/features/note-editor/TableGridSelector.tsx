import { memo, useState, useCallback } from 'react';

interface TableGridSelectorProps {
  onSelect: (rows: number, cols: number) => void;
  onClose: () => void;
}

const MAX_ROWS = 8;
const MAX_COLS = 8;

const TableGridSelector = memo(function TableGridSelector({ onSelect, onClose }: TableGridSelectorProps) {
  const [hoverRow, setHoverRow] = useState(0);
  const [hoverCol, setHoverCol] = useState(0);

  const handleCellHover = useCallback((row: number, col: number) => {
    setHoverRow(row);
    setHoverCol(col);
  }, []);

  const handleCellClick = useCallback((row: number, col: number) => {
    onSelect(row + 1, col + 1);
    onClose();
  }, [onSelect, onClose]);

  return (
    <div className="table-grid-selector">
      <div className="table-grid-size">{hoverRow + 1} x {hoverCol + 1}</div>
      <div className="table-grid">
        {Array.from({ length: MAX_ROWS }, (_, rowIndex) => (
          <div key={rowIndex} className="table-grid-row">
            {Array.from({ length: MAX_COLS }, (_, colIndex) => (
              <div
                key={colIndex}
                className={`table-grid-cell ${
                  rowIndex <= hoverRow && colIndex <= hoverCol ? 'active' : ''
                }`}
                onMouseEnter={() => handleCellHover(rowIndex, colIndex)}
                onClick={() => handleCellClick(rowIndex, colIndex)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
});

export default TableGridSelector;
