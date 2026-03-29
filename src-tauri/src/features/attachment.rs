use std::fs;
use std::path::{Path, PathBuf};

use crate::core::types::{AttachmentInfo, AttachmentFileInfo};

#[tauri::command]
pub fn read_attachment_folder(att_folder_path: String, query: String) -> Result<Vec<AttachmentFileInfo>, String> {
    let dir_path = Path::new(&att_folder_path);
    if !dir_path.exists() || !dir_path.is_dir() {
        return Ok(Vec::new());
    }

    let lower_query = query.to_lowercase();
    let mut results: Vec<AttachmentFileInfo> = Vec::new();

    const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];

    fn collect_files(
        dir: &Path,
        base_path: &Path,
        query: &str,
        image_exts: &[&str],
        results: &mut Vec<AttachmentFileInfo>,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let entry_path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();

            if file_name.starts_with('.') {
                continue;
            }

            if entry_path.is_dir() {
                collect_files(&entry_path, base_path, query, image_exts, results)?;
            } else if entry_path.is_file() {
                let relative_path = entry_path
                    .strip_prefix(base_path)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| file_name.clone());

                if query.is_empty() || relative_path.to_lowercase().contains(query) {
                    let mtime = entry.metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);

                    let ext = entry_path.extension()
                        .map(|e| e.to_string_lossy().to_lowercase())
                        .unwrap_or_default();
                    let is_image = image_exts.contains(&ext.as_str());

                    results.push(AttachmentFileInfo {
                        file_name: relative_path.clone(),
                        path: relative_path,
                        is_image,
                        mtime,
                    });
                }
            }
        }
        Ok(())
    }

    collect_files(dir_path, dir_path, &lower_query, IMAGE_EXTENSIONS, &mut results)?;

    results.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    results.truncate(15);

    Ok(results)
}

#[tauri::command]
pub fn search_att(vault_path: String, query: String) -> Result<Vec<AttachmentInfo>, String> {
    let mut results: Vec<AttachmentInfo> = Vec::new();
    let q = query.to_lowercase();
    let vault = Path::new(&vault_path);
    search_att_recursive(vault, vault, &q, &mut results)?;
    Ok(results)
}

