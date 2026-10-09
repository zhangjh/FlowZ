//! FlowZ Tauri 2 backend.
//!
//! Electron -> Tauri 迁移（分支 `feat/tauri-migration`）。
//! 已移植：config（ConfigManager）、protocol（ProtocolParser）、
//! subscription（SubscriptionService）、proxy（ProxyManager 核心 +
//! TUN 特权守护进程）、sysproxy（SystemProxyManager）、托盘、开机自启。
//! 待移植：macOS TUN DNS、Clash API 热切换、日志流、自动测速/故障转移。

mod autoselect;
mod clash;
mod config;
mod dns;
mod logs;
mod protocol;
mod proxy;
mod singbox;
mod speedtest;
mod subscription;
mod supervisor;
mod sysproxy;
mod tray;

use chrono::Utc;
use serde_json::Value;
use std::sync::Arc;
use tauri::{Emitter, Manager};
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

pub(crate) type ProxyState = Mutex<proxy::ProxyManager>;
pub(crate) type SysProxyState = Mutex<sysproxy::SystemProxyManager>;
pub(crate) type LogsState = logs::SharedLogManager;
pub(crate) type AutoSelectState = Arc<autoselect::AutoSelectService>;

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
    // 自动选择服务：配置 + 代理启动后开始健康检查
    {
        let svc: Arc<autoselect::AutoSelectService> = app.state::<AutoSelectState>().inner().clone();
        svc.configure(cfg.clone());
        svc.notify_proxy_started(
            Arc::new(TauriProxyControl { app: app.clone() }),
            Arc::new(TauriEventEmitter { app: app.clone() }),
        );
    }
    update_tray_tooltip(&app, true).await;
    tray::refresh_tray_menu(&app);
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
    // 停止自动选择健康检查
    {
        let svc: Arc<autoselect::AutoSelectService> = app.state::<AutoSelectState>().inner().clone();
        svc.stop();
    }
    update_tray_tooltip(&app, false).await;
    tray::refresh_tray_menu(&app);
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
// 日志（对应 logsApi）
// ---------------------------------------------------------------------------

#[tauri::command]
async fn logs_get(logs: tauri::State<'_, LogsState>, limit: Option<usize>) -> Result<Value, String> {
    let entries = logs.lock().map(|m| m.get_logs(limit)).map_err(|e| e.to_string())?;
    serde_json::to_value(&entries).map_err(|e| format!("序列化失败: {}", e))
}

#[tauri::command]
async fn logs_clear(logs: tauri::State<'_, LogsState>) -> Result<(), String> {
    logs.lock().map(|mut m| m.clear()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn logs_set_level(logs: tauri::State<'_, LogsState>, level: String) -> Result<(), String> {
    let lv = logs::LogLevel::parse(&level).ok_or_else(|| format!("未知日志级别: {}", level))?;
    logs.lock().map(|mut m| m.set_level(lv)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn logs_open_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = config::user_data_dir()?;
    #[cfg(target_os = "linux")]
    let mut cmd = { let mut c = std::process::Command::new("xdg-open"); c.arg(&dir); c };
    #[cfg(target_os = "macos")]
    let mut cmd = { let mut c = std::process::Command::new("open"); c.arg(&dir); c };
    #[cfg(target_os = "windows")]
    let mut cmd = { let mut c = std::process::Command::new("explorer"); c.arg(&dir); c };
    cmd.spawn().map_err(|e| format!("打开日志目录失败: {}", e))?;
    let _ = app;
    Ok(())
}

// ---------------------------------------------------------------------------
// 服务器切换（热更新优先，失败回退重启）
// ---------------------------------------------------------------------------

#[tauri::command]
async fn proxy_switch_server(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    server_id: String,
) -> Result<(), String> {
    proxy.lock().await.switch_server(&app, &server_id).await
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
// 托盘 / 内部复用入口
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

/// 供托盘事件复用的启动入口
pub(crate) async fn proxy_start_inner(
    app: &tauri::AppHandle,
    config: Option<Value>,
) -> Result<(), String> {
    let proxy = app.state::<ProxyState>();
    let sysproxy = app.state::<SysProxyState>();
    proxy_start(app.clone(), proxy, sysproxy, config).await
}

/// 供托盘事件复用的停止入口
pub(crate) async fn proxy_stop_inner(app: &tauri::AppHandle) -> Result<(), String> {
    let proxy = app.state::<ProxyState>();
    let sysproxy = app.state::<SysProxyState>();
    proxy_stop(app.clone(), proxy, sysproxy).await
}

/// 切换分组（托盘菜单）
pub(crate) async fn switch_group(app: &tauri::AppHandle, group_id: &str) -> Result<(), String> {
    let mut cfg = config::load_config()?;
    cfg.selected_group_id = Some(group_id.to_string());
    cfg.selected_server_id = None;
    config::validate_config(&mut cfg)?;
    config::save_config(&cfg)?;
    let proxy = app.state::<ProxyState>();
    let mut mgr = proxy.lock().await;
    if mgr.is_running() && mgr.hot_reload_config(app, &cfg).await {
        return Ok(());
    }
    mgr.restart(app, &cfg).await
}

/// 切换代理模式（托盘菜单）
pub(crate) async fn switch_proxy_mode(app: &tauri::AppHandle, mode: &str) -> Result<(), String> {
    let mut cfg = config::load_config()?;
    cfg.proxy_mode = mode.parse().map_err(|e: String| e)?;
    config::validate_config(&mut cfg)?;
    config::save_config(&cfg)?;
    let proxy = app.state::<ProxyState>();
    let mut mgr = proxy.lock().await;
    if mgr.is_running() && mgr.hot_reload_config(app, &cfg).await {
        return Ok(());
    }
    mgr.restart(app, &cfg).await
}

/// 托盘触发的全部服务器测速（后台执行，结果写入 SpeedResultMap 并推送事件）
pub(crate) fn run_tray_speedtest(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let cfg = match config::load_config() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[tray] 测速失败: {}", e);
                return;
            }
        };
        if cfg.servers.is_empty() {
            return;
        }
        let singbox = match proxy::resolve_singbox_path(&app) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[tray] 测速失败: {}", e);
                return;
            }
        };
        let work_dir = match config::user_data_dir() {
            Ok(d) => d,
            Err(_) => std::env::temp_dir(),
        };
        let results = speedtest::test_multiple_servers(&cfg.servers, &singbox, &work_dir).await;
        // 写入托盘延迟缓存
        if let Some(map) = app.try_state::<tray::SpeedResultMap>() {
            if let Ok(mut m) = map.lock() {
                for r in &results {
                    m.insert(r.server_id.clone(), r.latency);
                }
            }
        }
        let _ = app.emit(
            "event:speedTestCompleted",
            serde_json::to_value(&results).unwrap_or_default(),
        );
        tray::refresh_tray_menu(&app);
    });
}

