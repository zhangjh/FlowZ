//! FlowZ Tauri 2 backend.
//!
//! Electron -> Tauri 迁移（分支 `feat/tauri-migration`）。
//! 已移植：config（ConfigManager）、protocol（ProtocolParser）、
//! subscription（SubscriptionService）、proxy（ProxyManager 核心 +
//! TUN 特权守护进程）、sysproxy（SystemProxyManager）、托盘、开机自启。
//! 待移植：macOS TUN DNS、Clash API 热切换、日志流、自动测速/故障转移。

mod config;
mod protocol;
mod proxy;
mod singbox;
mod subscription;
mod supervisor;
mod sysproxy;

use chrono::Utc;
use serde_json::Value;
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;
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

/// 解析订阅（对应 SERVER_PARSE_SUBSCRIPTION）。
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
// 代理控制（对应 ProxyManager + proxy-handlers 的编排）
// ---------------------------------------------------------------------------

type ProxyState = Mutex<proxy::ProxyManager>;
type SysProxyState = Mutex<sysproxy::SystemProxyManager>;

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

/// 启动代理：sing-box →（系统代理模式）设置系统代理（对应 executeProxyStart）。
#[tauri::command]
async fn proxy_start(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    sysproxy: tauri::State<'_, SysProxyState>,
    config: Option<Value>,
) -> Result<(), String> {
    let mut cfg: config::UserConfig = match config {
        Some(v) if !v.is_null() => {
            serde_json::from_value(v).map_err(|e| format!("配置格式错误: {}", e))?
        }
        _ => config::load_config()?,
    };
    config::validate_config(&mut cfg)?;

    proxy.lock().await.start(&app, &cfg).await?;

    // 系统代理模式：设置系统代理（失败不回滚 sing-box，与 Electron 一致）
    if cfg.proxy_mode_type.to_string().to_lowercase() == "systemproxy" {
        if let Err(e) = sysproxy
            .lock()
            .await
            .enable_proxy("127.0.0.1", cfg.http_port, cfg.socks_port)
            .await
        {
            eprintln!("[proxy] 设置系统代理失败: {}", e);
            return Err(e);
        }
    }
    update_tray_tooltip(&app, true).await;
    Ok(())
}

/// 停止代理：先禁用系统代理（best-effort），再停 sing-box。
#[tauri::command]
async fn proxy_stop(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    sysproxy: tauri::State<'_, SysProxyState>,
) -> Result<(), String> {
    if let Err(e) = sysproxy.lock().await.disable_proxy().await {
        eprintln!("[proxy] 禁用系统代理失败: {}", e);
    }
    proxy.lock().await.stop(&app).await?;
    update_tray_tooltip(&app, false).await;
    Ok(())
}

/// 重启代理（对应 proxy:restart）。
#[tauri::command]
async fn proxy_restart(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    sysproxy: tauri::State<'_, SysProxyState>,
    config: Option<Value>,
) -> Result<(), String> {
    proxy_stop(app.clone(), proxy, sysproxy).await?;
    // proxy_stop 消耗了 state；重新获取
    let proxy = app.state::<ProxyState>();
    let sysproxy = app.state::<SysProxyState>();
    proxy_start(app.clone(), proxy, sysproxy, config).await
}

/// 代理状态（对应 proxy:getStatus）。
#[tauri::command]
async fn proxy_get_status(proxy: tauri::State<'_, ProxyState>) -> Result<Value, String> {
    let st = proxy.lock().await.status();
    serde_json::to_value(&st).map_err(|e| format!("序列化失败: {}", e))
}

// ---------------------------------------------------------------------------
// 系统代理（对应 systemProxyApi）
// ---------------------------------------------------------------------------

#[tauri::command]
async fn system_proxy_enable(
    sysproxy: tauri::State<'_, SysProxyState>,
    address: String,
    http_port: u32,
    socks_port: u32,
) -> Result<(), String> {
    sysproxy
        .lock()
        .await
        .enable_proxy(&address, http_port, socks_port)
        .await
}

