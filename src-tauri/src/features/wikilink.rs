use rayon::prelude::*;
use std::fs;
use std::path::{Path, PathBuf};

use crate::core::file_io::rename_with_retry;

/// Pre-computed wiki link patterns for efficient replacement
pub struct WikiLinkPatterns {
    wiki_stem: (String, String),
    wiki_full: Option<(String, String)>,
    wiki_full_no_ext: Option<(String, String)>,
    attr_wiki_stem: (String, String),
    attr_wiki_full: Option<(String, String)>,
    attr_filename_stem: (String, String),
    attr_filename_full: Option<(String, String)>,
    span_text_stem: (String, String),
    span_text_full: Option<(String, String)>,
}

impl WikiLinkPatterns {
    pub fn new(old_stem: &str, old_full: &str, new_stem: &str, new_full: &str) -> Self {
        let has_full = old_full != old_stem;

        Self {
            wiki_stem: (format!("[[{}]]", old_stem), format!("[[{}]]", new_stem)),
            wiki_full: if has_full {
                Some((format!("[[{}]]", old_full), format!("[[{}]]", new_full)))
            } else {
                None
            },
            wiki_full_no_ext: if old_full.ends_with(".md") && has_full {
                let old_no_ext = old_full.trim_end_matches(".md");
                let new_no_ext = new_full.trim_end_matches(".md");
                if old_no_ext != old_stem {
                    Some((format!("[[{}]]", old_no_ext), format!("[[{}]]", new_no_ext)))
                } else {
                    None
                }
            } else {
                None
            },
            attr_wiki_stem: (
                format!("data-wiki-link=\"{}\"", old_stem),
                format!("data-wiki-link=\"{}\"", new_stem),
            ),
            attr_wiki_full: if has_full {
                Some((
                    format!("data-wiki-link=\"{}\"", old_full),
                    format!("data-wiki-link=\"{}\"", new_full),
                ))
            } else {
                None
            },
            attr_filename_stem: (
                format!("filename=\"{}\"", old_stem),
                format!("filename=\"{}\"", new_stem),
            ),
            attr_filename_full: if has_full {
                Some((
                    format!("filename=\"{}\"", old_full),
                    format!("filename=\"{}\"", new_full),
                ))
            } else {
                None
            },
            span_text_stem: (
                format!(">{}</span>", old_stem),
                format!(">{}</span>", new_stem),
            ),
            span_text_full: if has_full {
                Some((
                    format!(">{}</span>", old_full),
                    format!(">{}</span>", new_full),
                ))
            } else {
                None
            },
        }
    }

    pub fn apply(&self, content: &str) -> Option<String> {
        let mut updated = content.to_string();
        let mut has_changes = false;

        has_changes |= self.replace_pattern(&mut updated, &self.wiki_stem);
        if let Some(ref p) = self.wiki_full {
            has_changes |= self.replace_pattern(&mut updated, p);
        }
        if let Some(ref p) = self.wiki_full_no_ext {
            has_changes |= self.replace_pattern(&mut updated, p);
        }
        has_changes |= self.replace_pattern(&mut updated, &self.attr_wiki_stem);
        if let Some(ref p) = self.attr_wiki_full {
            has_changes |= self.replace_pattern(&mut updated, p);
        }
        has_changes |= self.replace_pattern(&mut updated, &self.attr_filename_stem);
        if let Some(ref p) = self.attr_filename_full {
            has_changes |= self.replace_pattern(&mut updated, p);
        }
        has_changes |= self.replace_pattern(&mut updated, &self.span_text_stem);
        if let Some(ref p) = self.span_text_full {
            has_changes |= self.replace_pattern(&mut updated, p);
        }

        if has_changes {
            Some(updated)
        } else {
            None
        }
    }

    #[inline]
    fn replace_pattern(&self, content: &mut String, pattern: &(String, String)) -> bool {
        if content.contains(&pattern.0) {
            *content = content.replace(&pattern.0, &pattern.1);
            true
        } else {
            false
        }
    }
}

