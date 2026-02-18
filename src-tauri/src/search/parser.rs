use regex::Regex;
use std::collections::HashMap;

/// Extract wiki-links ([[...]]) from content
/// Handles filenames containing ] by using non-greedy matching until ]]
pub fn extract_wiki_links(content: &str) -> Vec<String> {
    // .+? = non-greedy, ]] 가 먼저 나오면 중단
    // 예: [[[디자인여백플러스] 파일.pdf]] -> [디자인여백플러스] 파일.pdf
    let re = Regex::new(r"\[\[(.+?)\]\]").unwrap();
    re.captures_iter(content)
        .map(|cap| {
            let full = cap[1].to_string();
            // Strip alias part: "fileName|displayText" → "fileName"
            if let Some(pipe_idx) = full.find('|') {
                full[..pipe_idx].to_string()
            } else {
                full
            }
        })
        .collect()
}

/// Split frontmatter and body from markdown content
pub fn split_frontmatter_body(content: &str) -> (Option<String>, String) {
    if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("\n---") {
            let frontmatter = content[3..end_idx + 3].trim().to_string();
            let body_start = end_idx + 3 + 4;
            let body = if body_start < content.len() {
                content[body_start..].trim_start_matches('\n').to_string()
            } else {
                String::new()
            };
            return (Some(frontmatter), body);
        }
    }
    (None, content.to_string())
}

/// Parse YAML frontmatter into a HashMap
pub fn parse_frontmatter(raw: &str) -> HashMap<String, serde_yaml::Value> {
    serde_yaml::from_str(raw).unwrap_or_default()
}

/// Extract title from frontmatter or filename
pub fn extract_title(frontmatter: &HashMap<String, serde_yaml::Value>, file_name: &str) -> String {
    if let Some(title) = frontmatter.get("title") {
        if let Some(s) = title.as_str() {
            return s.to_string();
        }
    }
    file_name.trim_end_matches(".md").to_string()
}

/// Strip namespace prefix from tag if present
fn strip_namespace_prefix(tag: &str) -> &str {
    let namespaces = ["domain/", "who/", "org/", "ctx/"];
    let mut result = tag;
    // Strip prefix multiple times to handle double prefixes like "domain/domain/tag"
    for _ in 0..2 {
        for ns in &namespaces {
            if result.starts_with(ns) {
                result = &result[ns.len()..];
            }
        }
    }
    result
}

/// Extract tags from frontmatter
/// Handles both legacy array format and new faceted tags format
/// Returns tags with namespace prefix (e.g., "domain/특허출원") for faceted tags
pub fn extract_tags(frontmatter: &HashMap<String, serde_yaml::Value>) -> Vec<String> {
    if let Some(tags) = frontmatter.get("tags") {
        // Try new faceted tags format (object with namespaces)
        if let Some(mapping) = tags.as_mapping() {
            let mut all_tags = Vec::new();
            for (namespace, tag_list) in mapping {
                // Get namespace as string (e.g., "domain", "who", "org", "ctx")
                let ns_str = namespace.as_str().unwrap_or("domain");
                if let Some(seq) = tag_list.as_sequence() {
                    for tag in seq {
                        if let Some(tag_str) = tag.as_str() {
                            // Strip any existing namespace prefix to avoid duplicates
                            let clean_tag = strip_namespace_prefix(tag_str);
                            // Include namespace prefix for proper categorization
                            all_tags.push(format!("{}/{}", ns_str, clean_tag));
                        }
                    }
                }
            }
            if !all_tags.is_empty() {
                return all_tags;
            }
        }

        // Try legacy array format (no namespace prefix)
        if let Some(seq) = tags.as_sequence() {
            return seq
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
        }
    }
    Vec::new()
}

/// Extract note type from frontmatter
pub fn extract_note_type(frontmatter: &HashMap<String, serde_yaml::Value>) -> String {
    if let Some(t) = frontmatter.get("type") {
        if let Some(s) = t.as_str() {
            return s.to_string();
        }
    }
    "NOTE".to_string()
}

/// Extract a date field from frontmatter
pub fn extract_date_field(frontmatter: &HashMap<String, serde_yaml::Value>, field: &str) -> String {
    if let Some(v) = frontmatter.get(field) {
        if let Some(s) = v.as_str() {
            return s.to_string();
        }
    }
    String::new()
}
