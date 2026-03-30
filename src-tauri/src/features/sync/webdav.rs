use chrono::{DateTime, Utc};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Method, StatusCode};

/// Metadata for a remote file on the WebDAV server.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteFile {
    pub path: String,
    pub modified_at: DateTime<Utc>,
    pub size: u64,
    pub etag: Option<String>,
    pub is_collection: bool,
}

/// Lightweight metadata (single-file PROPFIND depth=0).
#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteFileMeta {
    pub path: String,
    pub modified_at: DateTime<Utc>,
    pub size: u64,
    pub etag: Option<String>,
}

/// Standard WebDAV client (RFC 4918). No vendor-specific APIs.
pub struct WebDavClient {
    base_url: String,
    client: Client,
    auth_header: HeaderValue,
}

impl WebDavClient {
    pub fn new(base_url: &str, username: &str, password: &str) -> Result<Self, String> {
        let base_url = base_url.trim_end_matches('/').to_string();

        // Basic auth
        let credentials = format!("{}:{}", username, password);
        let encoded = base64_encode(credentials.as_bytes());
        let auth_value = HeaderValue::from_str(&format!("Basic {}", encoded))
            .map_err(|e| format!("Invalid auth header: {}", e))?;

        let client = Client::builder()
            .danger_accept_invalid_certs(true) // NAS self-signed certs
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

        Ok(Self {
            base_url,
            client,
            auth_header: auth_value,
        })
    }

    /// Build the full URL for a resource path.
    fn url(&self, path: &str) -> String {
        let path = path.trim_start_matches('/');
        if path.is_empty() {
            format!("{}/", self.base_url)
        } else {
            format!("{}/{}", self.base_url, encode_path(path))
        }
    }