#[tauri::command]
async fn system_proxy_disable(sysproxy: tauri::State<'_, SysProxyState>) -> Result<(), String> {
    sysproxy.lock().await.disable_proxy().await
}

#[tauri::command]
async fn system_proxy_get_status(
    sysproxy: tauri::State<'_, SysProxyState>,
) -> Result<Value, String> {
    let st = sysproxy.lock().await.get_proxy_status().await;
    serde_json::to_value(&st).map_err(|e| format!("序列化失败: {}", e))
}

// ---------------------------------------------------------------------------
// 开机自启 / 管理员检查
// ---------------------------------------------------------------------------

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable().map_err(|e| e.to_string())
    } else {
        launcher.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn autostart_is_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn admin_check() -> Value {
    #[cfg(unix)]
    let is_admin = unsafe { libc::geteuid() == 0 };
    #[cfg(not(unix))]
    let is_admin = false;
    serde_json::json!({
        "isAdmin": is_admin,
        "platform": std::env::consts::OS,
        "needsElevationForTun": !is_admin,
    })
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

async fn update_tray_tooltip(app: &tauri::AppHandle, connected: bool) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(if connected {
            "FlowZ - 已连接"
        } else {
            "FlowZ"
        }));
    }
}

fn build_tray(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::tray::{MouseButton, TrayIconBuilder};
    use tauri::menu::{MenuBuilder, MenuItemBuilder};

    // 图标：打包后走 resource dir，开发期走仓库 resources/
    let icon_path = app
        .path()
        .resource_dir()
        .ok()
        .map(|r| r.join("app.png"))
        .filter(|p| p.exists())
        .unwrap_or_else(|| std::path::PathBuf::from("resources/app.png"));
    let rgba = image::open(&icon_path)
        .map_err(|e| format!("加载托盘图标失败: {}", e))?
        .to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let icon = tauri::image::Image::new_owned(rgba.into_raw(), w, h);

    let show = MenuItemBuilder::with_id("show", "显示主窗口").build(app)
        .map_err(|e| e.to_string())?;
    let start = MenuItemBuilder::with_id("start", "启动代理").build(app)
        .map_err(|e| e.to_string())?;
    let stop = MenuItemBuilder::with_id("stop", "停止代理").build(app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .items(&[&show, &start, &stop, &quit])
        .build()
        .map_err(|e| e.to_string())?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("FlowZ")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let app = app.clone();
            let id = event.id().as_ref().to_string();
            tauri::async_runtime::spawn(async move {
                match id.as_str() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "start" => {
                        let proxy = app.state::<ProxyState>();
                        let sysproxy = app.state::<SysProxyState>();
                        if let Err(e) =
                            proxy_start(app.clone(), proxy, sysproxy, None).await
                        {
                            eprintln!("[tray] 启动代理失败: {}", e);
                        }
                    }
                    "stop" => {
                        let proxy = app.state::<ProxyState>();
                        let sysproxy = app.state::<SysProxyState>();
                        if let Err(e) = proxy_stop(app.clone(), proxy, sysproxy).await {
                            eprintln!("[tray] 停止代理失败: {}", e);
                        }
                    }
                    "quit" => {
                        // 退出前停代理 + 退守护进程
                        let proxy = app.state::<ProxyState>();
                        {
                            let mut mgr = proxy.lock().await;
                            let _ = mgr.shutdown(&app).await;
                        }
                        app.exit(0);
                    }
                    _ => {}
                }
            });
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                let app = tray.app_handle().clone();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(Mutex::new(proxy::ProxyManager::new()))
        .manage(Mutex::new(sysproxy::SystemProxyManager::new()))
        .setup(|app| {
            // 托盘
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("[tray] {}", e);
            }
            // 健康检查后台任务：每 30s 探测 sing-box 存活，意外退出时自动重启
            //（冷却：60s 内最多 3 次；与 Electron 版一致）
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
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
            proxy_get_status,
            system_proxy_enable,
            system_proxy_disable,
            system_proxy_get_status,
            autostart_set,
            autostart_is_enabled,
            admin_check,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
