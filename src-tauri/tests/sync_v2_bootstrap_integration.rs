//! Bootstrap integration test for SyncEngineState lifecycle (4.10).

mod common;
use common::e2e_helpers::*;
use std::sync::Arc;
use app_lib::features::sync_v2::commands::SyncEngineState;

#[tokio::test]
async fn test_bootstrap_engine_state_lifecycle() {
    let Some(env) = setup_devices(1).await else {
        eprintln!("[BOOTSTRAP] NAS env missing, skip");
        return;
    };

    let state = SyncEngineState::new();

    // 1. Initial state is None
    assert!(state.get().is_none(), "initial state should be empty");

    // 2. Set engine
    let engine = env.devices[0].engine.clone();
    state.set(engine.clone());
    let retrieved = state.get().expect("should be set");
    assert!(Arc::ptr_eq(&engine, &retrieved), "should be same Arc");

    // 3. Engine can sync
    let report = retrieved.sync_once().await.expect("first sync should succeed");
    eprintln!("[BOOTSTRAP] sync_once: refs_pushed={:?}, errors={}", report.refs_pushed, report.errors.len());

    // 4. Clear
    state.clear();
    assert!(state.get().is_none(), "after clear should be empty");

    // 5. Re-set with different engine (vault change simulation)
    let Some(env2) = setup_devices(1).await else {
        eprintln!("[BOOTSTRAP] second env setup failed, skip remainder");
        env.cleanup().await;
        return;
    };
    let engine2 = env2.devices[0].engine.clone();
    state.set(engine2.clone());
    assert!(Arc::ptr_eq(&engine2, &state.get().unwrap()));

    eprintln!("[BOOTSTRAP] state lifecycle OK");
    env.cleanup().await;
    env2.cleanup().await;
}
