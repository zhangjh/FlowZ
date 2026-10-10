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
fn save_config(app: tauri::AppHandle, config: Value) -> Result<(), String> {
    let mut cfg: config::UserConfig =
        serde_json::from_value(config).map_err(|e| format!("配置格式错误: {}", e))?;
    config::validate_config(&mut cfg)?;
    config::save_config(&cfg)?;
    // UI 修改配置后刷新托盘菜单，保持选中态一致
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        tray::refresh_tray_menu(&app_clone).await;
    });
    Ok(())
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
/// 托盘待处理的前端动作（事件不可靠时的轮询兜底）
pub(crate) type PendingTrayAction = Arc<std::sync::Mutex<Option<String>>>;

/// 生成 sing-box 配置（调试用；start 内部也会生成）。
#[tauri::command]
async fn generate_singbox_config(
    app: tauri::AppHandle,
    config: Value,
) -> Result<Value, String> {
    let cfg: config::UserConfig =
        serde_json::from_value(config).map_err(|e| format!("配置格式错误: {}", e))?;
    let user_data_dir = config::user_data_dir()?;
    let data_dir = std::env::var("FLOWZ_DATA_DIR").map(std::path::PathBuf::from).ok().filter(|p| p.exists()).unwrap_or_else(|| {
        let candidates = [
            // staging 布局
            app.path().resource_dir().ok().map(|r| r.join("bundle-resources").join("data")),
            // Electron 式布局
            app.path().resource_dir().ok().map(|r| r.join("data")),
            // 开发期
            Some(std::path::PathBuf::from("resources/data")),
        ];
        candidates
            .into_iter()
            .flatten()
            .find(|p| p.exists())
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
    // 诊断日志：写入 LogManager，前端实时日志可见
    let diag = |msg: &str| {
        if let Some(logs) = app.try_state::<LogsState>() {
            let entry = logs
                .lock()
                .map(|mut m| m.add_log(logs::LogLevel::Info, msg, "proxy_start"))
                .ok()
                .flatten();
            if let Some(e) = entry {
                let _ = app.emit("event:logReceived", &e);
            }
        }
        eprintln!("[proxy_start] {}", msg);
    };
    diag("收到启动请求");

    let mut cfg: config::UserConfig = match config {
        Some(v) if !v.is_null() => {
            serde_json::from_value(v).map_err(|e| format!("配置格式错误: {}", e))?
        }
        _ => config::load_config()?,
    };
    diag("配置解析完成");
    config::validate_config(&mut cfg)?;
    diag(&format!("配置校验完成，模式: {}", cfg.proxy_mode_type));

    proxy.lock().await.start(&app, &cfg).await?;
    diag("sing-box 启动完成");

    // 系统代理模式：设置系统代理（失败不回滚 sing-box，与 Electron 一致）
    if cfg.proxy_mode_type.to_string().to_lowercase() == "systemproxy" {
        diag("设置系统代理...");
        if let Err(e) = sysproxy
            .lock()
            .await
            .enable_proxy("127.0.0.1", cfg.http_port, cfg.socks_port)
            .await
        {
            let msg = format!("设置系统代理失败: {}", e);
            diag(&msg);
            return Err(e);
        }
        diag("系统代理设置完成");
    }
    diag("proxy_start 全部完成");
    // 自动选择服务：配置 + 代理启动后开始健康检查（后台，不阻塞返回）
    // 托盘更新也放后台，让 api.proxy.start 尽早返回，前端按钮及时切换状态
    let app_bg = app.clone();
    let cfg_bg = cfg.clone();
    tauri::async_runtime::spawn(async move {
        let svc: Arc<autoselect::AutoSelectService> =
            app_bg.state::<AutoSelectState>().inner().clone();
        svc.configure(cfg_bg);
        svc.notify_proxy_started(
            Arc::new(TauriProxyControl { app: app_bg.clone() }),
            Arc::new(TauriEventEmitter { app: app_bg.clone() }),
        );
        update_tray_tooltip(&app_bg, true).await;
        tray::refresh_tray_menu(&app_bg).await;
    });
    Ok(())
}

/// 停止代理：先禁用系统代理（best-effort），再停 sing-box。
/// 获取托盘测速结果（供服务器页面同步）
#[tauri::command]
async fn get_tray_speedtest_results(
    map: tauri::State<'_, tray::SpeedResultMap>,
) -> Result<Vec<(String, Option<u64>)>, String> {
    Ok(map
        .lock()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), *v)).collect())
        .unwrap_or_default())
}

