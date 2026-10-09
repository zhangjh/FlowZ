//! FlowZ Tauri 2 backend.
//!
//! Electron -> Tauri 迁移（分支 `feat/tauri-migration`）。
//! 已移植：config（ConfigManager）、protocol（ProtocolParser）、
//! subscription（SubscriptionService）、proxy（ProxyManager 核心：
//! sing-box 配置生成 + systemProxy 模式进程管理）。
//! 待移植：TUN 提权（PrivilegedSupervisor）、系统代理设置、托盘、
//! 开机自启、Clash API 热切换、日志流。

mod config;
mod protocol;
mod proxy;
mod singbox;
mod subscription;

use chrono::Utc;
use serde_json::Value;
use tauri::Manager;
use tokio::sync::Mutex;

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

// ---------------------------------------------------------------------------
// 代理控制（对应 ProxyManager）
// ---------------------------------------------------------------------------

type ProxyState = Mutex<proxy::ProxyManager>;

/// 生成 sing-box 配置（调试用；start 内部也会生成）。
#[tauri::command]
async fn generate_singbox_config(
    app: tauri::AppHandle,
    config: Value,
) -> Result<Value, String> {
    let cfg: config::UserConfig =
        serde_json::from_value(config).map_err(|e| format!("配置格式错误: {}", e))?;
    let user_data_dir = config::user_data_dir()?;
    let data_dir = std::env::var("FLOWZ_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            app.path()
                .resource_dir()
                .ok()
                .map(|r| r.join("data"))
                .filter(|p| p.exists())
                .unwrap_or_else(|| std::path::PathBuf::from("resources/data"))
        });
    let sb = singbox::generate_singbox_config(
        &cfg,
        &singbox::GenContext {
            user_data_dir,
            data_dir,
        },
    )?;
    serde_json::to_value(&sb).map_err(|e| format!("序列化失败: {}", e))
}

/// 启动代理（对应 proxy:start；config 为空时从磁盘加载当前配置）。
#[tauri::command]
async fn proxy_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProxyState>,
    config: Option<Value>,
) -> Result<(), String> {
    let mut cfg: config::UserConfig = match config {
        Some(v) if !v.is_null() => {
            serde_json::from_value(v).map_err(|e| format!("配置格式错误: {}", e))?
        }
        _ => config::load_config()?,
    };
    config::validate_config(&mut cfg)?;
    state.lock().await.start(&app, &cfg).await
}

/// 停止代理（对应 proxy:stop）。
#[tauri::command]
async fn proxy_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProxyState>,
) -> Result<(), String> {
    state.lock().await.stop(&app).await
}

/// 重启代理（对应 proxy:restart）。
#[tauri::command]
async fn proxy_restart(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProxyState>,
    config: Option<Value>,
) -> Result<(), String> {
    let mut cfg: config::UserConfig = match config {
        Some(v) if !v.is_null() => {
            serde_json::from_value(v).map_err(|e| format!("配置格式错误: {}", e))?
        }
        _ => config::load_config()?,
    };
    config::validate_config(&mut cfg)?;
    state.lock().await.restart(&app, &cfg).await
}

/// 代理状态（对应 proxy:getStatus；phase-1 的 TODO 桩已替换为真实实现）。
#[tauri::command]
async fn proxy_get_status(state: tauri::State<'_, ProxyState>) -> Result<Value, String> {
    let st = state.lock().await.status();
    serde_json::to_value(&st).map_err(|e| format!("序列化失败: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(proxy::ProxyManager::new()))
        .setup(|app| {
            // 健康检查后台任务：每 30s 探测 sing-box 存活，意外退出时自动重启
            //（冷却：60s 内最多 3 次；与 Electron 版一致）
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval =
                    tokio::time::interval(std::time::Duration::from_secs(30));
                loop {
                    interval.tick().await;
                    let state = app_handle.state::<ProxyState>();
                    let mut mgr = state.lock().await;
                    mgr.tick(&app_handle).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_version,
            get_config,
            save_config,
            parse_protocol_url,
            generate_share_url,
            parse_subscription,
            generate_singbox_config,
            proxy_start,
            proxy_stop,
            proxy_restart,
            proxy_get_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
