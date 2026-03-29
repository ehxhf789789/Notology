import { useState, useEffect, useCallback, useRef } from 'react';
import { FileWarning, ExternalLink } from 'lucide-react';
import { previewCommands, utilCommands } from '../../../core/services/tauriCommands';

interface HwpViewerProps {
  filePath: string;
  onRustFailed?: (error: string) => void;
}

export function HwpViewer({ filePath, onRustFailed }: HwpViewerProps) {
  const [svgContent, setSvgContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadHwp = async () => {
      try {
        setLoading(true);
        setError(null);

        // Call Rust backend to render HWP to SVG
        const svg = await previewCommands.renderHwpToSvg(filePath);
        setSvgContent(svg);
        setLoading(false);
      } catch (err) {
        console.error('[HwpViewer] Render failed:', err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (onRustFailed) {
          onRustFailed(errorMsg);
        } else {
          setError(errorMsg);
        }
        setLoading(false);
      }
    };

    loadHwp();
  }, [filePath]);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom(prev => Math.min(3, Math.max(0.25, prev + delta)));
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener('wheel', handleWheel, { passive: false });
      return () => container.removeEventListener('wheel', handleWheel);
    }
  }, [handleWheel]);

  const handleOpenExternal = () => {
    utilCommands.openInDefaultApp(filePath);
  };

  if (loading) {
    const isHwpx = filePath.toLowerCase().endsWith('.hwpx');
    return (
      <div className="office-viewer-container hwp-viewer">
        <div className="hwp-loading">{isHwpx ? 'HWPX' : 'HWP'} 렌더링 중...</div>
      </div>
    );
  }

  if (error) {
    const isHwpx = filePath.toLowerCase().endsWith('.hwpx');
    return (
      <div className="office-viewer-container hwp-viewer">
        <div className="hwp-error-container">
          <FileWarning size={48} className="hwp-error-icon" />
          <p className="hwp-error-title">{isHwpx ? 'HWPX' : 'HWP'} 내장 렌더링 실패</p>
          <p className="hwp-error-detail">
            이 {isHwpx ? 'HWPX' : 'HWP'} 파일은 내장 렌더러가 지원하지 않는 형식입니다.
          </p>
          <button className="hwp-open-external-btn" onClick={handleOpenExternal}>
            <ExternalLink size={16} />
            한컴오피스로 열기
          </button>
        </div>
      </div>
    );
  }

  if (!svgContent) {
    return (
      <div className="office-viewer-container hwp-viewer">
        <div className="hwp-error-container">
          <FileWarning size={48} className="hwp-error-icon" />
          <p className="hwp-error-title">문서 내용 없음</p>
          <button className="hwp-open-external-btn" onClick={handleOpenExternal}>
            <ExternalLink size={16} />
            한컴오피스로 열기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="office-viewer-container hwp-viewer">
      <div className="hwp-zoom-indicator">{Math.round(zoom * 100)}%</div>
      <div
        className="hwp-content"
        style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
        dangerouslySetInnerHTML={{ __html: svgContent }}
      />
    </div>
  );
}

export default HwpViewer;