fn search_att_recursive(
    path: &Path,
    vault_root: &Path,
    query: &str,
    results: &mut Vec<AttachmentInfo>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(path).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
            continue;
        }

        if entry_path.is_dir() {
            if name.ends_with("_att") {
                let note_name = name.trim_end_matches("_att");
                let note_path = path.join(format!("{}.md", note_name));

                let note_relative = note_path
                    .strip_prefix(vault_root)
                    .unwrap_or(&note_path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let container = note_relative
                    .split('/')
                    .next()
                    .unwrap_or("")
                    .to_string();

                let note_name_lower = note_name.to_lowercase();
                let note_relative_lower = note_relative.to_lowercase();
                let container_lower = container.to_lowercase();

                if let Ok(files) = fs::read_dir(&entry_path) {
                    for file in files {
                        if let Ok(file) = file {
                            let file_name = file.file_name().to_string_lossy().to_string();
                            let file_path = file.path();

                            if file_name == "comments.json" {
                                continue;
                            }

                            if !file_path.is_dir() {
                                if query.is_empty()
                                    || file_name.to_lowercase().contains(query)
                                    || note_name_lower.contains(query)
                                    || note_relative_lower.contains(query)
                                    || container_lower.contains(query)
                                {
                                    results.push(AttachmentInfo {
                                        path: file_path.to_string_lossy().to_string(),
                                        file_name: file_name.clone(),
                                        note_path: note_path.to_string_lossy().to_string(),
                                        note_name: note_name.to_string(),
                                        note_relative_path: note_relative.clone(),
                                        inferred_note_path: note_relative.clone(),
                                        container: container.clone(),
                                        is_conflict: false,
                                        conflict_original: String::new(),
                                    });
                                }
                            }
                        }
                    }
                }
            } else {
                search_att_recursive(&entry_path, vault_root, query, results)?;
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn search_attachments(
    vault_path: String,
    query: String,
) -> Result<Vec<AttachmentInfo>, String> {
    use walkdir::{WalkDir, DirEntry};
    use crate::search::watcher::{is_synology_conflict_file, get_original_from_conflict};

    let vault = Path::new(&vault_path);
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    for entry in WalkDir::new(&vault)
        .into_iter()
        .filter_map(|e: Result<DirEntry, _>| e.ok())
        .filter(|e: &DirEntry| e.file_type().is_file())
    {
        let path: &Path = entry.path();

        let is_attachment = path.components().any(|c| {
            if let std::path::Component::Normal(name) = c {
                let s = name.to_string_lossy();
                s.ends_with("_att") || {
                    let lower = s.to_lowercase();
                    s.contains("_att") && (lower.contains("(synologydrive conflict") || lower.contains("(synology conflict"))
                }
            } else {
                false
            }
        });

        if !is_attachment {
            continue;
        }

        let file_name = path.file_name()
            .and_then(|n: &std::ffi::OsStr| n.to_str())
            .unwrap_or("")
            .to_string();

        if file_name == "comments.json" {
            continue;
        }

        let file_is_conflict = is_synology_conflict_file(&file_name);
        let file_conflict_original = if file_is_conflict {
            get_original_from_conflict(path)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            String::new()
        };

        let att_folder = path.parent().unwrap_or(vault);
        let att_folder_name = att_folder.file_name()
            .and_then(|n: &std::ffi::OsStr| n.to_str())
            .unwrap_or("");
        let folder_is_conflict = is_synology_conflict_file(att_folder_name);

        let is_conflict = file_is_conflict || folder_is_conflict;
        let conflict_original = if file_is_conflict {
            file_conflict_original
        } else if folder_is_conflict {
            get_original_from_conflict(&PathBuf::from(att_folder))
                .map(|orig_folder| orig_folder.join(&file_name).to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            String::new()
        };

        let clean_att_folder_name = if folder_is_conflict {
            let re = regex::Regex::new(r" \(Synology(?:Drive)? [Cc]onflict[^)]*\)").unwrap();
            re.replace(att_folder_name, "").to_string()
        } else {
            att_folder_name.to_string()
        };
        let base_name = if clean_att_folder_name.ends_with("_att") {
            &clean_att_folder_name[..clean_att_folder_name.len() - 4]
        } else {
            &clean_att_folder_name
        };

        let note_file_name = if base_name.ends_with(".md") {
            base_name.to_string()
        } else {
            format!("{}.md", base_name)
        };

        let note_parent = att_folder.parent().unwrap_or(vault);
        let actual_note_path = note_parent.join(&note_file_name);

        let note_exists = actual_note_path.exists();

        let note_name = note_file_name[..note_file_name.len() - 3].to_string();

        let file_name_lower = file_name.to_lowercase();

        let file_name_without_md = if file_name_lower.ends_with(".md") {
            file_name_lower[..file_name_lower.len() - 3].to_string()
        } else {
            file_name_lower.clone()
        };

        let is_linked_in_md = if note_exists {
            if let Ok(content) = std::fs::read_to_string(&actual_note_path) {
                let content_lower = content.to_lowercase();

                let html_wiki_link = format!("data-wiki-link=\"{}\"", file_name_lower);
                let html_wiki_link_no_ext = format!("data-wiki-link=\"{}\"", file_name_without_md);

                if content_lower.contains(&html_wiki_link) || content_lower.contains(&html_wiki_link_no_ext) {
                    true
                } else {
                    let wiki_link_pattern = format!("[[{}]]", file_name_lower);
                    let wiki_link_pattern_no_ext = format!("[[{}]]", file_name_without_md);
                    let embed_pattern = format!("![[{}]]", file_name_lower);
                    let embed_pattern_no_ext = format!("![[{}]]", file_name_without_md);

                    let md_link_contains = content_lower.contains(&format!("]({})", file_name_lower))
                        || content_lower.contains(&format!("]({})", file_name_lower.replace(" ", "%20")))
                        || content_lower.contains(&format!("]({})", file_name_without_md))
                        || content_lower.contains(&format!("/{}", file_name_lower).as_str());

                    content_lower.contains(&wiki_link_pattern)
                        || content_lower.contains(&wiki_link_pattern_no_ext)
                        || content_lower.contains(&embed_pattern)
                        || content_lower.contains(&embed_pattern_no_ext)
                        || md_link_contains
                }
            } else {
                false
            }
        } else {
            false
        };

        let attachment_path_normalized = path.to_string_lossy().to_lowercase().replace("\\", "/");

        let attachment_relative = path.strip_prefix(vault)
            .map(|p| p.to_string_lossy().to_lowercase().replace("\\", "/"))
            .unwrap_or_default();

        let (is_linked, linked_note_path) = if is_linked_in_md {
            (true, actual_note_path.clone())
        } else {
            let mut found_in_canvas: Option<PathBuf> = None;

            let check_canvas_nodes = |content: &str, is_md_file: bool| -> bool {
                let json_str = if is_md_file {
                    if !content.contains("canvas: true") && !content.contains("canvas:true") {
                        return false;
                    }
                    if let Some(start) = content.find("---") {
                        if let Some(end) = content[start + 3..].find("---") {
                            let after_frontmatter = &content[start + 3 + end + 3..];
                            after_frontmatter.trim()
                        } else {
                            return false;
                        }
                    } else {
                        return false;
                    }
                } else {
                    content
                };

                if let Ok(canvas_json) = serde_json::from_str::<serde_json::Value>(json_str) {
                    if let Some(nodes) = canvas_json.get("nodes").and_then(|n| n.as_array()) {
                        for node in nodes {
                            if node.get("type").and_then(|t| t.as_str()) == Some("file") {
                                if let Some(node_file_path) = node.get("file").and_then(|f| f.as_str()) {
                                    let node_file_normalized = node_file_path.to_lowercase().replace("\\", "/");

                                    let is_match = node_file_normalized == attachment_path_normalized
                                        || node_file_normalized == attachment_relative
                                        || node_file_normalized.ends_with(&format!("/{}", attachment_relative))
                                        || attachment_path_normalized.ends_with(&format!("/{}", node_file_normalized))
                                        || (
                                            !file_name_lower.is_empty() &&
                                            node_file_normalized.ends_with(&file_name_lower) &&
                                            node_file_normalized.contains("_att/")
                                        );

                                    if is_match {
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                }
                false
            };

            for canvas_entry in WalkDir::new(&vault)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    if !e.file_type().is_file() {
                        return false;
                    }
                    let ext = e.path().extension().and_then(|x| x.to_str()).unwrap_or("");
                    ext.eq_ignore_ascii_case("canvas") || ext.eq_ignore_ascii_case("md")
                })
            {
                if let Ok(file_content) = std::fs::read_to_string(canvas_entry.path()) {
                    let ext = canvas_entry.path().extension().and_then(|x| x.to_str()).unwrap_or("");
                    let is_md = ext.eq_ignore_ascii_case("md");

                    if is_md && !file_content.contains("canvas:") {
                        continue;
                    }

                    if check_canvas_nodes(&file_content, is_md) {
                        found_in_canvas = Some(canvas_entry.path().to_path_buf());
                        break;
                    }
                }
            }

            if let Some(canvas_path) = found_in_canvas {
                (true, canvas_path)
            } else {
                (false, actual_note_path.clone())
            }
        };

        let display_note_path = if is_linked {
            &linked_note_path
        } else {
            &actual_note_path
        };

        let inferred_note_path = if is_linked || note_exists {
            display_note_path.strip_prefix(vault)
                .ok()
                .and_then(|p: &Path| p.to_str())
                .map(|s| {
                    if s.ends_with(".md") {
                        &s[..s.len() - 3]
                    } else if s.ends_with(".canvas") {
                        &s[..s.len() - 7]
                    } else {
                        s
                    }
                })
                .unwrap_or("-")
                .replace("\\", "/")
        } else {
            "-".to_string()
        };

        let note_relative_path = if is_linked {
            inferred_note_path.clone()
        } else {
            "-".to_string()
        };

        let container = note_parent.strip_prefix(vault)
            .ok()
            .and_then(|p: &Path| p.components().next())
            .and_then(|c| {
                if let std::path::Component::Normal(name) = c {
                    name.to_str()
                } else {
                    None
                }
            })
            .unwrap_or("")
            .to_string();

        if !query.is_empty() {
            let matches = file_name.to_lowercase().contains(&query_lower)
                || note_name.to_lowercase().contains(&query_lower)
                || note_relative_path.to_lowercase().contains(&query_lower)
                || container.to_lowercase().contains(&query_lower);

            if !matches {
                continue;
            }
        }

        let display_note_name = if is_linked {
            linked_note_path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&note_name)
                .to_string()
        } else {
            note_name.clone()
        };

        results.push(AttachmentInfo {
            path: path.to_string_lossy().to_string(),
            file_name,
            note_path: if is_linked {
                linked_note_path.to_string_lossy().to_string()
            } else {
                String::new()
            },
            note_name: display_note_name,
            note_relative_path,
            inferred_note_path,
            container,
            is_conflict,
            conflict_original,
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn check_attachment_references(
    vault_path: String,
    file_name: String,
) -> Result<Vec<String>, String> {
    use walkdir::WalkDir;

    let vault = Path::new(&vault_path);
    let file_name_lower = file_name.to_lowercase();
    let mut referencing_notes = Vec::new();

    for entry in WalkDir::new(&vault)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();

        if !path.extension().map_or(false, |ext| ext == "md") {
            continue;
        }

        if let Ok(content) = std::fs::read_to_string(path) {
            let content_lower = content.to_lowercase();

            let html_wiki_link = format!("data-wiki-link=\"{}\"", file_name_lower);
            let wiki_link_pattern = format!("[[{}]]", file_name_lower);
            let embed_pattern = format!("![[{}]]", file_name_lower);
            let md_link_contains = content_lower.contains(&format!("]({})", file_name_lower))
                || content_lower.contains(&format!("]({})", file_name_lower.replace(" ", "%20")))
                || content_lower.contains(&format!("/{}", file_name_lower).as_str());

            if content_lower.contains(&html_wiki_link)
                || content_lower.contains(&wiki_link_pattern)
                || content_lower.contains(&embed_pattern)
                || md_link_contains
            {
                referencing_notes.push(path.to_string_lossy().to_string());
            }
        }
    }

    Ok(referencing_notes)
}

#[tauri::command]
pub async fn delete_multiple_files(paths: Vec<String>) -> Result<usize, String> {
    let mut deleted_count = 0;
    let mut errors = Vec::new();

    for path in paths {
        let path_obj = Path::new(&path);
        if !path_obj.exists() {
            errors.push(format!("{}: File does not exist", path));
            continue;
        }
        match fs::remove_file(path_obj) {
            Ok(_) => deleted_count += 1,
            Err(e) => errors.push(format!("{}: {}", path, e)),
        }
    }

    if !errors.is_empty() && deleted_count == 0 {
        return Err(format!("Failed to delete files:\n{}", errors.join("\n")));
    }

    Ok(deleted_count)
}

#[tauri::command]
pub async fn delete_attachments_with_links(paths: Vec<String>) -> Result<(usize, usize, Vec<String>), String> {
    use regex::Regex;

    let mut deleted_count = 0;
    let mut links_removed_count = 0;
    let mut modified_notes: Vec<String> = Vec::new();
    let mut errors = Vec::new();

    let create_wikilink_regex = |filename: &str| -> Result<Regex, String> {
        let escaped = regex::escape(filename);
        Regex::new(&format!(
            r#"(?m)^[ \t]*[-*][ \t]*<span[^>]*data-wiki-link="{}"[^>]*>[^<]*</span>[ \t]*\n?|<span[^>]*data-wiki-link="{}"[^>]*>[^<]*</span>|\[\[{}\]\]|!\[\[{}\]\]"#,
            escaped, escaped, escaped, escaped
        )).map_err(|e| e.to_string())
    };

    for path in paths {
        let path_obj = Path::new(&path);
        if !path_obj.exists() {
            errors.push(format!("{}: File does not exist", path));
            continue;
        }

        let file_name = match path_obj.file_name() {
            Some(name) => name.to_string_lossy().to_string(),
            None => {
                errors.push(format!("{}: Invalid file path", path));
                continue;
            }
        };

        let parent_dir = match path_obj.parent() {
            Some(p) => p,
            None => {
                errors.push(format!("{}: Cannot determine parent directory", path));
                continue;
            }
        };

        let parent_name = parent_dir.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let owning_note_path = if parent_name.ends_with("_att") {
            let note_stem = &parent_name[..parent_name.len() - 4];
            let note_dir = parent_dir.parent().unwrap_or(parent_dir);
            let note_path = note_dir.join(format!("{}.md", note_stem));
            if note_path.exists() {
                Some(note_path)
            } else {
                None
            }
        } else {
            None
        };

        let file_name_without_md = if file_name.to_lowercase().ends_with(".md") {
            file_name[..file_name.len() - 3].to_string()
        } else {
            file_name.clone()
        };

        println!("[DEBUG delete_attachments_with_links] file_name: {}, file_name_without_md: {}, parent_name: {}", file_name, file_name_without_md, parent_name);
        println!("[DEBUG delete_attachments_with_links] owning_note_path: {:?}", owning_note_path);

        if let Some(note_path) = owning_note_path {
            println!("[DEBUG delete_attachments_with_links] Reading note: {:?}", note_path);
            if let Ok(content) = fs::read_to_string(&note_path) {
                let filenames_to_try: Vec<&str> = if file_name != file_name_without_md {
                    vec![&file_name, &file_name_without_md]
                } else {
                    vec![&file_name]
                };

                let mut current_content = content.clone();
                let mut total_matches = 0;

                for fname in filenames_to_try {
                    if let Ok(regex) = create_wikilink_regex(fname) {
                        let matches_found = regex.find_iter(&current_content).count();
                        if matches_found > 0 {
                            println!("[DEBUG delete_attachments_with_links] Found {} matches for '{}'", matches_found, fname);
                            current_content = regex.replace_all(&current_content, "").to_string();
                            total_matches += matches_found;
                        }
                    }
                }

                if total_matches > 0 {
                    let cleaned_content = current_content
                        .lines()
                        .collect::<Vec<_>>()
                        .join("\n");

                    println!("[DEBUG delete_attachments_with_links] Content len: {} -> {}", content.len(), cleaned_content.len());

                    if cleaned_content != content {
                        match fs::write(&note_path, &cleaned_content) {
                            Ok(_) => {
                                println!("[DEBUG delete_attachments_with_links] Successfully wrote updated note");
                                links_removed_count += total_matches;
                                if !modified_notes.contains(&note_path.to_string_lossy().to_string()) {
                                    modified_notes.push(note_path.to_string_lossy().to_string());
                                }
                            }
                            Err(e) => {
                                println!("[DEBUG delete_attachments_with_links] Failed to write note: {}", e);
                            }
                        }
                    } else {
                        println!("[DEBUG delete_attachments_with_links] No changes to write");
                    }
                } else {
                    println!("[DEBUG delete_attachments_with_links] No matches found");
                }
            } else {
                println!("[DEBUG delete_attachments_with_links] Failed to read note file");
            }
        } else {
            println!("[DEBUG delete_attachments_with_links] No owning note found");
        }

        match fs::remove_file(path_obj) {
            Ok(_) => deleted_count += 1,
            Err(e) => errors.push(format!("{}: {}", path, e)),
        }
    }

    if !errors.is_empty() && deleted_count == 0 {
        return Err(format!("Failed to delete files:\n{}", errors.join("\n")));
    }

    Ok((deleted_count, links_removed_count, modified_notes))
}
