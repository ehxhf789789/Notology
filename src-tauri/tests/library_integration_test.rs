//! Integration tests for Stage 1 Library + Save Flow.
//!
//! Tests the CAS/DAG/Refs infrastructure via the Library coordinator API.
//! Does NOT test Tauri commands (requires Tauri runtime); tests the
//! underlying logic directly.

use std::fs;
use std::path::Path;
use tempfile::TempDir;

use app_lib::core::cas::CasStore;
use app_lib::core::library::Library;
use app_lib::core::note_id;
use app_lib::core::file_io::atomic_write_file;

fn make_vault() -> (TempDir, Library) {
    let temp = TempDir::new().unwrap();
    let lib = Library::new_with_device_id(
        temp.path(),
        "TEST-DEVICE".to_string(),
    ).unwrap();
    (temp, lib)
}

#[test]
fn test_save_creates_library_artifacts() {
    let (_tmp, lib) = make_vault();
    let note_id = "20260419100000";
    let content = b"---\nid: \"20260419100000\"\ntitle: \"Test\"\n---\n\nContent";

    // Simulate save flow: write .md, then library commit
    let note_path = _tmp.path().join("test-note.md");
    atomic_write_file(&note_path, content).unwrap();

    let result = lib.commit_version(note_id, content, "test-note.md", vec![]).unwrap();
    assert!(result.is_some());
    let hash = result.unwrap();

    // All 3 artifacts exist
    assert!(lib.cas().has_object(&hash));
    let history = lib.get_history(note_id).unwrap();
    assert_eq!(history.len(), 1);
    let note_ref = lib.get_ref(note_id).unwrap().unwrap();
    assert_eq!(note_ref.head_hash, hash);
}

#[test]
fn test_save_without_library_initialized() {
    // Graceful degradation: no library, just atomic write
    let temp = TempDir::new().unwrap();
    let note_path = temp.path().join("test.md");
    let content = b"---\nid: \"20260419100000\"\n---\n\nContent";

    atomic_write_file(&note_path, content).unwrap();

    assert!(note_path.is_file());
    let read_content = fs::read(&note_path).unwrap();
    assert_eq!(read_content, content);
}

#[test]
fn test_save_legacy_note_gets_id() {
    let temp = TempDir::new().unwrap();
    let note_path = temp.path().join("legacy.md");

    let original = "---\ntitle: \"Legacy\"\n---\n\nOld content";
    fs::write(&note_path, original).unwrap();

    let id = note_id::ensure_id_in_file(&note_path).unwrap();
    assert!(note_id::is_valid_id(&id));

    let new_content = fs::read_to_string(&note_path).unwrap();
    assert!(new_content.contains(&format!("id: \"{}\"", id)));
    assert!(new_content.contains("title: \"Legacy\""));
    assert!(new_content.contains("Old content"));
}

#[test]
fn test_save_preserves_existing_id() {
    let temp = TempDir::new().unwrap();
    let note_path = temp.path().join("with_id.md");

    let original = "---\nid: \"20260419100000\"\ntitle: \"Has ID\"\n---\n\nContent";
    fs::write(&note_path, original).unwrap();

    let id = note_id::ensure_id_in_file(&note_path).unwrap();
    assert_eq!(id, "20260419100000");

    let after = fs::read_to_string(&note_path).unwrap();
    assert_eq!(after, original);
}

#[test]
fn test_create_note_has_id() {
    // Simulate what create_note does (can't call Tauri command directly)
    let note_id_val = note_id::generate_id();
    let content = format!(
        "---\nid: \"{}\"\ncreated: \"2026-04-19\"\ntitle: \"Test\"\ntype: \"NOTE\"\ntags: []\n---\n\n",
        note_id_val
    );

    // Verify id is present
    let extracted = note_id::read_id_from_content(&content);
    assert_eq!(extracted, Some(note_id_val));
}

#[test]
fn test_create_folder_has_id() {
    // Simulate create_folder's default frontmatter (with id added)
    let folder_id = note_id::generate_id();
    let content = format!(
        "---\nid: \"{}\"\ncreated: \"2026-04-19\"\ntitle: \"Folder\"\ntype: \"FOLDER\"\n---\n\n",
        folder_id
    );

    let extracted = note_id::read_id_from_content(&content);
    assert_eq!(extracted, Some(folder_id));
}

#[test]
fn test_library_failure_doesnt_block_save() {
    let temp = TempDir::new().unwrap();
    let note_path = temp.path().join("test.md");
    let content = b"---\nid: \"20260419100000\"\n---\n\nContent";

    // Write .md file (primary save)
    atomic_write_file(&note_path, content).unwrap();
    assert!(note_path.is_file());

    // Library commit to a nonexistent vault path would fail
    // but the .md file is already saved
    let bad_lib = Library::new_with_device_id(
        temp.path(),
        "TEST".to_string(),
    ).unwrap();

    // Even if we simulate a DAG corruption, .md is safe
    let dag_path = temp.path().join(".notology").join("history").join("20260419100000.json");
    fs::create_dir_all(dag_path.parent().unwrap()).unwrap();
    fs::write(&dag_path, b"INVALID JSON").unwrap();

    // commit_version will fail on DAG load
    let result = bad_lib.commit_version("20260419100000", content, "test.md", vec![]);
    assert!(result.is_err());

    // But .md file is still intact
    let saved = fs::read(&note_path).unwrap();
    assert_eq!(saved, content);
}

#[test]
fn test_multiple_versions_tracked() {
    let (_tmp, lib) = make_vault();
    let note_id = "20260419100000";

    let h1 = lib.commit_version(note_id, b"version 1", "n.md", vec![]).unwrap().unwrap();
    let h2 = lib.commit_version(note_id, b"version 2", "n.md", vec![]).unwrap().unwrap();
    let h3 = lib.commit_version(note_id, b"version 3", "n.md", vec![]).unwrap().unwrap();

    // All versions accessible
    let v1 = lib.read_version(&h1).unwrap().unwrap();
    assert_eq!(v1, b"version 1");
    let v3 = lib.read_version(&h3).unwrap().unwrap();
    assert_eq!(v3, b"version 3");

    // History is ordered
    let history = lib.get_history(note_id).unwrap();
    assert_eq!(history.len(), 3);
    assert_eq!(history[0].content_hash, h1);
    assert_eq!(history[2].content_hash, h3);

    // HEAD points to latest
    assert_eq!(lib.get_head(note_id).unwrap(), Some(h3));
}

#[test]
fn test_id_insertion_in_content() {
    // Test the content-based ID functions used by write_file
    let content = "---\ntitle: \"No ID\"\n---\n\nBody";
    assert!(note_id::read_id_from_content(content).is_none());

    let new_id = note_id::generate_id();
    let updated = note_id::insert_id_into_content(content, &new_id);

    let extracted = note_id::read_id_from_content(&updated);
    assert_eq!(extracted, Some(new_id.clone()));
    assert!(updated.contains("title: \"No ID\""));
    assert!(updated.contains("Body"));
}
