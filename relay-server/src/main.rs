//! Notology Sync Relay — lightweight WebSocket notification server.
//!
//! Runs on NAS (Docker) or any machine. No data flows through this server —
//! only sync notifications ("file X changed by device Y").
//!
//! Protocol:
//!   Client connects: ws://relay:9399/ws?vault=VAULT_ID&device=DEVICE_ID&secret=SHARED_SECRET
//!   Client sends:    {"type":"changed","files":["note.md","img/photo.png"]}
//!   Relay broadcasts: {"type":"changed","files":[...],"device":"sender_id"} to all OTHER clients in same vault
//!
//! No persistence, no auth beyond shared secret, no TLS (runs behind NAS reverse proxy if needed).

use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, RwLock};
use tokio_tungstenite::tungstenite::Message;

/// Per-vault broadcast channel. Capacity 64 is plenty for sync notifications.
type VaultTx = broadcast::Sender<(String, String)>; // (device_id, json_payload)

struct RelayState {
    vaults: RwLock<HashMap<String, VaultTx>>,
    secret: String,
}

impl RelayState {
    fn new(secret: String) -> Self {
        Self {
            vaults: RwLock::new(HashMap::new()),
            secret,
        }
    }

    async fn get_or_create_vault(&self, vault_id: &str) -> VaultTx {
        // Fast path: read lock
        {
            let vaults = self.vaults.read().await;
            if let Some(tx) = vaults.get(vault_id) {
                return tx.clone();
            }
        }
        // Slow path: write lock
        let mut vaults = self.vaults.write().await;
        vaults
            .entry(vault_id.to_string())
            .or_insert_with(|| broadcast::channel(64).0)
            .clone()
    }
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let port: u16 = std::env::var("RELAY_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(9399);

    let secret = std::env::var("RELAY_SECRET").unwrap_or_else(|_| {
        log::warn!("RELAY_SECRET not set — using empty secret (insecure)");
        String::new()
    });

    let state = Arc::new(RelayState::new(secret));
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(&addr).await.expect("Failed to bind");

    log::info!("Notology Relay listening on ws://0.0.0.0:{}", port);

    while let Ok((stream, peer)) = listener.accept().await {
        let state = Arc::clone(&state);
        tokio::spawn(handle_connection(state, stream, peer));
    }
}

async fn handle_connection(state: Arc<RelayState>, stream: TcpStream, peer: SocketAddr) {
    // Parse query params from WebSocket upgrade request
    let mut vault_id = String::new();
    let mut device_id = String::new();
    let mut client_secret = String::new();

    let callback = |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                    resp: tokio_tungstenite::tungstenite::handshake::server::Response| {
        if let Some(query) = req.uri().query() {
            for pair in query.split('&') {
                let mut parts = pair.splitn(2, '=');
                match (parts.next(), parts.next()) {
                    (Some("vault"), Some(v)) => vault_id = v.to_string(),
                    (Some("device"), Some(d)) => device_id = d.to_string(),
                    (Some("secret"), Some(s)) => client_secret = s.to_string(),
                    _ => {}
                }
            }
        }
        Ok(resp)
    };

    let ws_stream = match tokio_tungstenite::accept_hdr_async(stream, callback).await {
        Ok(ws) => ws,
        Err(e) => {
            log::debug!("WebSocket handshake failed from {}: {}", peer, e);
            return;
        }
    };

    // Authenticate
    if !state.secret.is_empty() && client_secret != state.secret {
        log::warn!("Rejected connection from {} (bad secret)", peer);
        return;
    }

    if vault_id.is_empty() || device_id.is_empty() {
        log::warn!("Rejected connection from {} (missing vault/device)", peer);
        return;
    }

    log::info!("[{}] Device '{}' joined vault '{}'", peer, device_id, vault_id);

    let tx = state.get_or_create_vault(&vault_id).await;
    let mut rx = tx.subscribe();
    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    // Bi-directional relay
    loop {
        tokio::select! {
            // Client → relay → broadcast to others
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        // Inject device_id into the message before broadcasting
                        if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&text) {
                            json["device"] = serde_json::Value::String(device_id.clone());
                            let enriched = json.to_string();
                            let _ = tx.send((device_id.clone(), enriched));
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = ws_tx.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        log::info!("[{}] Device '{}' left vault '{}'", peer, device_id, vault_id);
                        break;
                    }
                    _ => {}
                }
            }
            // Broadcast from others → this client
            result = rx.recv() => {
                match result {
                    Ok((sender, payload)) => {
                        // Don't echo back to sender
                        if sender != device_id {
                            if ws_tx.send(Message::Text(payload.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("[{}] Device '{}' lagged {} messages", peer, device_id, n);
                    }
                    Err(_) => break,
                }
            }
        }
    }
}
