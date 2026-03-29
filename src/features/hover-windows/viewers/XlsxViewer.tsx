import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';

interface XlsxViewerProps {
  data: ArrayBuffer;
}

interface CellAddress {
  row: number;
  col: number;
}

interface SelectionState {
  type: 'none' | 'cell' | 'range' | 'row' | 'column';
  start: CellAddress | null;
  end: CellAddress | null;
  selectedRows: number[];
  selectedCols: number[];
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

// Convert column index to Excel-style letter (0 -> A, 25 -> Z, 26 -> AA, etc.)
function getColumnLabel(index: number): string {
  let label = '';
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode((n % 26) + 65) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

// Format cell value for display
function formatCellValue(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    // Format numbers nicely
    if (Number.isInteger(value)) return value.toString();
    return value.toFixed(2).replace(/\.?0+$/, '');
  }
  return String(value);
}

export function XlsxViewer({ data }: XlsxViewerProps) {
  const [currentSheet, setCurrentSheet] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState<SelectionState>({
    type: 'none',
    start: null,
    end: null,
    selectedRows: [],
    selectedCols: [],
  });
  const [isSelecting, setIsSelecting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);

  // Parse workbook and extract sheet data
  const { sheetNames, sheetData, colCount, rowCount, error } = useMemo(() => {
    try {
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetNames = workbook.SheetNames;
      const sheetName = sheetNames[currentSheet] || sheetNames[0];
      const sheet = workbook.Sheets[sheetName];

      // Use sheet_to_json with header:1 for array-of-arrays format
      const sheetData: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      // Get range to determine column count
      const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : { s: { c: 0, r: 0 }, e: { c: 0, r: 0 } };
      const colCount = range.e.c - range.s.c + 1;
      const rowCount = sheetData.length;

      return { sheetNames, sheetData, colCount, rowCount, error: null };
    } catch (err) {
      console.error('[XlsxViewer] Parse failed:', err);
      return { sheetNames: [], sheetData: [], colCount: 0, rowCount: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }, [data, currentSheet]);

  // Use document-level capture to intercept before WebView2 native zoom
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (!containerRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setZoom(prev => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev + delta)));
    };
    document.addEventListener('wheel', handler, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', handler, { capture: true } as EventListenerOptions);
  }, []);

  // Check if a cell is within current selection
  const isCellInSelection = useCallback((row: number, col: number): boolean => {
    const { type, start, end, selectedRows, selectedCols } = selection;
    if (type === 'none') return false;
    if (type === 'row') return selectedRows.includes(row);
    if (type === 'column') return selectedCols.includes(col);
    if (!start || !end) return false;

    const minRow = Math.min(start.row, end.row);
    const maxRow = Math.max(start.row, end.row);
    const minCol = Math.min(start.col, end.col);
    const maxCol = Math.max(start.col, end.col);

    return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
  }, [selection]);

  // Get CSS class for cell selection state
  const getCellSelectionClass = useCallback((row: number, col: number): string => {
    const classes: string[] = [];
    if (isCellInSelection(row, col)) {
      classes.push('selected');
    }
    if (selection.start?.row === row && selection.start?.col === col) {
      classes.push('selected-primary');
    }
    return classes.join(' ');
  }, [selection, isCellInSelection]);

  // Handle cell mouse down (start selection)
  const handleCellMouseDown = useCallback((row: number, col: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (e.shiftKey && selection.start) {
      // Extend selection to range
      setSelection(prev => ({ ...prev, type: 'range', end: { row, col } }));
    } else {
      // Start new selection
      setSelection({
        type: 'cell',
        start: { row, col },
        end: { row, col },
        selectedRows: [],
        selectedCols: [],
      });
      setIsSelecting(true);
    }
  }, [selection.start]);

  // Handle cell mouse enter (extend selection during drag)
  const handleCellMouseEnter = useCallback((row: number, col: number) => {
    if (isSelecting) {
      setSelection(prev => ({
        ...prev,
        type: 'range',
        end: { row, col }
      }));
    }
  }, [isSelecting]);

  // Handle mouse up (end selection)
  const handleMouseUp = useCallback(() => {
    setIsSelecting(false);
  }, []);

  // Handle column header click
  const handleColumnHeaderClick = useCallback((col: number, e: React.MouseEvent) => {
    if (e.shiftKey && selection.selectedCols.length > 0) {
      // Extend column selection
      const start = selection.selectedCols[0];
      const cols: number[] = [];
      for (let c = Math.min(start, col); c <= Math.max(start, col); c++) {
        cols.push(c);
      }
      setSelection({ type: 'column', start: null, end: null, selectedRows: [], selectedCols: cols });
    } else {
      setSelection({ type: 'column', start: null, end: null, selectedRows: [], selectedCols: [col] });
    }
  }, [selection.selectedCols]);

  // Handle row header click
  const handleRowHeaderClick = useCallback((row: number, e: React.MouseEvent) => {
    if (e.shiftKey && selection.selectedRows.length > 0) {
      // Extend row selection
      const start = selection.selectedRows[0];
      const rows: number[] = [];
      for (let r = Math.min(start, row); r <= Math.max(start, row); r++) {
        rows.push(r);
      }
      setSelection({ type: 'row', start: null, end: null, selectedRows: rows, selectedCols: [] });
    } else {
      setSelection({ type: 'row', start: null, end: null, selectedRows: [row], selectedCols: [] });
    }
  }, [selection.selectedRows]);