// ---------------------------------------------------------------------------
// 自动更新（tauri-plugin-updater）
// ---------------------------------------------------------------------------

/// 是否配置了更新签名公钥。用户需运行 `tauri signer generate` 生成密钥对，
/// 把公钥填入 tauri.conf.json 的 plugins.updater.pubkey，并把私钥配到 CI。
/// 未配置时更新检查返回明确错误，不崩溃。
const UPDATER_CONFIGURED: bool = false;

#[tauri::command]
async fn update_check(app: tauri::AppHandle, include_prerelease: bool) -> Result<Value, String> {
    let result = update_check_inner(&app, include_prerelease).await?;
    serde_json::to_value(&result).map_err(|e| format!("序列化失败: {}", e))
}

pub(crate) async fn update_check_inner(
    app: &tauri::AppHandle,
    _include_prerelease: bool,
) -> Result<serde_json::Value, String> {
    if !UPDATER_CONFIGURED {
        return Err("自动更新未配置：需要先运行 `tauri signer generate` 生成签名密钥并填入 tauri.conf.json".to_string());
    }
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(serde_json::json!({
            "hasUpdate": true,
            "updateInfo": {
                "version": update.version,
                "title": format!("FlowZ {}", update.version),
                "releaseNotes": update.body.unwrap_or_default(),
                "downloadUrl": "",
                "fileSize": 0,
                "publishedAt": update.date.map(|d| d.to_string()).unwrap_or_default(),
                "isPrerelease": false,
                "fileName": "",
            },
        })),
        None => Ok(serde_json::json!({ "hasUpdate": false })),
    }
}

