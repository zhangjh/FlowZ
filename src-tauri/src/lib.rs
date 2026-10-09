//! FlowZ Tauri 2 backend — phase 1 scaffold.
//!
//! This is the starting point of the Electron -> Tauri migration
//! (branch `feat/tauri-migration`). Only a minimal command surface is
//! registered here; every stub returns an honest TODO error naming the
//! Electron service that still needs porting. Nothing is faked.

use serde_json::Value;

/// App version from Cargo.toml. Real, works today.
#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// TODO(phase-2): port `src/main/services/ConfigManager.ts` (12.5 KB).
/// Currently returns an error by design — do not treat as implemented.
#[tauri::command]
fn get_config() -> Result<Value, String> {
    Err(
        "TODO(phase-2): ConfigManager (src/main/services/ConfigManager.ts) not ported yet"
            .to_string(),
    )
}

/// TODO(phase-3): port `src/main/services/ProxyManager.ts` (142 KB).
/// Currently returns an error by design — do not treat as implemented.
#[tauri::command]
fn proxy_get_status() -> Result<Value, String> {
    Err(
        "TODO(phase-3): ProxyManager (src/main/services/ProxyManager.ts) not ported yet"
            .to_string(),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_version,
            get_config,
            proxy_get_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
