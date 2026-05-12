//! VaultMigrator: detect un-committed .md files and register them with Library.
//! For vaults opened for the first time in Notology v3 (CAS-based).
//! Different from MigrationManager (4.7) which handles legacy sync/ → sync_v2/ transition.

use std::path::{Path, PathBuf};
use serde::Serialize;

use crate::core::library::Library;
use crate::core::note_id;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub total_md_files: usize,
    pub uncommitted_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    pub migrated_count: usize,
    pub skipped_count: usize,
    pub id_created_count: usize,
    pub errors: Vec<String>,
    pub duration_ms: u64,
}

/// Detect un-committed .md files in vault.
/// Skips if vault already has refs (already migrated — not a fresh vault).
pub fn detect(vault_path: &Path, library: &Library) -> Result<MigrationReport, String> {
    // If library already has refs, this vault was previously used with Notology.
    // Don't re-migrate — uncommitted .md files may be intentionally deleted notes.
    let existing_refs = library.refs().list().unwrap_or_default();
    if !existing_refs.is_empty() {
        return Ok(MigrationReport {
            total_md_files: 0,
            uncommitted_count: 0,
        });
    }
    let md_files = scan_md_files(vault_path)?;
    let mut uncommitted = 0;

    for rel_path in &md_files {
        let full_path = vault_path.join(rel_path);
        if let Ok(Some(note_id)) = note_id::read_id_from_file(&full_path) {
            // Check if ref exists
            if library.refs().get(&note_id).ok().flatten().is_none() {
                uncommitted += 1;
            }
        } else {
            // No id → definitely uncommitted
            uncommitted += 1;
        }
    }

    Ok(MigrationReport {
        total_md_files: md_files.len(),
        uncommitted_count: uncommitted,
    })
}

