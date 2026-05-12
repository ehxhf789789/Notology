/**
 * NasFolderBrowser — modal for browsing the NAS tree directly.
 *
 * Use case: the user remembers where their vault lives but it isn't in the
 * discovery cache (deep nesting beyond max scan depth, or an old vault that
 * was never auto-discovered). They navigate to it manually and either open
 * it (if it has `.notology/`) or create a new vault inside the folder.
 *
 * Single-pane layout: breadcrumb at the top, child list below, action row
 * at the bottom. Each child fetch is one PROPFIND on the parent + one per
 * sub-collection to detect vault markers; we keep the depth at one to stay
 * snappy on Synology.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Folder, FolderOpen, Package, ChevronRight, X, Plus, Check } from 'lucide-react';
import * as conn from '../connectionCommands';
import { useEscapeKey } from '../../shared/useEscapeKey';

/**
 * Two modes:
 *  - "explore" (default): full browser. Vault folders show 열기 button,
 *    footer has inline create form, surfaces both `onVaultOpen` and
 *    `onCreateVault` callbacks.
 *  - "pick": location picker. No 열기 buttons, no inline create — single
 *    "이 위치 사용" footer button that calls `onPickPath` with the current
 *    breadcrumb path. Used by the standalone "보관소 생성" modal so the
 *    user can choose where to create.
 */
interface BaseProps {
  initialPath?: string;
  onClose: () => void;
}

interface ExploreProps extends BaseProps {
  mode?: 'explore';
  onVaultOpen: (remotePath: string) => Promise<void>;
  onCreateVault: (parentPath: string, name: string) => Promise<void>;
}

interface PickProps extends BaseProps {
  mode: 'pick';
  onPickPath: (path: string) => void;
}

type Props = ExploreProps | PickProps;

export function NasFolderBrowser(props: Props) {
  const { initialPath, onClose } = props;
  const mode = props.mode ?? 'explore';
  useEscapeKey(onClose);
  const [currentPath, setCurrentPath] = useState(initialPath || '/');
  const [listing, setListing] = useState<conn.NasFolderListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError('');
    try {
      const result = await conn.browseNasFolder(path);
      setListing(result);
      setCurrentPath(result.path);
    } catch (e: any) {
      setError(e?.toString() || '폴더를 불러올 수 없습니다');
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(initialPath || '/');
  }, [initialPath, load]);

  const breadcrumbs = useMemo(() => {
    if (currentPath === '/' || currentPath === '') return [{ label: '/', path: '/' }];
    const parts = currentPath.split('/').filter(Boolean);
    const crumbs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }, [currentPath]);

  const navigateTo = useCallback((path: string) => {
    if (path !== currentPath) load(path);
  }, [currentPath, load]);

  const handleEnterVault = useCallback(async (path: string) => {
    if (mode !== 'explore') return;
    setError('');
    try {
      await (props as ExploreProps).onVaultOpen(path);
    } catch (e: any) {
      setError(e?.toString() || '보관소를 열 수 없습니다');
    }
  }, [mode, props]);

  const handleCreate = useCallback(async () => {
    if (mode !== 'explore') return;
    const name = createName.trim();
    if (!name) return;
    setCreateBusy(true);
    setError('');
    try {
      await (props as ExploreProps).onCreateVault(currentPath, name);
      setCreateName('');
      await load(currentPath);
    } catch (e: any) {
      setError(e?.toString() || '보관소 생성 실패');
    } finally {
      setCreateBusy(false);
    }
  }, [mode, props, createName, currentPath, load]);

  const handlePickPath = useCallback(() => {
    if (mode !== 'pick') return;
    (props as PickProps).onPickPath(currentPath);
  }, [mode, props, currentPath]);

  // Portal to document.body so the fixed-position overlay escapes any
  // ancestor that creates a containing block (e.g. an ancestor with
  // `transform`, `filter`, or `backdrop-filter` would trap a `position:
  // fixed` child to its own box and the backdrop wouldn't cover the viewport).
  return createPortal(
    <div className="nas-browser-overlay" onClick={onClose}>
      <div className="nas-browser-modal" onClick={e => e.stopPropagation()}>
        <div className="nas-browser-header">
          <div className="nas-browser-title">
            {mode === 'pick' ? '보관소를 만들 위치 선택' : 'NAS 보관소 탐색'}
          </div>
          <button className="nas-browser-close" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </div>

        <div className="nas-browser-breadcrumbs">
          {breadcrumbs.map((c, i) => (
            <span key={c.path} className="nas-browser-crumb">
              {i > 0 && <ChevronRight size={12} className="nas-browser-crumb-sep" />}
              <button
                className="nas-browser-crumb-btn"
                onClick={() => navigateTo(c.path)}
                disabled={c.path === currentPath}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>

        <div className="nas-browser-list">
          {loading && <div className="nas-browser-loading">불러오는 중...</div>}
          {!loading && error && <div className="nas-browser-error">{error}</div>}
          {!loading && !error && listing && listing.children.length === 0 && (
            <div className="nas-browser-empty">이 폴더는 비어 있습니다.</div>
          )}
          {!loading && !error && listing && listing.children.map(child => (
            <div
              key={child.path}
              className={`nas-browser-row ${child.isVault ? 'is-vault' : ''}`}
            >
              <button
                className="nas-browser-row-main"
                onClick={() => child.isCollection && navigateTo(child.path)}
                disabled={!child.isCollection}
              >
                <span className="nas-browser-row-icon">
                  {child.isVault ? <Package size={16} /> : child.isCollection ? <Folder size={16} /> : null}
                </span>
                <span className="nas-browser-row-name">{child.name}</span>
                {child.isVault && (
                  <span className="nas-browser-row-tag">보관소</span>
                )}
              </button>
              {mode === 'explore' && child.isVault && (
                <button
                  className="nas-browser-row-action"
                  onClick={() => handleEnterVault(child.path)}
                >
                  <FolderOpen size={14} /> 열기
                </button>
              )}
            </div>
          ))}
        </div>

        {mode === 'explore' ? (
          <div className="nas-browser-footer">
            <div className="nas-browser-footer-label">현재 위치에 보관소 생성:</div>
            <input
              className="nas-input"
              type="text"
              placeholder="보관소 이름 (예: MyNotes)"
              value={createName}
              onChange={e => setCreateName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              disabled={createBusy}
            />
            <button
              className="nas-btn primary"
              onClick={handleCreate}
              disabled={!createName.trim() || createBusy}
            >
              <Plus size={14} /> {createBusy ? '생성 중...' : '생성'}
            </button>
          </div>
        ) : (
          <div className="nas-browser-footer">
            <div className="nas-browser-footer-label">선택된 위치:</div>
            <code className="nas-browser-pick-path">{currentPath}</code>
            <button className="nas-btn" onClick={onClose}>취소</button>
            <button className="nas-btn primary" onClick={handlePickPath}>
              <Check size={14} /> 이 위치 사용
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
