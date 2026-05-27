/**
 * NoteEditorView — Mobile note renderer (Craft/Bear quality).
 * Read-first design: TipTap editable={false} with premium styling.
 * Non-markdown files → system default app with "open externally" button.
 * Sketch notes → SVG preview with pinch-zoom.
 */
import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { Loader2, MoreVertical, ExternalLink, Tag, MessageSquare, Share2 } from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import { fileCommands, utilCommands } from '../../../core/services/tauriCommands';
import { setPendingSave, awaitPendingSave } from '../utils/pendingSaveRegistry';
import { getEditorExtensions } from '../../../core/editor/editorConfig';
import { preprocessWikiLinks } from '../../../core/utils/wikiLinkPreprocess';
import { parseFrontmatter } from '../../../core/utils/frontmatter';
import { useFileTreeStore } from '../../../core/stores/fileTreeStore';
import { fileLookupActions } from '../../../core/stores/fileLookupStore';
import { MobileMetadataSheet } from '../components/MobileMetadataSheet';
import { ActionSheet } from '../components/common/ActionSheet';
import { shareText } from '../../shared/share';
import { exportAsMarkdown, exportAsText } from '../../shared/noteExport';
// Lazy-load document viewer wrapper
const MobileDocViewer = lazy(() => import('../components/MobileDocViewer'));

interface Props {
  notePath: string;
  onNavigateToNote?: (notePath: string, name: string) => void;
}

// File types that should open externally
const EXTERNAL_EXTENSIONS = new Set([
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt',
  'hwpx', 'hwp', 'pdf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp',
  'mp4', 'mp3', 'wav', 'avi', 'mov',
  'zip', 'rar', '7z', 'tar', 'gz',
]);

