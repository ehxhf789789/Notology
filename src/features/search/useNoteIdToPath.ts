import { syncV2Commands } from '../attachments/attachmentCommands';
import { useEffect, useState } from 'react';
import { useVaultPath } from '../../core/stores/fileTreeStore';
/**
 * useNoteIdToPath — shared hook hydrating the
 * `note_id_lowercase → vault_relative_path` map from the backend.
 *
 * 2026-05-25 (HanBin) — extracted from AttachmentsTab so Search.tsx can
 * also consume it (needed by `attachmentExtensionPool` container-scope
 * filter). Centralizes the fetch so both consumers stay in sync and we
 * don't double the `note_id_index` Tauri call per vault open.
 *
 * Backend command (`note_id_index`) walks the vault, reads each .md
 * frontmatter, and returns `{ id_lowercase: vault_relative_path }`.
 * Map is rebuilt on every vault change. Note IDs effectively never
 * change after creation, so re-fetch on byId mutations is unnecessary.
 */

export function useNoteIdToPath(): Map<string, string> {
  const vaultPath = useVaultPath();
  const [map, setMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!vaultPath) { setMap(new Map()); return; }
    let cancelled = false;
    (async () => {
      try {
        const idx = await syncV2Commands.noteIdIndex();
        if (cancelled) return;
        const m = new Map<string, string>();
        for (const [k, v] of Object.entries(idx)) m.set(k, v);
        setMap(m);
      } catch (err) {
        console.error('[useNoteIdToPath] fetch failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [vaultPath]);

  return map;
}
