/**
 * Stage 5.0.5a v17 (2026-05-16, HanBin) — per-file custom template storage.
 *
 * Before: all custom templates lived in one `vault-config.yaml` field
 *   (`customTemplates`). Any partial write / race / sync conflict could
 *   wipe ALL of them at once. TEST2 was lost this way.
 *
 * After: each custom template = one YAML file under
 *   `.notology/templates/custom/<id>.yaml`. Atomic writes per template;
 *   one file's corruption doesn't touch the others. NAS sync handles the
 *   directory naturally (Stage 4 sync engine syncs everything under vault
 *   root). Per-file granularity → no merge conflict between edits of
 *   different templates.
 *
 * Migration: on vault load, if legacy `customTemplates` array still exists
 *   in vault-config.yaml, each entry is written out as a file and the
 *   array is cleared from vault-config. Idempotent — re-runs safely.
 */
import { join } from '../../web/path';
import yaml from 'js-yaml';
import { fileCommands } from '../../core/services/tauriCommands';
import type { NoteTemplate } from '../../core/types';

const TEMPLATES_DIR_REL = '.notology/templates/custom';

/** Resolve the absolute templates dir for a given vault. */
async function getTemplatesDir(vaultPath: string): Promise<string> {
  return join(vaultPath, TEMPLATES_DIR_REL);
}

/** Ensure `.notology/templates/custom/` exists. Safe to call repeatedly. */
async function ensureTemplatesDir(vaultPath: string): Promise<string> {
  const dir = await getTemplatesDir(vaultPath);
  await fileCommands.ensureDirectory(dir);
  return dir;
}

/**
 * Sanitize a template id into a safe filename. Custom templates use ids
 * like `note-custom-1234567890` which are already safe, but defensive
 * against any future weirdness (Korean chars, slashes, etc.).
 */
function idToFilename(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.yaml';
}

/**
 * v18 fix (2026-05-16, HanBin) — strip the `---\nid: "..."\n---\n\n` wrapper
 * that the backend `write_file` command auto-prepends to any non-frontmatter
 * file write. Without this, js-yaml's `load` throws "expected a single
 * document in the stream" on every template file → all templates silently
 * skipped → user sees their custom templates "disappear" each session.
 *
 * The wrapper is a frontmatter-style note-id block:
 *   ---
 *   id: "17345678901234567"
 *   ---
 *
 *   <actual template YAML>
 *
 * We detect it by content starting with `---\n` followed by a closing
 * `\n---\n` (or `\r\n` variants), then take whatever's after the closing
 * fence. The result is parseable as a single YAML document.
 */
function stripWriteFileWrapper(content: string): string {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return content;
  }
  // Find the matching closing fence.
  const closeMatch = content.match(/\n---(\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) return content;
  const afterClose = content.slice(closeMatch.index + closeMatch[0].length);
  // Trim any leading blank lines but preserve indentation of the actual yaml.
  return afterClose.replace(/^[\r\n]+/, '');
}

/**
 * Scan the per-file templates dir and load every YAML inside. Files that
 * fail to parse are skipped with a warning (rather than blowing up the
 * whole load) so one corrupt template can't gate the rest.
 *
 * v18 fix (2026-05-16, HanBin) — the Tauri `list_files_in_directory`
 * command returns BARE filenames, not absolute paths. Earlier draft passed
 * those filenames straight to `readTextFile`, which silently failed for
 * every template (relative path resolution doesn't go to the templates
 * dir). Result: templates kept "disappearing" because every load returned
 * `[]` even when the .yaml files were sitting on disk. Now we join the
 * dir back on before reading AND strip the write_file wrapper if present.
 */
export async function loadAllCustomTemplates(vaultPath: string): Promise<NoteTemplate[]> {
  if (!vaultPath) return [];
  try {
    const dir = await ensureTemplatesDir(vaultPath);
    const files = await fileCommands.listFilesInDirectory(dir, 'yaml');
    const out: NoteTemplate[] = [];
    for (const fileName of files) {
      const fullPath = await join(dir, fileName);
      try {
        const raw = await fileCommands.readTextFile(fullPath);
        const stripped = stripWriteFileWrapper(raw);
        const parsed = yaml.load(stripped) as NoteTemplate | null;
        if (parsed && typeof parsed === 'object' && parsed.id) {
          out.push(parsed);
        } else {
          console.warn('[templatesFileStore] Parsed YAML missing id:', fullPath);
        }
      } catch (err) {
        console.warn('[templatesFileStore] Failed to parse template file:', fullPath, err);
      }
    }
    return out;
  } catch (err) {
    console.warn('[templatesFileStore] Failed to list custom templates:', err);
    return [];
  }
}

/**
 * Write a single custom template to disk. Atomic write per file — no
 * shared mutation surface so concurrent edits of different templates
 * don't collide.
 */
export async function saveCustomTemplate(
  vaultPath: string,
  template: NoteTemplate,
): Promise<void> {
  if (!vaultPath) return;
  const dir = await ensureTemplatesDir(vaultPath);
  const path = await join(dir, idToFilename(template.id));
  const yamlContent = yaml.dump(template, { noRefs: true, lineWidth: -1 });
  await fileCommands.writeFile(path, null, yamlContent);
}

/** Delete a custom template's file. Silent if missing. */
export async function deleteCustomTemplateFile(
  vaultPath: string,
  id: string,
): Promise<void> {
  if (!vaultPath) return;
  try {
    const dir = await getTemplatesDir(vaultPath);
    const path = await join(dir, idToFilename(id));
    const exists = await fileCommands.checkFileExists(path);
    if (exists) await fileCommands.deleteFile(path);
  } catch (err) {
    console.warn('[templatesFileStore] Failed to delete template file:', id, err);
  }
}

/**
 * One-shot migration: if vault-config.yaml still has a `customTemplates`
 * array (legacy storage), write each entry as a per-file template and
 * return the migrated list. Caller is responsible for clearing the
 * legacy array from vault-config after this returns.
 *
 * Idempotent — re-running it on a vault that's already migrated is a
 * no-op (legacy array empty → nothing to write).
 *
 * Excludes any entries whose id collides with current default templates
 * (`tpl-*`) so the historical pollution bug is cleaned up here too.
 */
export async function migrateLegacyTemplates(
  vaultPath: string,
  legacyCustomTemplates: NoteTemplate[] | undefined,
  defaultIds: Set<string>,
): Promise<NoteTemplate[]> {
  if (!vaultPath || !legacyCustomTemplates || legacyCustomTemplates.length === 0) {
    return [];
  }
  const realCustoms = legacyCustomTemplates.filter(t => !defaultIds.has(t.id));
  if (realCustoms.length === 0) return [];

  // Write each as a file. Failures are logged but don't abort migration —
  // the legacy array stays in vault-config until ALL succeed in a future
  // load (caller can decide its clear-out policy).
  const written: NoteTemplate[] = [];
  for (const tmpl of realCustoms) {
    try {
      await saveCustomTemplate(vaultPath, tmpl);
      written.push(tmpl);
    } catch (err) {
      console.warn('[templatesFileStore] Migration failed for template:', tmpl.id, err);
    }
  }
  return written;
}
