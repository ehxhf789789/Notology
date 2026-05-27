/**
 * MobileDocViewer — Renders document viewers scaled to fit mobile screen width.
 * Same viewer components as desktop, with CSS transform scaling for proportional fit.
 */
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { Loader2, ExternalLink, AlertCircle } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { previewCommands, utilCommands } from '../../../core/services/tauriCommands';

const DocxViewer = lazy(() => import('../../hover-windows/viewers/docx/DocxViewer').then(m => ({ default: m.DocxViewer })));
const PptxViewer = lazy(() => import('../../hover-windows/viewers/pptx/PptxViewer').then(m => ({ default: m.PptxViewer })));
const XlsxViewer = lazy(() => import('../../hover-windows/viewers/XlsxViewer').then(m => ({ default: m.XlsxViewer })));
const HwpxViewer = lazy(() => import('../../hover-windows/viewers/hwpx/HwpxViewer').then(m => ({ default: m.HwpxViewer })));

interface Props {
  filePath: string;
  fileExt: string;
}

type ViewerState = 'loading' | 'ready' | 'error' | 'unsupported';

export default function MobileDocViewer({ filePath, fileExt }: Props) {
  const [state, setState] = useState<ViewerState>('loading');
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState('');
  const [scale, setScale] = useState(1);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Calculate scale to fit document to screen width
  const updateScale = useCallback(() => {
    if (!wrapperRef.current) return;
    const containerWidth = wrapperRef.current.offsetWidth;
    // Standard A4 page width in the docx viewer is ~816px (8.5in * 96dpi)
    const docWidth = 816;
    if (containerWidth < docWidth) {
      setScale(containerWidth / docWidth);
    } else {
      setScale(1);
    }
  }, []);

  useEffect(() => {
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, [updateScale]);

  // Also update scale after viewer renders
  useEffect(() => {
    if (state === 'ready') {
      setTimeout(updateScale, 100);
    }
  }, [state, updateScale]);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setError('');
    setData(null);

    const ext = fileExt.toLowerCase();

    // Image/PDF — no binary loading needed
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'pdf'].includes(ext)) {
      setState('ready');
      return;
    }

    // Document files — read binary
    if (['docx', 'pptx', 'xlsx', 'hwpx'].includes(ext)) {
      previewCommands.readBinaryFile(filePath).then(bytes => {
        if (cancelled) return;
        setData(new Uint8Array(bytes).buffer);
        setState('ready');
      }).catch(err => {
        if (cancelled) return;
        setError(String(err));
        setState('error');
      });
      return;
    }

    setState('unsupported');
    return () => { cancelled = true; };
  }, [filePath, fileExt]);

  if (state === 'loading') {
    return <div className="mobile-loading"><Loader2 size={24} className="mobile-spinner" /></div>;
  }

  if (state === 'error') {
    return (
      <div className="mobile-file-preview">
        <div className="mobile-file-preview-card">
          <AlertCircle size={40} style={{ color: 'var(--c-red)' }} />
          <div className="mobile-file-preview-name">파일을 열 수 없습니다</div>
          <div style={{ fontSize: 12, color: 'var(--tx-3)', textAlign: 'center' }}>{error}</div>
          <button className="mobile-file-preview-btn" onClick={() => utilCommands.openInDefaultApp(filePath)}>
            <ExternalLink size={18} /> 기본 앱으로 열기
          </button>
        </div>
      </div>
    );
  }

  if (state === 'unsupported') {
    return (
      <div className="mobile-file-preview">
        <div className="mobile-file-preview-card">
          <div className="mobile-file-preview-ext">{fileExt.toUpperCase()}</div>
          <div className="mobile-file-preview-name">{filePath.split(/[/\\]/).pop()}</div>
          <button className="mobile-file-preview-btn" onClick={() => utilCommands.openInDefaultApp(filePath)}>
            <ExternalLink size={18} /> 기본 앱으로 열기
          </button>
        </div>
      </div>
    );
  }

  const ext = fileExt.toLowerCase();

  // Image
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
    return (
      <div className="mobile-doc-viewer-wrapper" ref={wrapperRef}>
        <img src={convertFileSrc(filePath)} alt="" style={{ maxWidth: '100%', borderRadius: 10, margin: '16px auto', display: 'block' }} />
      </div>
    );
  }

  // PDF — WebView2 cannot render PDF in iframe via asset protocol.
  // Show file info card with "open in default app" button.
  if (ext === 'pdf') {
    return (
      <div className="mobile-file-preview">
        <div className="mobile-file-preview-card">
          <div className="mobile-file-preview-ext">PDF</div>
          <div className="mobile-file-preview-name">{filePath.split(/[/\\]/).pop()}</div>
          <button className="mobile-file-preview-btn" onClick={() => utilCommands.openInDefaultApp(filePath)}>
            <ExternalLink size={18} /> PDF 뷰어로 열기
          </button>
        </div>
      </div>
    );
  }

  // Document viewers — scale to fit
  if (data) {
    return (
      <div className="mobile-doc-viewer-wrapper" ref={wrapperRef}>
        <div style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top center',
          width: scale < 1 ? `${100 / scale}%` : '100%',
        }}>
          <Suspense fallback={<div className="mobile-loading"><Loader2 size={24} className="mobile-spinner" /></div>}>
            {ext === 'docx' && <DocxViewer data={data} />}
            {ext === 'pptx' && <PptxViewer data={data} />}
            {ext === 'xlsx' && <XlsxViewer data={data} />}
            {ext === 'hwpx' && <HwpxViewer data={data} />}
          </Suspense>
        </div>
      </div>
    );
  }

  return null;
}
