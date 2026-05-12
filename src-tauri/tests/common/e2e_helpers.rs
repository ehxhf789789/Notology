//! E2E test helpers for sync_v2.
//! NAS 기반 setup은 NOTOLOGY_TEST_NAS_URL 환경변수 필요 (없으면 Option::None 반환).
//! InMemory 기반 setup은 환경변수 무관.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;

use app_lib::core::cas::CasStore;
use app_lib::core::refs::{NoteRef, RefStore};
use app_lib::core::sync_provider::{SyncProvider, SyncProviderError, RefVersion, RefMetadata, DeviceStateInfo, RemoteChild};
use async_trait::async_trait;
use std::sync::Mutex as StdMutex;
use app_lib::core::version_dag::VersionDag;
use app_lib::features::sync_v2::in_memory_provider::InMemorySyncProvider;
use app_lib::features::sync_v2::sync_engine::{SyncConfig, SyncEngine, SyncReport};
use app_lib::features::sync_v2::webdav_provider::WebDavProvider;
use app_lib::core::webdav::WebDavClient;

// ── Types ───────────────────────────────────────────────

pub struct DeviceEnv {
    pub device_id: String,
    pub vault_path: PathBuf,
    pub cas_store: Arc<CasStore>,
    pub ref_store: Arc<RefStore>,
    pub engine: Arc<SyncEngine>,
    _tempdir: tempfile::TempDir,
}

pub struct MultiDeviceEnv {
    pub nas_base: String,
    pub devices: Vec<DeviceEnv>,
}

impl MultiDeviceEnv {
    /// NAS base prefix 삭제 시도 (best-effort).
    pub async fn cleanup(self) {
        // For NAS tests, we don't clean up remote — ephemeral test prefix is unique.
        // Local tempdirs cleaned by Drop of _tempdir.
        drop(self);
    }
}

// ── Setup (NAS) ─────────────────────────────────────────

/// NOTOLOGY_TEST_NAS_URL 미설정 시 None 반환.
/// n개 DeviceEnv 모두 동일 nas_base 공유, device_id는 "dev-a".."dev-z".
pub async fn setup_devices(n: usize) -> Option<MultiDeviceEnv> {
    setup_devices_internal(n, None).await
}

/// S4 전용: polling_interval 지정.
pub async fn setup_devices_with_polling(n: usize, interval: Duration) -> Option<MultiDeviceEnv> {
    setup_devices_internal(n, Some(interval)).await
}

async fn setup_devices_internal(n: usize, polling_interval: Option<Duration>) -> Option<MultiDeviceEnv> {
    assert!(n > 0 && n <= 26, "n must be 1..=26");

    let nas_url = std::env::var("NOTOLOGY_TEST_NAS_URL").ok()?;
    let nas_user = std::env::var("NOTOLOGY_TEST_NAS_USER").ok()?;
    let nas_pass = std::env::var("NOTOLOGY_TEST_NAS_PASS").ok()?;
    let nas_base_prefix = std::env::var("NOTOLOGY_TEST_NAS_BASE").ok()?;

    let nas_base = format!(
        "{}/e2e_{}_{}",
        nas_base_prefix.trim_end_matches('/'),
        uuid::Uuid::new_v4().simple(),
        std::process::id(),
    );

    let mut devices = Vec::with_capacity(n);
    for i in 0..n {
        let device_id = format!("dev-{}", (b'a' + i as u8) as char);
        let dir = tempfile::tempdir().ok()?;
        let vault_path = dir.path().to_path_buf();
        let cas = Arc::new(CasStore::new(&vault_path).ok()?);
        let refs = Arc::new(RefStore::new(&vault_path).ok()?);

        let client = WebDavClient::new(&nas_url, &nas_user, &nas_pass).ok()?;
        let provider: Arc<dyn SyncProvider> = Arc::new(WebDavProvider::new(client, nas_base.clone()));

        let mut engine = SyncEngine::new(
            device_id.clone(), provider, cas.clone(), refs.clone(), vault_path.clone(),
        );
        if let Some(interval) = polling_interval {
            engine = engine.with_config(SyncConfig { polling_interval: interval });
        }

        devices.push(DeviceEnv {
            device_id,
            vault_path,
            cas_store: cas,
            ref_store: refs,
            engine: Arc::new(engine),
            _tempdir: dir,
        });
    }

    Some(MultiDeviceEnv { nas_base, devices })
}

// ── Setup (InMemory) ────────────────────────────────────