export default function NoteEditorView({ notePath, onNavigateToNote }: Props) {
  const [loading, setLoading] = useState(true);
  const [isSketch, setIsSketch] = useState(false);
  const [sketchData, setSketchData] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showMetadata, setShowMetadata] = useState(false);
  const [showShareSheet, setShowShareSheet] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const frontmatterRef = useRef<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isLoadingRef = useRef(true);
  const fileTree = useFileTreeStore(s => s.fileTree);
  const onNavigateRef = useRef(onNavigateToNote);
  onNavigateRef.current = onNavigateToNote;

  // Check if this is a non-markdown file
  const fileExt = useMemo(() => notePath.split('.').pop()?.toLowerCase() ?? '', [notePath]);
  const isNonMarkdown = fileExt !== 'md';

  // Resolve file path — pass current notePath as context for _att folder lookup
  const notePathRef = useRef(notePath);
  notePathRef.current = notePath;

  const resolveFilePathFn = (name: string): string | null => {
    const noteRes = fileLookupActions.resolveNotePath(name);
    if (noteRes) return noteRes;
    // Try with current notePath context
    const attRes = fileLookupActions.resolveAttachmentPath(name, notePathRef.current);
    if (attRes) return attRes;
    // Try global attachment lookup without context
    const globalAtt = fileLookupActions.resolveAttachmentPath(name);
    if (globalAtt) return globalAtt;
    console.warn('[MobileEditor] Cannot resolve:', name, 'from notePath:', notePathRef.current);
    return null;
  };

  // Extensions that have built-in viewers (open inside app)
  const VIEWABLE_EXTS = new Set([
    'md', 'docx', 'pptx', 'xlsx', 'hwpx', 'pdf',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp',
  ]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  const handleLinkClick = useCallback((name: string) => {
    const resolved = resolveFilePathFn(name);
    if (!resolved) {
      showToast(`"${name}" 을(를) 찾을 수 없습니다`);
      return;
    }
    const ext = resolved.split('.').pop()?.toLowerCase() ?? '';
    // PDF: open directly in external app (mobile can't render PDF inline)
    if (ext === 'pdf') {
      utilCommands.openInDefaultApp(resolved).catch((e) => {
        console.error('[link] open PDF failed:', e);
        showToast('PDF 열기 실패');
      });
      return;
    }
    if (VIEWABLE_EXTS.has(ext)) {
      const displayName = name.replace(/\.md$/, '');
      showToast(`${displayName} 열기`);
      onNavigateRef.current?.(resolved, name);
    } else {
      utilCommands.openInDefaultApp(resolved).catch(console.error);
    }
  }, [showToast]);

  const editor = useEditor({
    extensions: getEditorExtensions({
      placeholder: '내용을 입력하세요...',
      onClickLink: handleLinkClick,
      onContextMenu: () => {},
      resolveLink: (name: string) => !!resolveFilePathFn(name),
      getNoteType: (name: string) => {
        const m = name.match(/^(NOTE|MTG|SEM|EVENT|CONTACT|PAPER|THEO|DATA|OFA|ADM|SETUP|SKETCH|TASK|LIT)-/);
        return m ? m[1].toLowerCase() : null;
      },
      isAttachment: (name: string) => !!fileLookupActions.resolveAttachmentPath(name, notePath),
      getFileTree: () => fileTree,
      notePath,
      resolveFilePath: resolveFilePathFn,
    }),
    content: '',
    editable: true,
    editorProps: {
      attributes: {
        // 2026-05-25 (HanBin) — exclude from Tab focus chain. See
        // editorPool.ts for the same rule + rationale.
        tabindex: '-1',
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (isLoadingRef.current) return;
      setDirty(true);
      scheduleSave(ed);
    },
  });

  // Editor is always editable (WYSIWYG like desktop)

  // Load content
  useEffect(() => {
    let cancelled = false;
    isLoadingRef.current = true;
    setLoading(true);
    setIsSketch(false);
    setSketchData(null);


    if (isNonMarkdown) {
      // Non-markdown files: rendered by MobileDocViewer (docx/pptx/xlsx/hwpx/pdf/images)
      // or opened externally for unsupported formats
      setLoading(false);
      isLoadingRef.current = false;
      return;
    }

    awaitPendingSave(notePath).then(() => fileCommands.readFile(notePath)).then(content => {
      if (cancelled) return;
      frontmatterRef.current = content.frontmatter;

      let fm: any = null;
      if (content.frontmatter) {
        try { fm = parseFrontmatter(content.frontmatter); } catch { fm = null; }
      }
      const sketch = !!(fm?.sketch || fm?.canvas) ||
        (!content.frontmatter && content.body.trimStart().startsWith('{') && content.body.includes('"nodes":'));

      if (sketch) {
        setIsSketch(true);
        try { setSketchData(JSON.parse(content.body)); } catch { setSketchData(null); }
      } else if (editor) {
        editor.commands.setContent(preprocessWikiLinks(content.body));
        // Force decoration refresh after fileLookup index is ready
        // WikiLink decorations depend on resolveLink which needs fileLookup
        setTimeout(() => {
          if (editor && !editor.isDestroyed) {
            // Dispatch empty transaction to trigger decoration recalculation
            editor.view.dispatch(editor.state.tr);
          }
        }, 300);
      }

      setLoading(false);
      setTimeout(() => { isLoadingRef.current = false; }, 150);
    }).catch(e => {
      console.error('[MobileEditor] Failed to load:', e);
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [notePath, editor, isNonMarkdown]);

  const scheduleSave = useCallback((ed: any) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      try {
        const md = (ed.storage as any).markdown?.getMarkdown() ?? '';
        const p = fileCommands.writeFile(notePath, frontmatterRef.current, md).catch(console.error);
        setPendingSave(notePath, p as Promise<void>);
        setDirty(false);
      } catch { /* ignore */ }
    }, 1500);
  }, [notePath]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (dirty && editor) {
        try {
          const md = (editor.storage as any).markdown?.getMarkdown() ?? '';
          const p = fileCommands.writeFile(notePath, frontmatterRef.current, md).catch(() => {});
          setPendingSave(notePath, p as Promise<void>);
        } catch { /* ignore */ }
      }
    };
  }, [notePath, dirty, editor]);

  // Long-press on wiki links → share/open ActionSheet
  const [attachmentSheet, setAttachmentSheet] = useState<{ name: string; path: string } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleEditorTouchStart = useCallback((e: React.TouchEvent) => {
    const target = (e.target as HTMLElement).closest('[data-wiki-link]');
    if (!target) return;
    const fileName = target.getAttribute('data-wiki-link');
    if (!fileName) return;

    longPressTimerRef.current = setTimeout(() => {
      // Suppress text selection
      e.preventDefault();
      const resolved = resolveFilePathFn(fileName);
      if (resolved) {
        setAttachmentSheet({ name: fileName, path: resolved });
      }
    }, 500);
  }, []);

  const handleEditorTouchEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    return () => { if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current); };
  }, []);

  // Wiki link single tap
  const handleEditorClick = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('[data-wiki-link]');
    if (target) {
      e.preventDefault();
      e.stopPropagation();
      const fileName = target.getAttribute('data-wiki-link');
      if (fileName) handleLinkClick(fileName);
    }
  }, [handleLinkClick]);

  const handleOpenExternal = useCallback(() => {
    utilCommands.openInDefaultApp(notePath).catch(console.error);
    setShowMenu(false);
  }, [notePath]);

  if (loading) {
    return <div className="mobile-loading"><Loader2 size={24} className="mobile-spinner" /></div>;
  }

  // Non-markdown file → viewer preview + open-externally button
  if (isNonMarkdown) {
    const fileName = notePath.split(/[/\\]/).pop() ?? '';
    return (
      <div className="mobile-editor">
        <div className="note-read-view-header">
          <div className="note-read-view-header-title">{fileName}</div>
          <div className="note-read-view-header-actions">
            <button className="note-read-view-header-btn" onClick={handleOpenExternal} title="외부 앱으로 열기">
              <ExternalLink size={18} />
            </button>
          </div>
        </div>
        <div className="mobile-editor-scroll">
          <Suspense fallback={<div className="mobile-loading"><Loader2 size={24} className="mobile-spinner" /></div>}>
            <MobileDocViewer filePath={notePath} fileExt={fileExt} />
          </Suspense>
        </div>
      </div>
    );
  }

  // Sketch note
  if (isSketch) {
    return <SketchPreview data={sketchData} />;
  }

  // Markdown note — Read view with edit toggle
  return (
    <div className="mobile-editor" onClick={handleEditorClick}
      onTouchStart={handleEditorTouchStart} onTouchEnd={handleEditorTouchEnd} onTouchCancel={handleEditorTouchEnd}>
      {/* Minimal toolbar — WYSIWYG, no mode toggle */}
      <div className="note-read-view-header">
        <div className="note-read-view-header-title">
          {dirty && <span style={{ color: 'var(--c-blue)' }}>*</span>}
        </div>
        <div className="note-read-view-header-actions">
          <button className="note-read-view-header-btn" onClick={() => setShowMetadata(true)} title="태그/메모">
            <Tag size={16} />
          </button>
          <button className="note-read-view-header-btn" onClick={() => setShowMenu(!showMenu)}>
            <MoreVertical size={16} />
          </button>
        </div>
      </div>

      {/* Menu popup */}
      {showMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 50 }} onClick={() => setShowMenu(false)} />
          <div className="mobile-note-menu">
            <button className="mobile-note-menu-item" onClick={() => { setShowShareSheet(true); setShowMenu(false); }}>
              <Share2 size={16} /> 공유
            </button>
            <button className="mobile-note-menu-item" onClick={handleOpenExternal}>
              <ExternalLink size={16} /> 외부 앱으로 열기
            </button>
          </div>
        </>
      )}

      {/* Share Action Sheet */}
      {showShareSheet && (
        <ActionSheet
          title="공유 형식 선택"
          actions={[
            {
              label: 'Markdown으로 공유',
              onPress: async () => {
                const md = await exportAsMarkdown(notePath);
                await shareText(md, notePath.split(/[/\\]/).pop()?.replace('.md', '') ?? '노트');
                showToast('Markdown으로 공유됨');
                setShowShareSheet(false);
              },
            },
            {
              label: '텍스트로 공유',
              onPress: async () => {
                const txt = await exportAsText(notePath);
                await shareText(txt, notePath.split(/[/\\]/).pop()?.replace('.md', '') ?? '노트');
                showToast('텍스트로 공유됨');
                setShowShareSheet(false);
              },
            },
            {
              label: '파일명 복사',
              onPress: async () => {
                const name = notePath.split(/[/\\]/).pop() ?? '';
                await navigator.clipboard.writeText(name);
                showToast('파일명이 복사되었습니다');
                setShowShareSheet(false);
              },
            },
          ]}
          onCancel={() => setShowShareSheet(false)}
        />
      )}

      {/* Metadata bottom sheet */}
      <MobileMetadataSheet
        open={showMetadata}
        onClose={() => setShowMetadata(false)}
        notePath={notePath}
        frontmatterYaml={frontmatterRef.current}
      />

      {/* Editor content — uses same .tiptap-editor class as desktop */}
      <div className="mobile-editor-scroll">
        <EditorContent editor={editor} className="tiptap-editor" />
      </div>

      {/* Attachment long-press ActionSheet */}
      {attachmentSheet && (
        <ActionSheet
          title={attachmentSheet.name}
          actions={[
            {
              label: '공유 / 외부 앱으로 열기',
              onPress: () => {
                utilCommands.openInDefaultApp(attachmentSheet.path).catch((e) => {
                  console.error('[share] open failed:', e);
                  showToast('파일 열기 실패');
                });
                setAttachmentSheet(null);
              },
            },
          ]}
          onCancel={() => setAttachmentSheet(null)}
        />
      )}

      {/* Toast notification */}
      {toast && <div className="mobile-toast">{toast}</div>}
    </div>
  );
}