/// 获取并清空托盘待处理的前端动作
#[tauri::command]
async fn get_pending_tray_action(
    pending: tauri::State<'_, PendingTrayAction>,
) -> Result<Option<String>, String> {
    Ok(pending.lock().map(|mut p| p.take()).unwrap_or(None))
}

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
    tray::refresh_tray_menu(&app).await;
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
    let _ = app.emit("event:configChanged", serde_json::json!({ "newValue": cfg }));
    let proxy = app.state::<ProxyState>();
    let mut mgr = proxy.lock().await;
    // 代理未运行时只保存配置，不自动启动
    if !mgr.is_running() {
        return Ok(());
    }
    if mgr.hot_reload_config(app, &cfg).await {
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
    let _ = app.emit("event:configChanged", serde_json::json!({ "newValue": cfg }));
    let proxy = app.state::<ProxyState>();
    let mut mgr = proxy.lock().await;
    // 代理未运行时只保存配置，不自动启动
    if !mgr.is_running() {
        return Ok(());
    }
    if mgr.hot_reload_config(app, &cfg).await {
        return Ok(());
    }
    mgr.restart(app, &cfg).await
}

/// 托盘触发的全部服务器测速（后台执行，结果写入 SpeedResultMap 并推送事件）
pub(crate) fn run_tray_speedtest(app: &tauri::AppHandle) {
    let app = app.clone();
    let app_log = app.clone();
    // 日志辅助闭包
    let log = move |msg: String| {
        if let Some(logs) = app_log.try_state::<LogsState>() {
            let entry = logs
                .lock()
                .map(|mut m| m.add_log(logs::LogLevel::Info, &format!("[tray-speedtest] {}", msg), "tray"))
                .ok()
                .flatten();
            if let Some(e) = entry {
                let _ = app_log.emit("event:logReceived", &e);
            }
        }
    };
    tauri::async_runtime::spawn(async move {
        let cfg = match config::load_config() {
            Ok(c) => c,
            Err(e) => {
                log(format!("测速失败: 加载配置失败: {}", e));
                return;
            }
        };
        if cfg.servers.is_empty() {
            log("没有服务器可测速".to_string());
            return;
        }
        log(format!("开始测速，共 {} 个服务器", cfg.servers.len()));
        let singbox = match proxy::resolve_singbox_path(&app) {
            Ok(p) => p,
            Err(e) => {
                log(format!("测速失败: 找不到 sing-box: {}", e));
                return;
            }
        };
        let work_dir = match config::user_data_dir() {
            Ok(d) => d,
            Err(_) => std::env::temp_dir(),
        };
        let results = speedtest::test_multiple_servers(&cfg.servers, &singbox, &work_dir).await;
        log(format!("测速完成，共 {} 个结果", results.len()));
        // 写入托盘延迟缓存
        if let Some(map) = app.try_state::<tray::SpeedResultMap>() {
            if let Ok(mut m) = map.lock() {
                for r in &results {
                    m.insert(r.server_id.clone(), r.latency);
                }
            }
        }
        // 格式化为前端期望的格式（name, protocol, latency），通过 event:speedTestResult 通知
        // 对应原版 Electron 的 webContents.send('speedTestResult', ...)
        let formatted: Vec<serde_json::Value> = results
            .iter()
            .map(|r| {
                let server = cfg.servers.iter().find(|s| s.id == r.server_id);
                let name = server.map(|s| s.name.clone()).unwrap_or_else(|| r.server_id.clone());
                let protocol = server
                    .map(|s| format!("{:?}", s.protocol).to_uppercase())
                    .unwrap_or_default();
                serde_json::json!({
                    "name": name,
                    "protocol": protocol,
                    "latency": r.latency,
                })
            })
            .collect();
        let _ = app.emit("event:speedTestResult", &formatted);
        // 桌面通知：即使用户最小化了窗口也能看到结果
        {
            use tauri_plugin_notification::NotificationExt;
            let ok_count = results.iter().filter(|r| r.latency.is_some()).count();
            let body = if ok_count == results.len() {
                format!("{} 个服务器全部测速完成", results.len())
            } else {
                format!("{} 个服务器测速完成，{} 个可用", results.len(), ok_count)
            };
            let _ = app
                .notification()
                .builder()
                .title("FlowZ 服务器测速完成")
                .body(&body)
                .show();
        }
        tray::refresh_tray_menu(&app).await;
    });
}