/// InMemory with custom polling interval (for S4).
pub async fn setup_devices_inmemory_with_polling(n: usize, interval: Duration) -> MultiDeviceEnv {
    assert!(n > 0 && n <= 26);
    let shared_provider: Arc<dyn SyncProvider> = Arc::new(InMemorySyncProvider::new());
    let mut devices = Vec::with_capacity(n);
    for i in 0..n {
        let device_id = format!("dev-{}", (b'a' + i as u8) as char);
        let dir = tempfile::tempdir().expect("tempdir");
        let vault_path = dir.path().to_path_buf();
        let cas = Arc::new(CasStore::new(&vault_path).expect("cas"));
        let refs = Arc::new(RefStore::new(&vault_path).expect("refs"));
        let engine = SyncEngine::new(
            device_id.clone(), shared_provider.clone(), cas.clone(), refs.clone(), vault_path.clone(),
        ).with_config(SyncConfig { polling_interval: interval });
        devices.push(DeviceEnv {
            device_id, vault_path, cas_store: cas, ref_store: refs,
            engine: Arc::new(engine), _tempdir: dir,
        });
    }
    MultiDeviceEnv { nas_base: "inmemory-polling".to_string(), devices }
}

/// InMemoryProvider 기반. NAS 환경변수 불필요. 항상 성공.
pub async fn setup_devices_inmemory(n: usize) -> MultiDeviceEnv {
    assert!(n > 0 && n <= 26, "n must be 1..=26");

    let shared_provider: Arc<dyn SyncProvider> = Arc::new(InMemorySyncProvider::new());

    let mut devices = Vec::with_capacity(n);
    for i in 0..n {
        let device_id = format!("dev-{}", (b'a' + i as u8) as char);
        let dir = tempfile::tempdir().expect("tempdir");
        let vault_path = dir.path().to_path_buf();
        let cas = Arc::new(CasStore::new(&vault_path).expect("cas"));
        let refs = Arc::new(RefStore::new(&vault_path).expect("refs"));

        let engine = SyncEngine::new(
            device_id.clone(), shared_provider.clone(), cas.clone(), refs.clone(), vault_path.clone(),
        );

        devices.push(DeviceEnv {
            device_id,
            vault_path,
            cas_store: cas,
            ref_store: refs,
            engine: Arc::new(engine),
            _tempdir: dir,
        });
    }

    MultiDeviceEnv {
        nas_base: "inmemory".to_string(),
        devices,
    }
}

/// InMemory with delay injection on the shared provider (for S5 concurrent test).
pub async fn setup_devices_inmemory_with_delay(n: usize, delay_ms: u64) -> (MultiDeviceEnv, Arc<InMemorySyncProvider>) {
    assert!(n > 0 && n <= 26);

    let shared_provider = Arc::new(InMemorySyncProvider::new());
    shared_provider.set_delay(delay_ms);

    let mut devices = Vec::with_capacity(n);
    for i in 0..n {
        let device_id = format!("dev-{}", (b'a' + i as u8) as char);
        let dir = tempfile::tempdir().expect("tempdir");
        let vault_path = dir.path().to_path_buf();
        let cas = Arc::new(CasStore::new(&vault_path).expect("cas"));
        let refs = Arc::new(RefStore::new(&vault_path).expect("refs"));

        let engine = SyncEngine::new(
            device_id.clone(), shared_provider.clone() as Arc<dyn SyncProvider>,
            cas.clone(), refs.clone(), vault_path.clone(),
        );

        devices.push(DeviceEnv {
            device_id,
            vault_path,
            cas_store: cas,
            ref_store: refs,
            engine: Arc::new(engine),
            _tempdir: dir,
        });
    }

    let env = MultiDeviceEnv {
        nas_base: "inmemory-delay".to_string(),
        devices,
    };
    (env, shared_provider)
}

/// InMemory with network partition control (for S6 fail injection).
pub async fn setup_devices_inmemory_with_partition(n: usize) -> (MultiDeviceEnv, Arc<InMemorySyncProvider>) {
    assert!(n > 0 && n <= 26);

    let shared_provider = Arc::new(InMemorySyncProvider::new());

    let mut devices = Vec::with_capacity(n);
    for i in 0..n {
        let device_id = format!("dev-{}", (b'a' + i as u8) as char);
        let dir = tempfile::tempdir().expect("tempdir");
        let vault_path = dir.path().to_path_buf();
        let cas = Arc::new(CasStore::new(&vault_path).expect("cas"));
        let refs = Arc::new(RefStore::new(&vault_path).expect("refs"));

        let engine = SyncEngine::new(
            device_id.clone(), shared_provider.clone() as Arc<dyn SyncProvider>,
            cas.clone(), refs.clone(), vault_path.clone(),
        );

        devices.push(DeviceEnv {
            device_id,
            vault_path,
            cas_store: cas,
            ref_store: refs,
            engine: Arc::new(engine),
            _tempdir: dir,
        });
    }

    let env = MultiDeviceEnv {
        nas_base: "inmemory-partition".to_string(),
        devices,
    };
    (env, shared_provider)
}

