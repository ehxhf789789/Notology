/**
 * TemplateMigrationModal — 5.0.5a-migration sub-stage (HanBin 2026-05-17).
 *
 * Migrates notes whose frontmatter `type:` value doesn't match any currently
 * registered NoteTemplate (typically legacy types like MTG / OFA / PAPER from
 * the pre-3-template era) onto a current template chosen by the user.
 *
 * Flow:
 *   1. noteTypeCacheStore.unmatchedTypes lists the dangling types + counts.
 *   2. The modal renders one row per legacy type with a target-template
 *      Select. Selecting "— Leave as-is —" skips that type.
 *   3. "Run migration" iterates each (legacy, target) pair, fetches every
 *      note with that legacy type, parses its frontmatter, swaps `type:`
 *      and `cssclasses:` to the target's values, and writes back via
 *      `updateFrontmatter`. body untouched.
 *   4. On success, the noteType cache is invalidated so the next refresh
 *      shows the now-matched types (and the badge in Settings clears).
 */
import { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle } from 'lucide-react';
import { useTemplateStore } from './stores/templateStore';
import { useUnmatchedNoteTypes, noteTypeCacheActions } from '../content-cache/stores/noteTypeCacheStore';
import { useLanguage } from '../../core/stores/settingsStore';
import { t, tf } from '../../core/utils/i18n';
import { Button } from '../../design-system/components';
import { fileCommands, noteCommands, frontmatterCommands } from '../../core/services/tauriCommands';
import { showToast } from '../shared/Toast';
import { useEscapeKey } from '../shared/useEscapeKey';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ParsedNoteShape {
  frontmatter: Record<string, unknown> | null;
  body: string;
}

export function TemplateMigrationModal({ open, onClose }: Props) {
  const language = useLanguage();
  const noteTemplates = useTemplateStore(s => s.noteTemplates);
  const unmatched = useUnmatchedNoteTypes();

  // mapping: legacy type → target NoteTemplate id (empty = skip)
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ converted: number; total: number } | null>(null);

  useEscapeKey(() => { if (!running) onClose(); }, open);

  const entries = useMemo(
    () => Array.from(unmatched.entries()).sort((a, b) => b[1] - a[1]),
    [unmatched],
  );

  if (!open) return null;

  const runMigration = async () => {
    const work = entries
      .map(([legacyType]) => ({ legacyType, targetId: mapping[legacyType] }))
      .filter(w => w.targetId && w.targetId.length > 0);

    if (work.length === 0) {
      showToast({ type: 'info', title: t('tplMigrateEmpty', language) });
      return;
    }

    setRunning(true);
    let totalConverted = 0;
    let totalAttempted = 0;

    try {
      for (const w of work) {
        const target = noteTemplates.find(tpl => tpl.id === w.targetId);
        if (!target) continue;
        const newType = target.frontmatter.type || 'NOTE';
        const newCssclasses = target.frontmatter.cssclasses ?? [];

        const paths = await noteTypeCacheActions.listNotesWithType(w.legacyType);
        totalAttempted += paths.length;

        for (const path of paths) {
          try {
            const raw = await fileCommands.readTextFile(path);
            const parsed = await frontmatterCommands.parseFrontmatter<ParsedNoteShape>(raw);
            const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
            const updated = { ...fm, type: newType, cssclasses: newCssclasses };
            const yaml = await frontmatterCommands.frontmatterToYaml<string>(JSON.stringify(updated));
            await noteCommands.updateFrontmatter(path, yaml);
            totalConverted++;
            setProgress({ converted: totalConverted, total: totalAttempted });
          } catch (err) {
            console.warn('[TemplateMigration] failed for', path, err);
          }
        }
      }

      showToast({
        type: 'success',
        title: tf('tplMigrateDone', language, {
          converted: String(totalConverted),
          total: String(totalAttempted),
        }),
      });

      // Refresh the cache so unmatched set + sidebar type column reflect
      // the new state immediately.
      noteTypeCacheActions.invalidate();
      await noteTypeCacheActions.refreshCache();
      setMapping({});
      onClose();
    } catch (err: any) {
      showToast({
        type: 'error',
        title: tf('tplMigrateFail', language, { message: String(err?.message ?? err) }),
      });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  return createPortal(
    <div className="tpl-migrate-overlay" onClick={() => !running && onClose()}>
      <div className="tpl-migrate-modal" onClick={e => e.stopPropagation()}>
        <div className="tpl-migrate-header">
          <div className="tpl-migrate-title-row">
            <AlertTriangle size={16} className="tpl-migrate-title-icon" />
            <h3 className="tpl-migrate-title">{t('tplMigrateTitle', language)}</h3>
          </div>
          <button
            className="tpl-migrate-close"
            onClick={() => !running && onClose()}
            disabled={running}
            aria-label={t('close', language)}
            title={t('close', language)}
          >
            <X size={16} />
          </button>
        </div>
        <p className="tpl-migrate-desc">{t('tplMigrateDesc', language)}</p>

        {entries.length === 0 ? (
          <div className="tpl-migrate-empty">{t('tplMigrateEmpty', language)}</div>
        ) : (
          <div className="tpl-migrate-table" role="table">
            <div className="tpl-migrate-row tpl-migrate-row--head" role="row">
              <span role="columnheader">{t('tplMigrateLegacyTypeCol', language)}</span>
              <span role="columnheader" className="tpl-migrate-col-count">
                {t('tplMigrateCountCol', language)}
              </span>
              <span role="columnheader">{t('tplMigrateTargetCol', language)}</span>
            </div>
            {entries.map(([legacyType, count]) => (
              <div key={legacyType} className="tpl-migrate-row" role="row">
                <code className="tpl-migrate-legacy-type">{legacyType}</code>
                <span className="tpl-migrate-col-count">{count}</span>
                <select
                  className="tpl-migrate-target-select"
                  value={mapping[legacyType] ?? ''}
                  onChange={e => setMapping(m => ({ ...m, [legacyType]: e.target.value }))}
                  disabled={running}
                >
                  <option value="">{t('tplMigrateTargetKeep', language)}</option>
                  {noteTemplates.map(tpl => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name} ({tpl.frontmatter.type ?? '—'})
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}

        <div className="tpl-migrate-footer">
          {progress && (
            <span className="tpl-migrate-progress">
              {progress.converted} / {progress.total}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <Button variant="secondary" onClick={onClose} disabled={running}>
            {t('tplMigrateClose', language)}
          </Button>
          <Button
            variant="primary"
            onClick={runMigration}
            disabled={running || entries.length === 0}
            loading={running}
          >
            {running ? t('tplMigrateRunning', language) : t('tplMigrateRun', language)}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default TemplateMigrationModal;
