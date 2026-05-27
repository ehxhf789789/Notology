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
 *
 * 5.0.6k-2 (2026-05-17, HanBin) — full i18n + design-system primitives.
 * Replaced ad-hoc <button className="nas-btn"> / <input className="nas-input">
 * with Button/Input primitives and routed every Korean-only label through t().
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Folder, FolderOpen, Package, PackagePlus, ChevronRight, X, Plus, Check } from 'lucide-react';
import * as conn from '../connectionCommands';
import { useEscapeKey } from '../../shared/useEscapeKey';
import { t } from '../../../core/utils/i18n';
import { useLanguage } from '../../../core/stores/settingsStore';
import { Button, Input } from '../../../design-system/components';

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
  /**
   * Called when the user picks a legacy (non-Notology) folder via the
   * "마이그레이션해서 열기" button. Implementation should bootstrap
   * `.notology/` on NAS (e.g. via `sync_v2_create_vault`) and then enter
   * the vault so the auto-detect modal can kick off the repair flow.
   */
  onMigrateAndOpen?: (remotePath: string, legacyKind: 'obsidian' | 'plainMd') => Promise<void>;
}

interface PickProps extends BaseProps {
  mode: 'pick';
  onPickPath: (path: string) => void;
}

type Props = ExploreProps | PickProps;

export function NasFolderBrowser(props: Props) {
  const lang = useLanguage();
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
      setError(e?.toString() || t('nasBrowserLoadFailed', lang));
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, [lang]);

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
      setError(e?.toString() || t('nasBrowserOpenFailed', lang));
    }
  }, [mode, props, lang]);

  const handleMigrateLegacy = useCallback(async (
    path: string,
    legacyKind: 'obsidian' | 'plainMd',
  ) => {
    if (mode !== 'explore') return;
    const exploreProps = props as ExploreProps;
    if (!exploreProps.onMigrateAndOpen) return;
    setError('');
    try {
      await exploreProps.onMigrateAndOpen(path, legacyKind);
    } catch (e: any) {
      setError(e?.toString() || t('nasBrowserMigrateFailed', lang));
    }
  }, [mode, props, lang]);

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
      setError(e?.toString() || t('nasBrowserCreateFailed', lang));
    } finally {
      setCreateBusy(false);
    }
  }, [mode, props, createName, currentPath, load, lang]);

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
            {mode === 'pick' ? t('nasBrowserTitlePick', lang) : t('nasBrowserTitleExplore', lang)}
          </div>
          <button
            className="nas-browser-close"
            onClick={onClose}
            aria-label={t('nasBrowserClose', lang)}
            title={t('nasBrowserClose', lang)}
          >
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
          {loading && <div className="nas-browser-loading">{t('nasBrowserLoading', lang)}</div>}
          {!loading && error && <div className="nas-browser-error">{error}</div>}
          {!loading && !error && listing && listing.children.length === 0 && (
            <div className="nas-browser-empty">{t('nasBrowserEmpty', lang)}</div>
          )}
          {!loading && !error && listing && listing.children.map(child => {
            const legacyKind = child.legacyKind;
            const isLegacy = !child.isVault && !!legacyKind;
            const legacyLabelKey = legacyKind === 'obsidian'
              ? 'nasBrowserLegacyBadgeObsidian'
              : 'nasBrowserLegacyBadgePlainMd';
            const rowClass = `nas-browser-row ${child.isVault ? 'is-vault' : ''} ${isLegacy ? 'is-legacy' : ''}`.trim();
            return (
              <div key={child.path} className={rowClass}>
                <button
                  className="nas-browser-row-main"
                  onClick={() => child.isCollection && navigateTo(child.path)}
                  disabled={!child.isCollection}
                >
                  <span className="nas-browser-row-icon">
                    {child.isVault
                      ? <Package size={16} />
                      : isLegacy
                        ? <PackagePlus size={16} />
                        : child.isCollection ? <Folder size={16} /> : null}
                  </span>
                  <span className="nas-browser-row-name">{child.name}</span>
                  {child.isVault && (
                    <span className="nas-browser-row-tag">{t('nasBrowserVaultBadge', lang)}</span>
                  )}
                  {isLegacy && (
                    <span className="nas-browser-row-tag is-legacy">{t(legacyLabelKey, lang)}</span>
                  )}
                </button>
                {mode === 'explore' && child.isVault && (
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<FolderOpen size={14} />}
                    onClick={() => handleEnterVault(child.path)}
                  >
                    {t('nasBrowserOpenVault', lang)}
                  </Button>
                )}
                {mode === 'explore' && isLegacy && legacyKind && (
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<PackagePlus size={14} />}
                    onClick={() => handleMigrateLegacy(child.path, legacyKind)}
                    title={t('nasBrowserMigrateAndOpenHint', lang)}
                  >
                    {t('nasBrowserMigrateAndOpen', lang)}
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        {mode === 'explore' ? (
          <div className="nas-browser-footer">
            <div className="nas-browser-footer-label">{t('nasBrowserFooterCreateLabel', lang)}</div>
            <Input
              className="nas-browser-footer-input"
              type="text"
              placeholder={t('nasBrowserCreatePlaceholder', lang)}
              value={createName}
              onChange={e => setCreateName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              disabled={createBusy}
            />
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Plus size={14} />}
              loading={createBusy}
              disabled={!createName.trim() || createBusy}
              onClick={handleCreate}
            >
              {createBusy ? t('nasBrowserCreating', lang) : t('nasBrowserCreate', lang)}
            </Button>
          </div>
        ) : (
          <div className="nas-browser-footer">
            <div className="nas-browser-footer-label">{t('nasBrowserFooterPickLabel', lang)}</div>
            <code className="nas-browser-pick-path">{currentPath}</code>
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('nasBrowserCancel', lang)}
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Check size={14} />}
              onClick={handlePickPath}
            >
              {t('nasBrowserPickConfirm', lang)}
            </Button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