// ── Setup with legacy (S3) ──────────────────────────────

/// Device 0 vault에 legacy `.notology/sync/` 디렉토리 + 더미 state files.
/// NAS 기반. env 없으면 None.
pub async fn setup_devices_with_legacy_a(n: usize) -> Option<MultiDeviceEnv> {
    let env = setup_devices(n).await?;

    // Create legacy sync directory with dummy files on device 0
    let legacy_dir = env.devices[0].vault_path.join(".notology/sync");
    std::fs::create_dir_all(&legacy_dir).expect("create legacy dir");
    std::fs::write(legacy_dir.join("state.json"), br#"{"version":1,"last_sync":"2026-01-01T00:00:00Z"}"#)
        .expect("write legacy state");
    std::fs::write(legacy_dir.join("manifest.json"), br#"{"files":{}}"#)
        .expect("write legacy manifest");

    // Also create a note so migration has something to work with
    create_note_on(&env, 0, "20260101000001", "legacy note content").await;

    Some(env)
}

// ── Mutation ────────────────────────────────────────────

/// 14자리 note_id 기반 .md 파일 작성 + frontmatter 포함.
/// CAS write + DAG append + RefStore set.
pub async fn create_note_on(env: &MultiDeviceEnv, idx: usize, note_id: &str, body: &str) {
    let dev = &env.devices[idx];
    let content = format!("---\nid: {}\ntitle: Note {}\n---\n{}", note_id, note_id, body);
    let hash = dev.cas_store.write_object(content.as_bytes()).expect("cas write");

    let mut dag = VersionDag::load(&dev.vault_path, note_id).unwrap_or_default();
    dag.append(hash.clone(), None, dev.device_id.clone(), vec![]);
    dag.save(&dev.vault_path, note_id).expect("dag save");

    dev.ref_store.set(&NoteRef {
        note_id: note_id.into(),
        head_hash: hash,
        relative_path: format!("{}.md", note_id),
        updated_at: Utc::now(),
        sync_etag: None,
    }).expect("ref set");

    // Also write the .md file to disk
    let md_path = dev.vault_path.join(format!("{}.md", note_id));
    std::fs::write(&md_path, content.as_bytes()).expect("write md");
}

/// note_id 기존 노트 수정. parent = 현재 head.
pub async fn edit_note_on(env: &MultiDeviceEnv, idx: usize, note_id: &str, body: &str) {
    let dev = &env.devices[idx];
    let content = format!("---\nid: {}\ntitle: Note {}\n---\n{}", note_id, note_id, body);

    let old_ref = dev.ref_store.get(note_id).expect("ref get").expect("ref exists");
    let old_hash = old_ref.head_hash.clone();

    let hash = dev.cas_store.write_object(content.as_bytes()).expect("cas write");

    let mut dag = VersionDag::load(&dev.vault_path, note_id).unwrap_or_default();
    dag.append(hash.clone(), Some(old_hash), dev.device_id.clone(), vec![]);
    dag.save(&dev.vault_path, note_id).expect("dag save");

    dev.ref_store.set(&NoteRef {
        note_id: note_id.into(),
        head_hash: hash,
        relative_path: format!("{}.md", note_id),
        updated_at: Utc::now(),
        sync_etag: None,
    }).expect("ref set");

    let md_path = dev.vault_path.join(format!("{}.md", note_id));
    std::fs::write(&md_path, content.as_bytes()).expect("write md");
}

/// note_id 자동 생성 batch.
pub async fn create_notes_batch(env: &MultiDeviceEnv, idx: usize, count: usize) {
    for i in 1..=count {
        let note_id = format!("{:014}", i);
        let body = format!("Batch note {}", i);
        create_note_on(env, idx, &note_id, &body).await;
    }
}

// ── Sync triggers ───────────────────────────────────────

pub async fn sync(env: &MultiDeviceEnv, idx: usize) -> Result<SyncReport, String> {
    env.devices[idx].engine.sync_once().await
}

pub async fn start_polling(env: &MultiDeviceEnv, idx: usize) {
    Arc::clone(&env.devices[idx].engine).start_polling().await;
}

/// tokio::time::advance + yield_now 반복 (polling task 실행 기회 부여).
pub async fn advance_and_yield(interval: Duration) {
    tokio::time::advance(interval).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

// ── Assertions ──────────────────────────────────────────

pub async fn assert_same_head(env: &MultiDeviceEnv, a: usize, b: usize, note_id: &str) {
    let ref_a = env.devices[a].ref_store.get(note_id)
        .expect("ref_store get")
        .unwrap_or_else(|| panic!("device {} has no ref for {}", a, note_id));
    let ref_b = env.devices[b].ref_store.get(note_id)
        .expect("ref_store get")
        .unwrap_or_else(|| panic!("device {} has no ref for {}", b, note_id));
    assert_eq!(
        ref_a.head_hash, ref_b.head_hash,
        "head mismatch for {} between device {} ({}) and device {} ({})",
        note_id, a, ref_a.head_hash, b, ref_b.head_hash,
    );
}

pub async fn assert_all_converged(env: &MultiDeviceEnv, note_id: &str) {
    let n = env.devices.len();
    for i in 1..n {
        assert_same_head(env, 0, i, note_id).await;
    }
}

pub async fn assert_file_exists(env: &MultiDeviceEnv, idx: usize, note_id: &str) {
    let has_ref = env.devices[idx].ref_store.get(note_id)
        .expect("ref_store get").is_some();
    assert!(has_ref, "device {} missing ref for {}", idx, note_id);
}

pub async fn assert_branch_count(env: &MultiDeviceEnv, idx: usize, note_id: &str, expected: usize) {
    let conflicts = env.devices[idx].engine.list_conflicts().await.expect("list_conflicts");
    let count = conflicts.iter()
        .find(|c| c.note_id == note_id)
        .map(|c| c.branches.len())
        .unwrap_or(0);
    assert_eq!(
        count, expected,
        "device {} note {} branch count: expected {}, got {}",
        idx, note_id, expected, count,
    );
}

// ── FailInjectingProvider (S6) ──────────────────────────

/// Wraps InMemorySyncProvider, injecting failures on the nth put_object call.
pub struct FailInjectingProvider {
    inner: Arc<InMemorySyncProvider>,
    fail_on_put_object_nth: StdMutex<Option<u32>>,
    put_object_count: StdMutex<u32>,
}

impl FailInjectingProvider {
    pub fn new(inner: Arc<InMemorySyncProvider>) -> Self {
        Self {
            inner,
            fail_on_put_object_nth: StdMutex::new(None),
            put_object_count: StdMutex::new(0),
        }
    }

    pub fn set_fail_at(&self, nth: Option<u32>) {
        *self.fail_on_put_object_nth.lock().unwrap() = nth;
        *self.put_object_count.lock().unwrap() = 0; // reset counter
    }
}

#[async_trait]
impl SyncProvider for FailInjectingProvider {
    async fn put_object(&self, hash: &str, data: &[u8]) -> Result<(), SyncProviderError> {
        {
            let mut count = self.put_object_count.lock().unwrap();
            *count += 1;
            let n = *count;
            let fail_at = *self.fail_on_put_object_nth.lock().unwrap();
            if fail_at == Some(n) {
                return Err(SyncProviderError::Other(
                    format!("FailInjecting: intentional fail at put_object #{}", n),
                ));
            }
        }
        self.inner.put_object(hash, data).await
    }
    async fn get_object(&self, hash: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        self.inner.get_object(hash).await
    }
    async fn has_object(&self, hash: &str) -> Result<bool, SyncProviderError> {
        self.inner.has_object(hash).await
    }
    async fn list_objects(&self) -> Result<Vec<String>, SyncProviderError> {
        self.inner.list_objects().await
    }
    async fn put_ref(&self, note_id: &str, content: &[u8]) -> Result<RefVersion, SyncProviderError> {
        self.inner.put_ref(note_id, content).await
    }
    async fn get_ref(&self, note_id: &str) -> Result<Option<(Vec<u8>, RefVersion)>, SyncProviderError> {
        self.inner.get_ref(note_id).await
    }
    async fn list_refs(&self) -> Result<Vec<RefMetadata>, SyncProviderError> {
        self.inner.list_refs().await
    }
    async fn delete_ref(&self, note_id: &str) -> Result<(), SyncProviderError> {
        self.inner.delete_ref(note_id).await
    }
    async fn put_dag(&self, note_id: &str, content: &[u8]) -> Result<(), SyncProviderError> {
        self.inner.put_dag(note_id, content).await
    }
    async fn get_dag(&self, note_id: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        self.inner.get_dag(note_id).await
    }
    async fn put_md(&self, relative_path: &str, content: &[u8]) -> Result<(), SyncProviderError> {
        self.inner.put_md(relative_path, content).await
    }
    async fn get_md(&self, relative_path: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        self.inner.get_md(relative_path).await
    }
    async fn has_md(&self, relative_path: &str) -> Result<bool, SyncProviderError> {
        self.inner.has_md(relative_path).await
    }
    async fn delete_md(&self, relative_path: &str) -> Result<(), SyncProviderError> {
        self.inner.delete_md(relative_path).await
    }
    async fn list_md_dir(&self, relative_dir: &str) -> Result<Vec<RemoteChild>, SyncProviderError> {
        self.inner.list_md_dir(relative_dir).await
    }
    async fn put_device_state(&self, device_id: &str, content: &[u8]) -> Result<(), SyncProviderError> {
        self.inner.put_device_state(device_id, content).await
    }
    async fn get_device_state(&self, device_id: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        self.inner.get_device_state(device_id).await
    }
    async fn list_device_states(&self) -> Result<Vec<DeviceStateInfo>, SyncProviderError> {
        self.inner.list_device_states().await
    }
    async fn put_branch(&self, note_id: &str, branch_name: &str, content: &[u8]) -> Result<(), SyncProviderError> {
        self.inner.put_branch(note_id, branch_name, content).await
    }
    async fn list_branches(&self, note_id: &str) -> Result<Vec<String>, SyncProviderError> {
        self.inner.list_branches(note_id).await
    }
    async fn get_branch(&self, note_id: &str, branch_name: &str) -> Result<Option<Vec<u8>>, SyncProviderError> {
        self.inner.get_branch(note_id, branch_name).await
    }
    async fn delete_branch(&self, note_id: &str, branch_name: &str) -> Result<(), SyncProviderError> {
        self.inner.delete_branch(note_id, branch_name).await
    }
    async fn list_notes_with_branches(&self) -> Result<Vec<String>, SyncProviderError> {
        self.inner.list_notes_with_branches().await
    }
    async fn list_children(&self, remote_dir: &str) -> Result<Vec<RemoteChild>, SyncProviderError> {
        self.inner.list_children(remote_dir).await
    }
    async fn test_connection(&self) -> Result<bool, SyncProviderError> {
        self.inner.test_connection().await
    }
    async fn move_collection(&self, from_abs: &str, to_abs: &str) -> Result<(), SyncProviderError> {
        self.inner.move_collection(from_abs, to_abs).await
    }
    async fn delete_collection(&self, abs_path: &str) -> Result<(), SyncProviderError> {
        self.inner.delete_collection(abs_path).await
    }
}

/// InMemory with FailInjectingProvider on device idx.
pub async fn setup_devices_inmemory_with_fail_injection_on(
    n: usize, idx: usize,
) -> (MultiDeviceEnv, Arc<FailInjectingProvider>) {
    assert!(n > 0 && n <= 26);
    assert!(idx < n);

    let inner = Arc::new(InMemorySyncProvider::new());
    let fail_provider = Arc::new(FailInjectingProvider::new(inner.clone()));

    let mut devices = Vec::with_capacity(n);
    for i in 0..n {
        let device_id = format!("dev-{}", (b'a' + i as u8) as char);
        let dir = tempfile::tempdir().expect("tempdir");
        let vault_path = dir.path().to_path_buf();
        let cas = Arc::new(CasStore::new(&vault_path).expect("cas"));
        let refs = Arc::new(RefStore::new(&vault_path).expect("refs"));

        let provider: Arc<dyn SyncProvider> = if i == idx {
            fail_provider.clone()
        } else {
            inner.clone()
        };

        let engine = SyncEngine::new(
            device_id.clone(), provider, cas.clone(), refs.clone(), vault_path.clone(),
        );

        devices.push(DeviceEnv {
            device_id,
            vault_path,
            cas_store: cas,
            ref_store: refs,
            engine: Arc::new(engine),
            _tempdir: dir,
        });
    }

    let env = MultiDeviceEnv {
        nas_base: "inmemory-fail".to_string(),
        devices,
    };
    (env, fail_provider)
}