/// Parallel wiki link update across vault
pub fn update_wiki_links_recursive(
    dir: &Path,
    old_stem: &str,
    old_full: &str,
    new_stem: &str,
    new_full: &str,
) {
    let md_files = collect_md_files(dir);

    if md_files.is_empty() {
        return;
    }

    let patterns = WikiLinkPatterns::new(old_stem, old_full, new_stem, new_full);

    let updates: Vec<(PathBuf, String)> = md_files
        .par_iter()
        .filter_map(|path| {
            if let Ok(content) = fs::read_to_string(path) {
                if let Some(updated) = patterns.apply(&content) {
                    return Some((path.clone(), updated));
                }
            }
            None
        })
        .collect();

    for (path, content) in updates {
        let _ = fs::write(&path, &content);
    }
}

pub fn collect_md_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_md_files_recursive(dir, &mut files);
    files
}

fn collect_md_files_recursive(dir: &Path, files: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') || name.ends_with("_att") {
            continue;
        }

        if path.is_dir() {
            collect_md_files_recursive(&path, files);
        } else if name.ends_with(".md") {
            files.push(path);
        }
    }
}

#[tauri::command]
pub fn rename_file_with_links(
    file_path: String,
    new_name: String,
    vault_path: String,
    library_state: tauri::State<'_, crate::LibraryState>,
    sync_v2_state: tauri::State<'_, crate::features::sync_v2::commands::SyncEngineState>,
) -> Result<String, String> {
    println!("[DEBUG] rename_file_with_links called:");
    println!("  file_path: {}", file_path);
    println!("  new_name: {}", new_name);
    println!("  vault_path: {}", vault_path);

    let old_path = Path::new(&file_path);
    if !old_path.exists() {
        return Err("File does not exist".to_string());
    }

    let parent = old_path.parent().ok_or("Cannot determine parent directory")?;
    let old_stem = old_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let old_name_full = old_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let parent_name = parent.file_name().unwrap_or_default().to_string_lossy().to_string();

    let new_stem = Path::new(&new_name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    println!("[DEBUG] Extracted names:");
    println!("  old_stem: {}, old_name_full: {}", old_stem, old_name_full);
    println!("  new_stem: {}, new_name: {}", new_stem, new_name);

    let is_folder_note = old_stem.eq_ignore_ascii_case(&parent_name);

    let final_path: PathBuf;

    if is_folder_note {
        let grandparent = parent.parent().ok_or("Cannot determine grandparent directory")?;
        let new_folder_path = grandparent.join(&new_stem);

        if new_folder_path.exists() && new_folder_path != parent {
            return Err("A folder with that name already exists".to_string());
        }

        let temp_file_path = parent.join(&new_name);
        rename_with_retry(old_path, &temp_file_path)
            .map_err(|e| format!("Failed to rename file: {}", e))?;

        let old_att = parent.join(format!("{}_att", old_stem));
        let att_was_renamed = if old_att.exists() && old_att.is_dir() {
            let new_att = parent.join(format!("{}_att", new_stem));
            if let Err(e) = rename_with_retry(&old_att, &new_att) {
                let _ = fs::rename(&temp_file_path, old_path);
                return Err(format!("Failed to rename attachment folder: {}", e));
            }
            true
        } else {
            false
        };

        if let Err(e) = rename_with_retry(parent, &new_folder_path) {
            if att_was_renamed {
                let new_att = parent.join(format!("{}_att", new_stem));
                let _ = fs::rename(&new_att, &old_att);
            }
            let _ = fs::rename(&temp_file_path, old_path);
            return Err(format!("Failed to rename folder: {}", e));
        }

        final_path = new_folder_path.join(&new_name);

        update_wiki_links_recursive(
            Path::new(&vault_path),
            &old_stem,
            &old_name_full,
            &new_stem,
            &new_name,
        );
        if parent_name != old_stem {
            update_wiki_links_recursive(
                Path::new(&vault_path),
                &parent_name,
                &format!("{}.md", parent_name),
                &new_stem,
                &new_name,
            );
        }
    } else if old_path.is_dir() {
        let new_path = parent.join(&new_name);
        if new_path.exists() && new_path != old_path {
            return Err("A folder with that name already exists".to_string());
        }

        let folder_note_path = old_path.join(format!("{}.md", old_stem));
        let has_folder_note = folder_note_path.exists();

        rename_with_retry(old_path, &new_path)
            .map_err(|e| format!("Failed to rename folder: {}", e))?;

        if has_folder_note {
            let old_note_in_new_folder = new_path.join(format!("{}.md", old_stem));
            let new_note_path = new_path.join(format!("{}.md", new_stem));
            if let Err(e) = rename_with_retry(&old_note_in_new_folder, &new_note_path) {
                let _ = fs::rename(&new_path, old_path);
                return Err(format!("Failed to rename folder note: {}", e));
            }

            let old_att = new_path.join(format!("{}_att", old_stem));
            if old_att.exists() && old_att.is_dir() {
                let new_att = new_path.join(format!("{}_att", new_stem));
                if let Err(e) = rename_with_retry(&old_att, &new_att) {
                    let _ = fs::rename(&new_note_path, &old_note_in_new_folder);
                    let _ = fs::rename(&new_path, old_path);
                    return Err(format!("Failed to rename attachment folder: {}", e));
                }
            }

            update_wiki_links_recursive(
                Path::new(&vault_path),
                &old_stem,
                &format!("{}.md", old_stem),
                &new_stem,
                &format!("{}.md", new_stem),
            );
        }

        final_path = new_path;
    } else {
        let new_path = parent.join(&new_name);
        if new_path.exists() && new_path != old_path {
            return Err("A file with that name already exists".to_string());
        }

        rename_with_retry(old_path, &new_path).map_err(|e| e.to_string())?;

        let is_md = new_name.ends_with(".md") || old_name_full.ends_with(".md");
        if is_md {
            let old_att = parent.join(format!("{}_att", old_stem));
            if old_att.exists() && old_att.is_dir() {
                let new_att = parent.join(format!("{}_att", new_stem));
                if let Err(e) = rename_with_retry(&old_att, &new_att) {
                    let _ = fs::rename(&new_path, old_path);
                    return Err(format!("Failed to rename attachment folder: {}", e));
                }
            }
        }

        final_path = new_path;

        update_wiki_links_recursive(
            Path::new(&vault_path),
            &old_stem,
            &old_name_full,
            &new_stem,
            &new_name,
        );
    }

    // Update frontmatter title
    if final_path.extension().map(|e| e == "md").unwrap_or(false) && final_path.exists() {
        if let Ok(content) = fs::read_to_string(&final_path) {
            if content.starts_with("---\n") || content.starts_with("---\r\n") {
                if let Some(end_idx) = content[4..].find("\n---").map(|i| i + 4) {
                    let fm_section = &content[4..end_idx];
                    if let Some(title_start) = fm_section.find("\ntitle:").or_else(|| {
                        if fm_section.starts_with("title:") { Some(0) } else { None }
                    }) {
                        let new_display_title = new_stem.replace('_', " ");
                        let abs_start = if title_start == 0 { 4 } else { 4 + title_start + 1 };
                        let line_end = content[abs_start..].find('\n')
                            .map(|i| abs_start + i)
                            .unwrap_or(end_idx);
                        let new_content = format!(
                            "{}title: \"{}\"{}",
                            &content[..abs_start],
                            new_display_title,
                            &content[line_end..]
                        );
                        let _ = fs::write(&final_path, new_content);
                    }
                }
            }
        }
    }

    // === sync_v2: update refs + enqueue for all affected notes ===
    {
        use crate::core::note_id;
        use crate::features::sync_v2::dirty_queue::DirtyOperation;

        let vault_root = Path::new(&vault_path);

        // Collect all .md files at the final_path location (single file or directory)
        let mut affected_files: Vec<PathBuf> = Vec::new();
        if final_path.is_dir() {
            fn walk_md(dir: &Path, out: &mut Vec<PathBuf>) {
                if let Ok(entries) = fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_dir() {
                            let name = p.file_name().unwrap_or_default().to_string_lossy();
                            if !name.ends_with("_att") && name != ".notology" {
                                walk_md(&p, out);
                            }
                        } else if p.extension().and_then(|e| e.to_str()) == Some("md") {
                            out.push(p);
                        }
                    }
                }
            }
            walk_md(&final_path, &mut affected_files);
        } else if final_path.extension().and_then(|e| e.to_str()) == Some("md") {
            affected_files.push(final_path.clone());
        }

        // For each affected .md: read note_id → compute new relative path → update ref + enqueue
        if let Ok(guard) = library_state.lock() {
            if let Some(lib) = guard.as_ref() {
                for md_path in &affected_files {
                    if let Ok(Some(nid)) = note_id::read_id_from_file(md_path) {
                        if let Ok(new_rel) = md_path.strip_prefix(vault_root) {
                            let new_rel_str = new_rel.to_str().unwrap_or("").replace('\\', "/");
                            // Get old path from current ref (before update)
                            let old_rel_str = lib.refs().get(&nid)
                                .ok().flatten()
                                .map(|r| r.relative_path.clone())
                                .unwrap_or_default();
                            // Update ref
                            if let Ok(Some(mut note_ref)) = lib.refs().get(&nid) {
                                if note_ref.relative_path != new_rel_str {
                                    note_ref.relative_path = new_rel_str.clone();
                                    note_ref.updated_at = chrono::Utc::now();
                                    let _ = lib.refs().set(&note_ref);
                                    log::info!("[rename] updated ref: {} → {}", old_rel_str, new_rel_str);
                                    // Enqueue move
                                    if let Some(engine) = sync_v2_state.get() {
                                        engine.enqueue_dirty(DirtyOperation::NoteMove {
                                            note_id: nid.clone(),
                                            old_path: old_rel_str,
                                            new_path: new_rel_str,
                                        });
                                    }
                                }
                            }
                            // Also commit the new content (frontmatter title was updated above)
                            if let Ok(content) = fs::read(md_path) {
                                let rel_str = new_rel.to_str().unwrap_or("");
                                match lib.commit_version(&nid, &content, rel_str, vec![]) {
                                    Ok(Some(hash)) => {
                                        log::info!("[rename] committed: {} -> {}", nid, &hash[..16]);
                                        if let Some(engine) = sync_v2_state.get() {
                                            engine.enqueue_dirty(DirtyOperation::NoteUpsert {
                                                note_id: nid,
                                                relative_path: rel_str.replace('\\', "/"),
                                            });
                                        }
                                    }
                                    Ok(None) => {}
                                    Err(e) => log::warn!("[rename] commit failed: {} - {}", nid, e),
                                }
                            }
                        }
                    }
                }
            }
        }

        // Enqueue old folder deletion if this was a folder rename
        if is_folder_note || old_path.is_dir() {
            if let Ok(old_rel) = old_path.strip_prefix(vault_root) {
                if let Some(old_rel_str) = old_rel.to_str() {
                    let old_dir_rel = if is_folder_note {
                        // For folder note, old_path is the .md file; parent was the folder
                        old_rel.parent()
                            .and_then(|p| p.to_str())
                            .unwrap_or("")
                            .replace('\\', "/")
                    } else {
                        old_rel_str.replace('\\', "/")
                    };
                    if !old_dir_rel.is_empty() {
                        if let Some(engine) = sync_v2_state.get() {
                            engine.enqueue_dirty(DirtyOperation::FolderDelete {
                                relative_path: old_dir_rel,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(final_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn search_backlinks(vault_path: String, file_name: String) -> Result<Vec<crate::core::types::BacklinkResult>, String> {
    let pattern = format!(r"\[\[{}\]\]", regex::escape(&file_name));
    let re = regex::Regex::new(&pattern).map_err(|e| e.to_string())?;

    let mut results: Vec<crate::core::types::BacklinkResult> = Vec::new();
    search_backlinks_recursive(Path::new(&vault_path), &re, &mut results)?;
    Ok(results)
}

fn search_backlinks_recursive(
    path: &Path,
    re: &regex::Regex,
    results: &mut Vec<crate::core::types::BacklinkResult>,
) -> Result<(), String> {
    use std::io::BufRead;

    let read_dir = fs::read_dir(path).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
            continue;
        }

        if entry_path.is_dir() {
            search_backlinks_recursive(&entry_path, re, results)?;
        } else if name.ends_with(".md") {
            let file = fs::File::open(&entry_path).map_err(|e| e.to_string())?;
            let reader = std::io::BufReader::new(file);

            for (line_idx, line) in reader.lines().enumerate() {
                let line = line.map_err(|e| e.to_string())?;
                if re.is_match(&line) {
                    results.push(crate::core::types::BacklinkResult {
                        file_path: entry_path.to_string_lossy().to_string(),
                        file_name: name.clone(),
                        line_number: (line_idx + 1) as u32,
                        context: line.trim().to_string(),
                    });
                }
            }
        }
    }

    Ok(())
}