#[tauri::command]
async fn update_download_install(app: tauri::AppHandle) -> Result<Value, String> {
    if !UPDATER_CONFIGURED {
        return Err("自动更新未配置：需要先运行 `tauri signer generate` 生成签名密钥并填入 tauri.conf.json".to_string());
    }
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("没有可用更新")?;
    let total = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let downloaded = Arc::new(std::sync::atomic::AtomicU64::new(0));
    update
        .download_and_install(
            {
                let app = app.clone();
                let total = total.clone();
                let downloaded = downloaded.clone();
                move |chunk_len, content_len| {
                    if let Some(len) = content_len {
                        total.store(len, std::sync::atomic::Ordering::Relaxed);
                    }
                    downloaded.fetch_add(chunk_len as u64, std::sync::atomic::Ordering::Relaxed);
                    let t = total.load(std::sync::atomic::Ordering::Relaxed);
                    let d = downloaded.load(std::sync::atomic::Ordering::Relaxed);
                    let pct = if t > 0 { (d as f64 / t as f64 * 100.0) as u32 } else { 0 };
                    let _ = app.emit(
                        "event:updateProgress",
                        serde_json::json!({
                            "status": "downloading",
                            "percentage": pct,
                            "message": format!("下载中 {}%", pct),
                        }),
                    );
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "event:updateProgress",
        serde_json::json!({ "status": "downloaded", "percentage": 100, "message": "下载完成，正在安装…" }),
    );
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn update_open_releases() -> Result<Value, String> {
    // 用系统浏览器打开 Releases 页（对应 shell.openExternal）
    #[cfg(target_os = "linux")]
    let r = std::process::Command::new("xdg-open")
        .arg("https://github.com/zhangjh/FlowZ/releases")
        .spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open")
        .arg("https://github.com/zhangjh/FlowZ/releases")
        .spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("cmd")
        .args(["/c", "start", "https://github.com/zhangjh/FlowZ/releases"])
        .spawn();
    r.map_err(|e| format!("打开浏览器失败: {}", e))?;
    Ok(serde_json::json!({ "success": true }))
}

// ---------------------------------------------------------------------------
// 自动选择（对应 autoSelectApi）
// ---------------------------------------------------------------------------

/// ProxyControl 的 Tauri 实现（供 AutoSelectService 回调）
struct TauriProxyControl {
    app: tauri::AppHandle,
}

impl autoselect::ProxyControl for TauriProxyControl {
    fn hot_reload<'a>(
        &'a self,
        config: &'a config::UserConfig,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>> {
        let app = self.app.clone();
        Box::pin(async move {
            let proxy = app.state::<ProxyState>();
            let mut guard = proxy.lock().await;
            guard.hot_reload_config(&app, config).await
        })
    }

    fn restart<'a>(
        &'a self,
        config: &'a config::UserConfig,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>
    {
        let app = self.app.clone();
        Box::pin(async move {
            let proxy = app.state::<ProxyState>();
            let mut guard = proxy.lock().await;
            guard.restart(&app, config).await
        })
    }

    fn is_running(&self) -> bool {
        self.app
            .try_state::<ProxyState>()
            .map(|s| s.blocking_lock().is_running())
            .unwrap_or(false)
    }
}

struct TauriEventEmitter {
    app: tauri::AppHandle,
}

impl autoselect::EventEmitter for TauriEventEmitter {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }
}

#[tauri::command]
async fn autoselect_test_all(
    app: tauri::AppHandle,
    autoselect: tauri::State<'_, AutoSelectState>,
) -> Result<Value, String> {
    let cfg = config::load_config()?;
    let svc: Arc<autoselect::AutoSelectService> = autoselect.inner().clone();
    let results = svc.test_all_servers(cfg.servers.clone()).await;
    // 测速结果同步到托盘延迟缓存
    if let Some(map) = app.try_state::<tray::SpeedResultMap>() {
        if let Ok(mut m) = map.lock() {
            for r in &results {
                m.insert(r.server_id.clone(), r.latency);
            }
        }
    }
    let _ = app.emit(
        "event:autoSelectTestCompleted",
        serde_json::to_value(&results).unwrap_or_default(),
    );
    serde_json::to_value(&results).map_err(|e| format!("序列化失败: {}", e))
}

#[tauri::command]
async fn autoselect_get_status(
    autoselect: tauri::State<'_, AutoSelectState>,
) -> Result<Value, String> {
    let st = autoselect.inner().get_status();
    serde_json::to_value(&st).map_err(|e| format!("序列化失败: {}", e))
}

#[tauri::command]
async fn autoselect_trigger_failover(
    app: tauri::AppHandle,
    autoselect: tauri::State<'_, AutoSelectState>,
) -> Result<(), String> {
    let svc: Arc<autoselect::AutoSelectService> = autoselect.inner().clone();
    let proxy = Arc::new(TauriProxyControl { app: app.clone() });
    let emitter = Arc::new(TauriEventEmitter { app: app.clone() });
    svc.trigger_immediate_failover(proxy, emitter).await;
    Ok(())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared_logs = logs::new_shared();
    let proxy_manager = proxy::ProxyManager::new(shared_logs.clone());
    // 自动选择服务（后台健康检查 + 故障转移）
    let singbox_path = proxy::resolve_singbox_path_early();
    let work_dir = config::user_data_dir().unwrap_or_else(|_| std::env::temp_dir());
    let autoselect = Arc::new(autoselect::AutoSelectService::new(
        shared_logs.clone(),
        singbox_path,
        work_dir,
    ));

    let builder = tauri::Builder::default();
    // 自动更新插件：仅在配置了签名公钥时注册
    let builder = if UPDATER_CONFIGURED {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    builder
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(shared_logs)
        .manage(Mutex::new(proxy_manager))
        .manage(Mutex::new(sysproxy::SystemProxyManager::new()))
        .manage(autoselect)
        .manage(tray::SpeedResultMap::default())
        .setup(|app| {
            // 托盘（动态菜单）
            if let Err(e) = tray::setup_tray(app.handle()) {
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
            proxy_switch_server,
            logs_get,
            logs_clear,
            logs_set_level,
            logs_open_folder,
            system_proxy_enable,
            system_proxy_disable,
            system_proxy_get_status,
            autostart_set,
            autostart_is_enabled,
            admin_check,
            autoselect_test_all,
            autoselect_get_status,
            autoselect_trigger_failover,
            update_check,
            update_download_install,
            update_open_releases,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