/* ── Sketch Preview — desktop-quality read-only viewer ── */
const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','bmp']);

/* CSS variable → concrete color mapping for SVG (which can't resolve CSS vars) */
const CSS_VAR_COLOR_MAP: Record<string, { light: string; dark: string }> = {
  'var(--sketch-default)': { light: '#e0e0e0', dark: '#3a3a4a' },
  'var(--sketch-blue)':    { light: '#dbeafe', dark: '#1e3a5f' },
  'var(--sketch-green)':   { light: '#dcfce7', dark: '#1a3a2a' },
  'var(--sketch-red)':     { light: '#fee2e2', dark: '#4a1a1a' },
  'var(--sketch-purple)':  { light: '#f3e8ff', dark: '#2d1a4a' },
  'var(--sketch-orange)':  { light: '#ffedd5', dark: '#4a2a0a' },
};

/* Anchor point calculation (matches desktop getShapeAnchorPoint) */
function sketchAnchor(node: any, side: string): { x: number; y: number } {
  const w = node.width, h = node.height;
  const shape = node.shape || 'process';
  let lx = w / 2, ly = h / 2;

  if (shape === 'io') {
    const skew = w * 0.15;
    switch (side) {
      case 'top': lx = (skew + w) / 2; ly = 0; break;
      case 'bottom': lx = w * 0.85 / 2; ly = h; break;
      case 'left': lx = skew / 2; ly = h / 2; break;
      case 'right': lx = (w + w * 0.85) / 2; ly = h / 2; break;
    }
  } else {
    switch (side) {
      case 'top': lx = w / 2; ly = 0; break;
      case 'bottom': lx = w / 2; ly = h; break;
      case 'left': lx = 0; ly = h / 2; break;
      case 'right': lx = w; ly = h / 2; break;
    }
  }
  return { x: node.x + lx, y: node.y + ly };
}