/// Migrate all un-committed .md files: ensure id + commit_version.
pub fn migrate_all(vault_path: &Path, library: &Library) -> Result<MigrationResult, String> {
    let start = std::time::Instant::now();
    let md_files = scan_md_files(vault_path)?;
    let mut migrated = 0;
    let mut skipped = 0;
    let mut id_created = 0;
    let mut errors = Vec::new();

    // Backup directory for safety
    let backup_dir = vault_path.join(".notology").join("migration_backup");

    for rel_path in &md_files {
        let full_path = vault_path.join(rel_path);

        match migrate_single(&full_path, rel_path, library, &backup_dir) {
            Ok(MigrateOutcome::Migrated { created_id }) => {
                migrated += 1;
                if created_id { id_created += 1; }
                log::info!("[vault_migrator] migrated: {}", rel_path);
            }
            Ok(MigrateOutcome::AlreadyCommitted) => {
                skipped += 1;
            }
            Err(e) => {
                errors.push(format!("{}: {}", rel_path, e));
                log::warn!("[vault_migrator] error: {}: {}", rel_path, e);
            }
        }
    }

    log::info!("[vault_migrator] complete: {} migrated, {} skipped, {} ids created, {} errors",
        migrated, skipped, id_created, errors.len());

    Ok(MigrationResult {
        migrated_count: migrated,
        skipped_count: skipped,
        id_created_count: id_created,
        errors,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

enum MigrateOutcome {
    Migrated { created_id: bool },
    AlreadyCommitted,
}

fn migrate_single(
    full_path: &Path,
    rel_path: &str,
    library: &Library,
    backup_dir: &Path,
) -> Result<MigrateOutcome, String> {
    let content = std::fs::read_to_string(full_path)
        .map_err(|e| format!("read: {}", e))?;

    // Ensure frontmatter id exists
    let (note_id_str, final_content, created_id) = match note_id::read_id_from_content(&content) {
        Some(existing_id) => (existing_id, content, false),
        None => {
            // Backup before modifying
            if let Err(e) = backup_file(full_path, backup_dir) {
                log::warn!("[vault_migrator] backup failed (continuing): {}", e);
            }
            let new_id = note_id::generate_id();
            let new_content = note_id::insert_id_into_content(&content, &new_id);
            std::fs::write(full_path, &new_content)
                .map_err(|e| format!("write: {}", e))?;
            (new_id, new_content, true)
        }
    };

    // Check if already committed
    if let Ok(Some(existing_ref)) = library.refs().get(&note_id_str) {
        let current_hash = crate::core::cas::CasStore::hash(final_content.as_bytes());
        if existing_ref.head_hash == current_hash {
            return Ok(MigrateOutcome::AlreadyCommitted);
        }
    }

    // Commit to Library (CAS + DAG + Ref)
    let normalized_rel = rel_path.replace('\\', "/");
    library.commit_version(
        &note_id_str,
        final_content.as_bytes(),
        &normalized_rel,
        vec![],
    )?;

    Ok(MigrateOutcome::Migrated { created_id })
}

fn backup_file(source: &Path, backup_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(backup_dir).map_err(|e| format!("mkdir: {}", e))?;
    let filename = source.file_name().unwrap_or_default();
    let dest = backup_dir.join(filename);
    std::fs::copy(source, dest).map_err(|e| format!("copy: {}", e))?;
    Ok(())
}

fn scan_md_files(vault_path: &Path) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    walk_recursive(vault_path, vault_path, &mut files)?;
    Ok(files)
}

fn walk_recursive(base: &Path, current: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let entries = std::fs::read_dir(current).map_err(|e| format!("readdir: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if name_str.starts_with('.') || name_str.ends_with("_att") {
            continue;
        }

        if path.is_dir() {
            walk_recursive(base, &path, out)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("md") {
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_empty_vault() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::new(tmp.path()).unwrap();
        let report = detect(tmp.path(), &lib).unwrap();
        assert_eq!(report.total_md_files, 0);
        assert_eq!(report.uncommitted_count, 0);
    }

    #[test]
    fn test_detect_uncommitted() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        std::fs::write(vault.join("note1.md"), "---\nid: \"20260101000001\"\n---\nHello").unwrap();
        std::fs::write(vault.join("note2.md"), "No frontmatter").unwrap();

        let lib = Library::new(vault).unwrap();
        let report = detect(vault, &lib).unwrap();
        assert_eq!(report.total_md_files, 2);
        assert_eq!(report.uncommitted_count, 2);
    }

    #[test]
    fn test_migrate_all() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        std::fs::write(vault.join("a.md"), "---\nid: \"20260101000001\"\ntitle: A\n---\nBody A").unwrap();
        std::fs::write(vault.join("b.md"), "Just body, no frontmatter").unwrap();

        let lib = Library::new(vault).unwrap();
        let result = migrate_all(vault, &lib).unwrap();
        assert_eq!(result.migrated_count, 2);
        assert_eq!(result.id_created_count, 1); // b.md got new id
        assert!(result.errors.is_empty());

        // Verify b.md now has id
        let b_content = std::fs::read_to_string(vault.join("b.md")).unwrap();
        assert!(note_id::read_id_from_content(&b_content).is_some());

        // Verify both have refs
        assert!(lib.refs().get("20260101000001").unwrap().is_some());
    }

    #[test]
    fn test_migrate_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        std::fs::write(vault.join("note.md"), "---\nid: \"20260101000001\"\n---\nContent").unwrap();

        let lib = Library::new(vault).unwrap();
        let r1 = migrate_all(vault, &lib).unwrap();
        assert_eq!(r1.migrated_count, 1);

        let r2 = migrate_all(vault, &lib).unwrap();
        assert_eq!(r2.skipped_count, 1);
        assert_eq!(r2.migrated_count, 0);
    }

    #[test]
    fn test_skips_notology_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();
        std::fs::create_dir_all(vault.join(".notology")).unwrap();
        std::fs::write(vault.join(".notology/internal.md"), "should skip").unwrap();
        std::fs::write(vault.join("real.md"), "---\nid: \"20260101000001\"\n---\nReal note").unwrap();

        let files = scan_md_files(vault).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0], "real.md");
    }
}