// ---------------------------------------------------------------------------
// 自动更新：GitHub Release 检查（无签名，与 Electron 版机制一致）
// ---------------------------------------------------------------------------
// 检查 https://api.github.com/repos/zhangjh/FlowZ/releases/latest，
// 对比当前版本，有新版则返回下载链接，前端弹窗提示用户去下载。
// 不需要签名，用户手动下载安装包安装。

const GITHUB_REPO: &str = "zhangjh/FlowZ";

#[derive(serde::Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    published_at: Option<String>,
    prerelease: bool,
    assets: Vec<GitHubAsset>,
}

#[derive(serde::Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn is_newer(latest: &str, current: &str) -> bool {
    // 简单语义版本比较：去掉 v 前缀，按点分段比较数字
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches(['v', 'V'])
            .split('.')
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    parse(latest) > parse(current)
}

#[tauri::command]
async fn update_check(_app: tauri::AppHandle, include_prerelease: bool) -> Result<Value, String> {
    update_check_inner(include_prerelease).await
}

pub(crate) async fn update_check_inner(include_prerelease: bool) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("FlowZ-updater")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("检查更新失败: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // 404 = 还没有发布过 release；403 = API 限流；其他按原文返回
        if status.as_u16() == 404 {
            return Ok(serde_json::json!({ "hasUpdate": false }));
        }
        return Err(format!("GitHub API 返回 {}: {}", status.as_u16(), body.chars().take(200).collect::<String>()));
    }

    let release: GitHubRelease = resp
        .json()
        .await
        .map_err(|e| format!("解析 release 信息失败: {}", e))?;

    if release.prerelease && !include_prerelease {
        return Ok(serde_json::json!({ "hasUpdate": false }));
    }

    let current = current_version();
    if !is_newer(&release.tag_name, &current) {
        return Ok(serde_json::json!({ "hasUpdate": false }));
    }

    // 按当前平台选安装包
    let asset = pick_asset(&release.assets);
    let (download_url, file_name, file_size) = match asset {
        Some(a) => (a.browser_download_url.clone(), a.name.clone(), a.size),
        None => (release.html_url.clone(), String::new(), 0),
    };

    Ok(serde_json::json!({
        "hasUpdate": true,
        "updateInfo": {
            "version": release.tag_name.trim_start_matches(['v', 'V']),
            "title": release.name.unwrap_or_else(|| format!("FlowZ {}", release.tag_name)),
            "releaseNotes": release.body.unwrap_or_default(),
            "downloadUrl": download_url,
            "fileSize": file_size,
            "publishedAt": release.published_at.unwrap_or_default(),
            "isPrerelease": release.prerelease,
            "fileName": file_name,
            "releasePage": release.html_url,
        },
    }))
}

/// 按当前平台挑选安装包
fn pick_asset(assets: &[GitHubAsset]) -> Option<&GitHubAsset> {
    #[cfg(target_os = "windows")]
    let keywords = [".exe"];
    #[cfg(target_os = "macos")]
    #[cfg(target_arch = "aarch64")]
    let keywords = [".dmg"];
    #[cfg(target_os = "macos")]
    #[cfg(not(target_arch = "aarch64"))]
    let keywords = [".dmg"];
    #[cfg(target_os = "linux")]
    let keywords = [".AppImage", ".deb"];

    assets.iter().find(|a| {
        let name = a.name.to_lowercase();
        keywords.iter().any(|k| name.ends_with(k))
    })
}

#[tauri::command]
async fn update_download_install(_app: tauri::AppHandle) -> Result<Value, String> {
    // 无签名机制下不做自动下载安装，前端拿到 downloadUrl 后打开浏览器让用户手动下载
    Err("当前版本不支持自动下载安装，请前往 GitHub Release 页面手动下载".to_string())
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
    let r = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", "https://github.com/zhangjh/FlowZ/releases"])
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
    builder
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .manage(shared_logs)
        .manage(PendingTrayAction::default())
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
        .on_window_event(|window, event| {
            // 关闭窗口时最小化到托盘，不退出应用（与 Electron 版一致）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
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
            get_pending_tray_action,
            get_tray_speedtest_results,
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