/* Bezier edge path (matches desktop getEdgePath) */
function sketchEdgePath(edge: any, fromNode: any, toNode: any): string {
  const from = sketchAnchor(fromNode, edge.fromSide || 'right');
  const to = sketchAnchor(toNode, edge.toSide || 'left');
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const off = Math.min(dist * 0.5, 100);
  let cp1x = from.x, cp1y = from.y, cp2x = to.x, cp2y = to.y;
  switch (edge.fromSide) {
    case 'right': cp1x += off; break; case 'left': cp1x -= off; break;
    case 'bottom': cp1y += off; break; case 'top': cp1y -= off; break;
  }
  switch (edge.toSide) {
    case 'right': cp2x += off; break; case 'left': cp2x -= off; break;
    case 'bottom': cp2y += off; break; case 'top': cp2y -= off; break;
  }
  return `M ${from.x} ${from.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${to.x} ${to.y}`;
}

function SketchPreview({ data }: { data: any }) {
  const gestureRef = useRef<any>(null);
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  // Filter valid nodes
  const validNodes = useMemo(() =>
    (data?.nodes || []).filter((n: any) =>
      typeof n.x === 'number' && typeof n.y === 'number' &&
      typeof n.width === 'number' && typeof n.height === 'number' &&
      !isNaN(n.x) && !isNaN(n.y) && n.width > 0 && n.height > 0
    ), [data]);

  // Calculate content bounds
  const contentBounds = useMemo(() => {
    if (!validNodes.length) return { minX: 0, minY: 0, w: 100, h: 100 };
    const pad = 40;
    const minX = Math.min(...validNodes.map((n: any) => n.x)) - pad;
    const minY = Math.min(...validNodes.map((n: any) => n.y)) - pad;
    const maxX = Math.max(...validNodes.map((n: any) => n.x + n.width)) + pad;
    const maxY = Math.max(...validNodes.map((n: any) => n.y + n.height)) + pad;
    return { minX, minY, w: Math.max(maxX - minX, 1), h: Math.max(maxY - minY, 1) };
  }, [validNodes]);

  // ViewBox-based zoom: manipulate viewBox instead of CSS transform
  // This avoids Android WebView CSS transform rendering issues
  const [viewBox, setViewBox] = useState(contentBounds);
  useEffect(() => { setViewBox(contentBounds); }, [contentBounds]);

  if (!validNodes.length) {
    return <div className="mobile-editor mobile-editor--sketch"><div className="mobile-editor-sketch-notice">스케치 데이터 없음</div></div>;
  }

  const nodeMap = new Map<string, any>(validNodes.map((n: any) => [n.id, n]));

  const resolveColor = (c?: string) => {
    if (!c) return isDark ? '#3a3a4a' : '#e0e0e0';
    if (c.startsWith('var(')) {
      const mapped = CSS_VAR_COLOR_MAP[c];
      return mapped ? (isDark ? mapped.dark : mapped.light) : (isDark ? '#3a3a4a' : '#e0e0e0');
    }
    return c;
  };

  const textColor = isDark ? '#e0e0e0' : '#333';
  const subTextColor = isDark ? '#aaa' : '#666';
  const strokeColor = isDark ? '#555' : '#aaa';
  const fileBg = isDark ? '#2a2a3a' : '#fff';
  const fileStroke = isDark ? '#444' : '#ddd';

  const handleTouchStart = (e: React.TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      gestureRef.current = { startDist: Math.sqrt(dx*dx+dy*dy), startVB: { ...viewBox }, startX: 0, startY: 0 };
    } else if (e.touches.length === 1) {
      gestureRef.current = { startDist: 0, startVB: { ...viewBox }, startX: e.touches[0].clientX, startY: e.touches[0].clientY };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();
    if (!gestureRef.current) return;
    const g = gestureRef.current;
    if (e.touches.length === 2 && g.startDist > 0) {
      // Pinch zoom: scale viewBox size (smaller viewBox = zoom in)
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const dist = Math.sqrt(dx*dx+dy*dy);
      const ratio = g.startDist / dist; // inverse: pinch out = smaller viewBox = zoom in
      const clamped = Math.max(0.2, Math.min(5, ratio));
      const cx = g.startVB.minX + g.startVB.w / 2;
      const cy = g.startVB.minY + g.startVB.h / 2;
      const newW = g.startVB.w * clamped;
      const newH = g.startVB.h * clamped;
      setViewBox({ minX: cx - newW / 2, minY: cy - newH / 2, w: newW, h: newH });
    } else if (e.touches.length === 1 && g.startDist === 0) {
      // Pan: move viewBox origin (inverse direction)
      const moveX = (e.touches[0].clientX - g.startX) * (g.startVB.w / (window.innerWidth || 360));
      const moveY = (e.touches[0].clientY - g.startY) * (g.startVB.h / (window.innerHeight || 640));
      setViewBox({ ...g.startVB, minX: g.startVB.minX - moveX, minY: g.startVB.minY - moveY });
    }
  };

  /* Strip HTML to plain text for SVG <text> rendering (no foreignObject — avoids WebView crash) */
  const stripHtml = (html: string): string =>
    html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim();

  /* Render text as native SVG <text> — no foreignObject needed */
  const renderNodeText = (n: any, x: number, y: number, w: number, h: number) => {
    if (!n.text) return null;
    const plain = stripHtml(n.text);
    if (!plain) return null;
    // Split into lines and truncate
    const lines = plain.split('\n').filter(Boolean).slice(0, Math.floor(h / 16));
    const startY = y + Math.max((h - lines.length * 16) / 2, 4) + 12;
    return (
      <g>
        {lines.map((line: string, i: number) => (
          <text key={i} x={x + w / 2} y={startY + i * 16} fontSize={12} fill={textColor}
            textAnchor="middle" dominantBaseline="middle"
            style={{ pointerEvents: 'none' }}>
            {line.length > Math.floor(w / 7) ? line.slice(0, Math.floor(w / 7)) + '…' : line}
          </text>
        ))}
      </g>
    );
  };

  const renderNode = (n: any) => {
    const w = n.width, h = n.height;
    const fill = resolveColor(n.color);
    const isGroup = n.type === 'group' || n.isGroup;
    const isFile = n.type === 'file';
    const shape = n.shape || 'process';

    if (isGroup) {
      const gc = n.color || '#4f46e5';
      return (
        <g key={n.id}>
          <rect x={n.x} y={n.y} width={w} height={h} rx={8} fill={`${gc}18`} stroke={gc} strokeWidth={2} />
          {n.groupLabel && (
            <text x={n.x + 8} y={n.y + 16} fontSize={13} fontWeight={600} fill={gc} opacity={0.8}>{n.groupLabel}</text>
          )}
        </g>
      );
    }

    if (isFile) {
      const fileName = n.fileName || n.text || '';
      return (
        <g key={n.id}>
          <rect x={n.x} y={n.y} width={w} height={h} rx={8} fill={fileBg} stroke={fileStroke} strokeWidth={1} />
          <text x={n.x + w/2} y={n.y + h/2 - 8} fontSize={20} textAnchor="middle">📄</text>
          <text x={n.x + w/2} y={n.y + h/2 + 14} fontSize={10} fill={subTextColor}
            textAnchor="middle" dominantBaseline="middle">
            {fileName.length > 15 ? fileName.slice(0, 15) + '…' : fileName}
          </text>
        </g>
      );
    }

    if (shape === 'decision') {
      const pts = `${n.x+w/2},${n.y} ${n.x+w},${n.y+h/2} ${n.x+w/2},${n.y+h} ${n.x},${n.y+h/2}`;
      return (
        <g key={n.id}>
          <polygon points={pts} fill={fill} stroke={strokeColor} strokeWidth={1.5} />
          {renderNodeText(n, n.x+w*0.15, n.y+h*0.15, w*0.7, h*0.7)}
        </g>
      );
    }
    if (shape === 'io') {
      const pts = `${n.x+w*0.15},${n.y} ${n.x+w},${n.y} ${n.x+w*0.85},${n.y+h} ${n.x},${n.y+h}`;
      return (
        <g key={n.id}>
          <polygon points={pts} fill={fill} stroke={strokeColor} strokeWidth={1.5} />
          {renderNodeText(n, n.x+w*0.1, n.y+4, w*0.8, h-8)}
        </g>
      );
    }
    if (shape === 'terminal') {
      return (
        <g key={n.id}>
          <rect x={n.x} y={n.y} width={w} height={h} rx={h/2} fill={fill} stroke={strokeColor} strokeWidth={1} />
          {renderNodeText(n, n.x+8, n.y+4, w-16, h-8)}
        </g>
      );
    }
    if (shape === 'database') {
      const ry = Math.min(h * 0.15, 20);
      return (
        <g key={n.id}>
          <ellipse cx={n.x+w/2} cy={n.y+ry} rx={w/2} ry={ry} fill={fill} stroke={strokeColor} strokeWidth={1} />
          <rect x={n.x} y={n.y+ry} width={w} height={h-2*ry} fill={fill} stroke="none" />
          <line x1={n.x} y1={n.y+ry} x2={n.x} y2={n.y+h-ry} stroke={strokeColor} strokeWidth={1} />
          <line x1={n.x+w} y1={n.y+ry} x2={n.x+w} y2={n.y+h-ry} stroke={strokeColor} strokeWidth={1} />
          <ellipse cx={n.x+w/2} cy={n.y+h-ry} rx={w/2} ry={ry} fill={fill} stroke={strokeColor} strokeWidth={1} />
          {renderNodeText(n, n.x+6, n.y+ry+4, w-12, h-2*ry-8)}
        </g>
      );
    }
    if (shape === 'subroutine') {
      const inset = 8;
      return (
        <g key={n.id}>
          <rect x={n.x} y={n.y} width={w} height={h} rx={2} fill={fill} stroke={strokeColor} strokeWidth={1} />
          <line x1={n.x+inset} y1={n.y} x2={n.x+inset} y2={n.y+h} stroke={strokeColor} strokeWidth={1} />
          <line x1={n.x+w-inset} y1={n.y} x2={n.x+w-inset} y2={n.y+h} stroke={strokeColor} strokeWidth={1} />
          {renderNodeText(n, n.x+inset+4, n.y+4, w-2*inset-8, h-8)}
        </g>
      );
    }

    // Default: process (rectangle)
    return (
      <g key={n.id}>
        <rect x={n.x} y={n.y} width={w} height={h} rx={4} fill={fill} stroke={strokeColor} strokeWidth={1} />
        {renderNodeText(n, n.x+6, n.y+4, w-12, h-8)}
      </g>
    );
  };

  const sortedNodes = [...validNodes].sort((a: any, b: any) => {
    const aG = (a.type === 'group' || a.isGroup) ? 0 : 1;
    const bG = (b.type === 'group' || b.isGroup) ? 0 : 1;
    return aG - bG;
  });

  const edgeColor = isDark ? '#666' : '#888';

  return (
    <div
      className="mobile-editor mobile-sketch-preview"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={() => gestureRef.current = null}
    >
      <svg
        viewBox={`${viewBox.minX} ${viewBox.minY} ${viewBox.w} ${viewBox.h}`}
        className="mobile-sketch-svg"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker id="ah" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
            <polygon points="0 0,10 3.5,0 7" fill={edgeColor}/>
          </marker>
        </defs>
        {(data.edges || []).map((e: any) => {
          const f = nodeMap.get(e.fromNode), t = nodeMap.get(e.toNode);
          if (!f || !t) return null;
          const d = sketchEdgePath(e, f, t);
          return <path key={e.id} d={d} fill="none" stroke={resolveColor(e.color) || edgeColor} strokeWidth={2} markerEnd="url(#ah)" />;
        })}
        {sortedNodes.map(renderNode)}
      </svg>
      <div className="mobile-editor-sketch-notice">읽기 전용 · 핀치로 확대/축소</div>
    </div>
  );
}
