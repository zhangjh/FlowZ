//! FlowZ Tauri 2 backend.
//!
//! Electron -> Tauri 迁移（分支 `feat/tauri-migration`）。
//! 已移植：config（ConfigManager）、protocol（ProtocolParser）、
//! subscription（SubscriptionService）。
//! 待移植：ProxyManager（proxy_get_status 仍为 TODO 桩）。

mod config;
mod protocol;
mod subscription;

use chrono::Utc;
use serde_json::Value;

/// 应用版本（Cargo.toml）。真实可用。
#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 加载用户配置（对应 ConfigManager.loadConfig）。
#[tauri::command]
fn get_config() -> Result<Value, String> {
    let cfg = config::load_config()?;
    serde_json::to_value(&cfg).map_err(|e| format!("序列化配置失败: {}", e))
}

/// 保存用户配置（对应 ConfigManager.saveConfig，含验证）。
#[tauri::command]
fn save_config(config: Value) -> Result<(), String> {
    let mut cfg: config::UserConfig =
        serde_json::from_value(config).map_err(|e| format!("配置格式错误: {}", e))?;
    config::validate_config(&mut cfg)?;
    config::save_config(&cfg)
}

/// 解析协议 URL（对应 server:parseUrl）。
#[tauri::command]
fn parse_protocol_url(url: String) -> Result<Value, String> {
    let cfg = protocol::parse_url(&url)?;
    serde_json::to_value(&cfg).map_err(|e| format!("序列化失败: {}", e))
}

/// 生成分享链接（对应 server:generateUrl）。
#[tauri::command]
fn generate_share_url(server: Value) -> Result<String, String> {
    let cfg: config::ServerConfig =
        serde_json::from_value(server).map_err(|e| format!("服务器配置格式错误: {}", e))?;
    protocol::generate_url(&cfg)
}

/// 解析订阅（对应 SERVER_PARSE_SUBSCRIPTION）：
/// 有 content 直接解码；只有 url 则先拉取；统一走 parse_many。
/// 返回解析出的服务器数组（打时间戳，不写入配置）。
#[tauri::command]
async fn parse_subscription(payload: Value) -> Result<Value, String> {
    let content = payload
        .get("content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let url = payload
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut text = content.unwrap_or_default();
    if text.trim().is_empty() {
        if let Some(u) = url {
            text = subscription::fetch_subscription_content(&u, 20_000)
                .await?
                .text;
        }
    }
    if text.trim().is_empty() {
        return Err("订阅内容为空，请输入协议链接或订阅 URL".to_string());
    }
    let decoded = subscription::decode_subscription_text(&text).text;
    let mut servers = protocol::parse_many(&decoded);
    if servers.is_empty() {
        return Err("未解析出任何有效的服务器链接".to_string());
    }
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for s in &mut servers {
        s.created_at = Some(now.clone());
        s.updated_at = Some(now.clone());
    }
    serde_json::to_value(&servers).map_err(|e| format!("序列化失败: {}", e))
}

/// TODO(phase-3): 移植 `src/main/services/ProxyManager.ts`（142 KB）。
/// 目前返回 honest 错误，不要当作已实现。
#[tauri::command]
fn proxy_get_status() -> Result<Value, String> {
    Err("TODO(phase-3): ProxyManager (src/main/services/ProxyManager.ts) not ported yet".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_version,
            get_config,
            save_config,
            parse_protocol_url,
            generate_share_url,
            parse_subscription,
            proxy_get_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