  // Handle corner cell click (select all)
  const handleSelectAll = useCallback(() => {
    if (rowCount === 0 || colCount === 0) return;
    setSelection({
      type: 'range',
      start: { row: 0, col: 0 },
      end: { row: rowCount - 1, col: colCount - 1 },
      selectedRows: [],
      selectedCols: [],
    });
  }, [rowCount, colCount]);

  // Get cell value helper
  const getCellValue = useCallback((row: number, col: number): string => {
    if (row < 0 || row >= sheetData.length) return '';
    const rowData = sheetData[row];
    if (!rowData || col < 0 || col >= rowData.length) return '';
    return formatCellValue(rowData[col]);
  }, [sheetData]);

  // Copy selection to clipboard (TSV format for Excel compatibility)
  const copySelectionToClipboard = useCallback(async () => {
    const { type, start, end, selectedRows, selectedCols } = selection;

    if (type === 'none') return;

    let rows: string[][] = [];

    if ((type === 'cell' || type === 'range') && start && end) {
      const minRow = Math.min(start.row, end.row);
      const maxRow = Math.max(start.row, end.row);
      const minCol = Math.min(start.col, end.col);
      const maxCol = Math.max(start.col, end.col);

      for (let r = minRow; r <= maxRow; r++) {
        const rowData: string[] = [];
        for (let c = minCol; c <= maxCol; c++) {
          rowData.push(getCellValue(r, c));
        }
        rows.push(rowData);
      }
    } else if (type === 'row') {
      for (const rowIdx of selectedRows.sort((a, b) => a - b)) {
        const rowData: string[] = [];
        for (let c = 0; c < colCount; c++) {
          rowData.push(getCellValue(rowIdx, c));
        }
        rows.push(rowData);
      }
    } else if (type === 'column') {
      for (let r = 0; r < rowCount; r++) {
        const rowData = selectedCols.sort((a, b) => a - b).map(c => getCellValue(r, c));
        rows.push(rowData);
      }
    }

    // Convert to TSV (tab-separated values)
    const tsv = rows.map(row => row.join('\t')).join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
    } catch (err) {
      console.error('[XlsxViewer] Copy failed:', err);
    }
  }, [selection, getCellValue, colCount, rowCount]);

  // Keyboard handler for Ctrl+C
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (selection.type !== 'none' && containerRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          copySelectionToClipboard();
        }
      }
      // Clear selection on Escape
      if (e.key === 'Escape') {
        setSelection({ type: 'none', start: null, end: null, selectedRows: [], selectedCols: [] });
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selection.type, copySelectionToClipboard]);

  // Add global mouseup listener
  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseUp]);

  // Clear selection when sheet changes
  useEffect(() => {
    setSelection({ type: 'none', start: null, end: null, selectedRows: [], selectedCols: [] });
  }, [currentSheet]);

  if (error) {
    return (
      <div className="office-viewer-container xlsx-viewer">
        <div className="office-viewer-error">Failed to parse spreadsheet: {error}</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="office-viewer-container xlsx-viewer" tabIndex={0}>
      <div className="xlsx-zoom-indicator">{Math.round(zoom * 100)}%</div>
      <div
        ref={gridContainerRef}
        className="xlsx-grid-container"
        onMouseLeave={handleMouseUp}
      >
        <div
          className="xlsx-grid-wrapper"
          style={{ zoom: zoom }}
        >
          <table className="xlsx-grid">
            <thead>
              <tr>
                <th className="xlsx-corner-cell" onClick={handleSelectAll}></th>
                {Array.from({ length: colCount }, (_, i) => (
                  <th
                    key={i}
                    className={`xlsx-column-header${selection.selectedCols.includes(i) ? ' selected' : ''}`}
                    onClick={(e) => handleColumnHeaderClick(i, e)}
                  >
                    {getColumnLabel(i)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheetData.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  <td
                    className={`xlsx-row-header${selection.selectedRows.includes(rowIdx) ? ' selected' : ''}`}
                    onClick={(e) => handleRowHeaderClick(rowIdx, e)}
                  >
                    {rowIdx + 1}
                  </td>
                  {Array.from({ length: colCount }, (_, colIdx) => (
                    <td
                      key={colIdx}
                      className={`xlsx-cell ${getCellSelectionClass(rowIdx, colIdx)}`}
                      onMouseDown={(e) => handleCellMouseDown(rowIdx, colIdx, e)}
                      onMouseEnter={() => handleCellMouseEnter(rowIdx, colIdx)}
                    >
                      {formatCellValue(row[colIdx])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {sheetNames.length > 1 && (
        <div className="xlsx-sheet-tabs">
          {sheetNames.map((name, idx) => (
            <button
              key={name}
              className={`xlsx-sheet-tab${idx === currentSheet ? ' active' : ''}`}
              onClick={() => setCurrentSheet(idx)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default XlsxViewer;