    /// Default headers for every request.
    fn headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, self.auth_header.clone());
        h
    }

    // ================================================================
    // Public API
    // ================================================================

    /// Test connection: PROPFIND / with Depth: 0.
    /// Returns Ok(true) if server responds with 207 Multi-Status.
    pub async fn test_connection(&self) -> Result<bool, String> {
        let mut headers = self.headers();
        headers.insert("Depth", HeaderValue::from_static("0"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/xml"));

        let body = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
  </D:prop>
</D:propfind>"#;

        let resp = self.client
            .request(Method::from_bytes(b"PROPFIND").unwrap(), &self.url(""))
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(|e| format!("Connection failed: {}", e))?;

        match resp.status() {
            StatusCode::MULTI_STATUS => Ok(true), // 207
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                Err("Authentication failed: wrong username or password".to_string())
            }
            status => Err(format!("Unexpected response: {}", status)),
        }
    }

    /// List files at a path: PROPFIND with Depth: 1.
    pub async fn list_files(&self, path: &str) -> Result<Vec<RemoteFile>, String> {
        let mut headers = self.headers();
        headers.insert("Depth", HeaderValue::from_static("1"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/xml"));

        let body = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:getlastmodified/>
    <D:getcontentlength/>
    <D:getetag/>
    <D:resourcetype/>
  </D:prop>
</D:propfind>"#;

        let resp = self.client
            .request(Method::from_bytes(b"PROPFIND").unwrap(), &self.url(path))
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(|e| format!("PROPFIND failed: {}", e))?;

        if resp.status() != StatusCode::MULTI_STATUS {
            return Err(format!("PROPFIND returned {}", resp.status()));
        }

        let xml = resp.text().await.map_err(|e| format!("Failed to read response: {}", e))?;
        parse_propfind_response(&xml, path)
    }

    /// Read a file: GET.
    pub async fn get_file(&self, path: &str) -> Result<Vec<u8>, String> {
        let resp = self.client
            .get(&self.url(path))
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| format!("GET failed: {}", e))?;

        if resp.status() == StatusCode::NOT_FOUND {
            return Err(format!("File not found: {}", path));
        }
        if !resp.status().is_success() {
            return Err(format!("GET returned {}", resp.status()));
        }

        resp.bytes().await
            .map(|b| b.to_vec())
            .map_err(|e| format!("Failed to read body: {}", e))
    }

    /// Write a file: PUT.
    pub async fn put_file(&self, path: &str, content: &[u8]) -> Result<(), String> {
        let resp = self.client
            .put(&self.url(path))
            .headers(self.headers())
            .timeout(std::time::Duration::from_secs(60))
            .body(content.to_vec())
            .send()
            .await
            .map_err(|e| format!("PUT failed: {}", e))?;

        match resp.status() {
            s if s.is_success() => Ok(()),
            StatusCode::INSUFFICIENT_STORAGE => Err("NAS 디스크 공간 부족 (507)".to_string()),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err("인증 실패 — 비밀번호를 확인하세요".to_string()),
            status => Err(format!("PUT returned {}", status)),
        }
    }

    /// Delete a file: DELETE.
    pub async fn delete_file(&self, path: &str) -> Result<(), String> {
        let resp = self.client
            .delete(&self.url(path))
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| format!("DELETE failed: {}", e))?;

        match resp.status() {
            s if s.is_success() => Ok(()),
            StatusCode::NOT_FOUND => Ok(()), // Already gone — idempotent
            status => Err(format!("DELETE returned {}", status)),
        }
    }

    /// Move/rename a resource: MOVE.
    pub async fn move_resource(&self, from_path: &str, to_path: &str) -> Result<(), String> {
        let mut headers = self.headers();
        let dest_url = self.url(to_path);
        headers.insert("Destination", HeaderValue::from_str(&dest_url)
            .map_err(|e| format!("Invalid destination: {}", e))?);
        headers.insert("Overwrite", HeaderValue::from_static("F"));

        let resp = self.client
            .request(Method::from_bytes(b"MOVE").unwrap(), &self.url(from_path))
            .headers(headers)
            .send()
            .await
            .map_err(|e| format!("MOVE failed: {}", e))?;

        match resp.status() {
            s if s.is_success() => Ok(()),
            StatusCode::PRECONDITION_FAILED => Err("대상 경로에 이미 같은 이름이 존재합니다".to_string()),
            status => Err(format!("MOVE returned {}", status)),
        }
    }

    /// Create a directory: MKCOL.
    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        let resp = self.client
            .request(Method::from_bytes(b"MKCOL").unwrap(), &self.url(path))
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| format!("MKCOL failed: {}", e))?;

        match resp.status() {
            s if s.is_success() => Ok(()),
            StatusCode::METHOD_NOT_ALLOWED => Ok(()), // Already exists
            status => Err(format!("MKCOL returned {}", status)),
        }
    }

    /// Get metadata for a single file: PROPFIND with Depth: 0.
    pub async fn get_metadata(&self, path: &str) -> Result<RemoteFileMeta, String> {
        let mut headers = self.headers();
        headers.insert("Depth", HeaderValue::from_static("0"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/xml"));

        let body = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:getlastmodified/>
    <D:getcontentlength/>
    <D:getetag/>
  </D:prop>
</D:propfind>"#;

        let resp = self.client
            .request(Method::from_bytes(b"PROPFIND").unwrap(), &self.url(path))
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(|e| format!("PROPFIND failed: {}", e))?;

        if resp.status() == StatusCode::NOT_FOUND {
            return Err(format!("File not found: {}", path));
        }
        if resp.status() != StatusCode::MULTI_STATUS {
            return Err(format!("PROPFIND returned {}", resp.status()));
        }

        let xml = resp.text().await.map_err(|e| format!("Failed to read response: {}", e))?;
        let files = parse_propfind_response(&xml, "")?;

        files.into_iter()
            .next()
            .map(|f| RemoteFileMeta {
                path: f.path,
                modified_at: f.modified_at,
                size: f.size,
                etag: f.etag,
            })
            .ok_or_else(|| "No metadata in response".to_string())
    }
}

// ================================================================
// XML parsing for PROPFIND responses
// ================================================================

fn parse_propfind_response(xml: &str, request_path: &str) -> Result<Vec<RemoteFile>, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut files = Vec::new();

    // State machine for parsing <D:response> elements
    let mut in_response = false;
    let mut in_propstat = false;
    let mut current_href: Option<String> = None;
    let mut current_modified: Option<DateTime<Utc>> = None;
    let mut current_size: u64 = 0;
    let mut current_etag: Option<String> = None;
    let mut is_collection = false;

    // Track current element name
    let mut current_element = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let local_name = local_tag_name(e.name().as_ref());

                match local_name.as_str() {
                    "response" => {
                        in_response = true;
                        current_href = None;
                        current_modified = None;
                        current_size = 0;
                        current_etag = None;
                        is_collection = false;
                    }
                    "propstat" => in_propstat = true,
                    "collection" if in_response => is_collection = true,
                    _ => {}
                }
                current_element = local_name;
            }
            Ok(Event::Text(ref e)) if in_response && !current_element.is_empty() => {
                let text = e.unescape().unwrap_or_default().to_string();
                let text = text.trim();
                if text.is_empty() {
                    // Skip whitespace-only text nodes
                    buf.clear();
                    continue;
                }
                match current_element.as_str() {
                    "href" => {
                        current_href = Some(decode_href(text));
                    }
                    "getlastmodified" => {
                        current_modified = parse_http_date(&text);
                    }
                    "getcontentlength" => {
                        current_size = text.trim().parse().unwrap_or(0);
                    }
                    "getetag" => {
                        let etag = text.trim().trim_matches('"').to_string();
                        if !etag.is_empty() {
                            current_etag = Some(etag);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => {
                let local_name = local_tag_name(e.name().as_ref());
                match local_name.as_str() {
                    "response" => {
                        if let Some(href) = current_href.take() {
                            // Skip the request path itself (first entry is the dir)
                            let normalized = href.trim_end_matches('/');
                            let req_normalized = request_path.trim_end_matches('/');
                            let is_self = normalized == req_normalized
                                || normalized.is_empty()
                                || href == "/";

                            if !is_self {
                                files.push(RemoteFile {
                                    path: href,
                                    modified_at: current_modified.unwrap_or_else(Utc::now),
                                    size: current_size,
                                    etag: current_etag.take(),
                                    is_collection,
                                });
                            }
                        }
                        in_response = false;
                    }
                    "propstat" => in_propstat = false,
                    _ => {}
                }
                // Clear current_element on any End tag to prevent
                // whitespace text nodes from being captured
                if local_name == current_element {
                    current_element.clear();
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {}", e)),
            _ => {}
        }
        buf.clear();
    }

    Ok(files)
}

/// Extract local tag name from potentially namespaced name (e.g. "D:href" → "href").
fn local_tag_name(name: &[u8]) -> String {
    let s = std::str::from_utf8(name).unwrap_or("");
    if let Some(pos) = s.rfind(':') {
        s[pos + 1..].to_string()
    } else {
        s.to_string()
    }
}

/// Parse HTTP-date (RFC 2616): "Sat, 29 Mar 2026 12:00:00 GMT"
fn parse_http_date(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    // Try RFC 2822 first (most WebDAV servers)
    if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(s) {
        return Some(dt.with_timezone(&Utc));
    }
    // Try common WebDAV format: "Sat, 29 Mar 2026 12:00:00 GMT"
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(
        s.trim_end_matches(" GMT"),
        "%a, %d %b %Y %H:%M:%S",
    ) {
        return Some(DateTime::from_naive_utc_and_offset(dt, Utc));
    }
    // ISO 8601 fallback
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    None
}

/// Percent-decode a URL path.
fn decode_href(href: &str) -> String {
    percent_decode(href)
}

fn percent_decode(s: &str) -> String {
    let mut result = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                result.push(byte);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| s.to_string())
}

/// Percent-encode a path (keep / intact, encode spaces and special chars).
fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            segment
                .as_bytes()
                .iter()
                .map(|&b| {
                    if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
                        format!("{}", b as char)
                    } else {
                        format!("%{:02X}", b)
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Simple base64 encoding (no dependency needed for this).
fn base64_encode(input: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}
