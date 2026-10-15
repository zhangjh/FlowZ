//! FlowZ Tauri 2 backend.
//!
//! FlowZ Tauri 版本。
//! 已移植：config（ConfigManager）、protocol（ProtocolParser）、
//! subscription（SubscriptionService）、proxy（ProxyManager 核心 +
//! TUN 特权守护进程）、sysproxy（SystemProxyManager）、托盘、开机自启。
//! 待移植：macOS TUN DNS、Clash API 热切换、日志流、自动测速/故障转移。

mod autoselect;
mod clash;
mod config;
mod dns;
mod logs;
mod platform;
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
/// 配置变更后，若代理正在运行，尝试热切换；不能热切或热切失败则完整重启。
/// 对齐 Electron main/index.ts 中 MAIN_EVENTS.CONFIG_CHANGED 的处理路径：
/// saveConfig → 广播 configChanged → 托盘刷新 → 热更新 / 重启。
#[tauri::command]
async fn save_config(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    autoselect: tauri::State<'_, AutoSelectState>,
    config: Value,
) -> Result<(), String> {
    let mut cfg: config::UserConfig =
        serde_json::from_value(config).map_err(|e| format!("配置格式错误: {}", e))?;
    config::validate_config(&mut cfg)?;
    config::save_config(&cfg)?;

    // 广播配置变更事件到渲染进程（对齐 Electron config-handlers 的 sendToAll）
    let _ = app.emit("event:configChanged", serde_json::json!({ "newValue": &cfg }));

    // 更新自动选择服务配置（对齐 Electron 的 autoSelectService.updateConfig）。
    // 关闭自动选择时立即停止健康检查；开启时配置已更新，下次代理启动时由
    // notify_proxy_started 启动健康检查（热切换路径下不重启代理）。
    autoselect.inner().configure(cfg.clone());

    // 代理正在运行时，尝试热切换；不能热切或热切失败则完整重启。
    // 锁必须在 tray::refresh_tray_menu 之前释放，避免与托盘内部取 ProxyState 锁死锁。
    let restarted = {
        let mut mgr = proxy.lock().await;
        if !mgr.is_running() {
            false
        } else if mgr.can_hot_reload(&cfg) && mgr.hot_reload_config(&app, &cfg).await {
            false
        } else {
            mgr.restart(&app, &cfg).await?;
            true
        }
    };

    // 刷新托盘菜单（内部会获取 ProxyState 锁，故在锁外调用）
    tray::refresh_tray_menu(&app).await;
    if restarted {
        update_tray_tooltip(&app, true).await;
    }
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
/// 启动时/托盘检查更新得到的待提示结果（事件在监听器注册前发出时会丢，需轮询兜底）
pub(crate) type PendingUpdateResult = Arc<std::sync::Mutex<Option<Value>>>;

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
            // resources/<platform>/ 布局
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

    // 系统代理模式：设置系统代理（失败不回滚 sing-box）
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
/// 获取托盘测速版本号
#[tauri::command]
async fn get_tray_speedtest_version(
    v: tauri::State<'_, tray::SpeedtestVersion>,
) -> Result<u64, String> {
    Ok(v.load(std::sync::atomic::Ordering::SeqCst))
}

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

/// 获取并清空待处理的更新检查结果（启动/托盘检查更新的前端兜底）
#[tauri::command]
async fn get_pending_update_result(
    pending: tauri::State<'_, PendingUpdateResult>,
) -> Result<Option<Value>, String> {
    Ok(pending.lock().map(|mut p| p.take()).unwrap_or(None))
}

#[tauri::command]
async fn proxy_stop(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ProxyState>,
    sysproxy: tauri::State<'_, SysProxyState>,
) -> Result<(), String> {
    // 先停自动选择健康检查：即使下方 stop 失败早退，也不能遗留后台任务触发故障转移重启
    {
        let svc: Arc<autoselect::AutoSelectService> = app.state::<AutoSelectState>().inner().clone();
        svc.stop();
    }
    if let Err(e) = sysproxy.lock().await.disable_proxy().await {
        eprintln!("[proxy] 禁用系统代理失败: {}", e);
    }
    proxy.lock().await.stop(&app).await?;
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

/// 停止代理与守护进程、恢复系统代理（不退出应用）。
/// 供优雅退出与安装更新前清理复用。
/// 同时供信号处理（spawn_signal_handler）复用，对齐 Electron 版 `cleanupResources`。
pub(crate) async fn shutdown_resources(app: &tauri::AppHandle) {
    let proxy = app.state::<ProxyState>();
    {
        let mut mgr = proxy.lock().await;
        let _ = mgr.shutdown(app).await;
    }
    // 恢复系统代理设置，避免系统残留代理导致断网
    let sysproxy = app.state::<SysProxyState>();
    {
        let mut sp = sysproxy.lock().await;
        let _ = sp.disable_proxy().await;
    }
}

/// 优雅退出：停代理与守护进程、恢复系统代理后退出应用。
/// 托盘"退出"与 minimize_to_tray=false 时的关窗退出共用。
pub(crate) async fn graceful_exit(app: &tauri::AppHandle) {
    shutdown_resources(app).await;
    app.exit(0);
}

/// 屏蔽 SIGTERM/SIGINT：必须在创建任何后台线程之前调用，
/// 使其后所有线程继承该屏蔽，信号统一交由 `spawn_signal_handler` 的线程接管。
#[cfg(unix)]
fn install_signal_mask() {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
    }
}

/// 对齐原 Electron 版 `process.on('SIGINT'/'SIGTERM')`。
/// Linux 注销/重启时系统发送 SIGTERM，tao 不会将其转成 `RunEvent::Exit`，
/// 故在专用线程 `sigwait`：收到信号后执行与退出相同的清理（停 sing-box、恢复系统代理）再退出；
/// 若清理期间再次收到信号则强制退出，避免卡死无法终止。
#[cfg(unix)]
fn spawn_signal_handler(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        use std::sync::atomic::{AtomicBool, Ordering};
        static CLEANING: AtomicBool = AtomicBool::new(false);
        unsafe {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::sigaddset(&mut set, libc::SIGTERM);
            libc::sigaddset(&mut set, libc::SIGINT);
            loop {
                let mut sig: libc::c_int = 0;
                if libc::sigwait(&set, &mut sig) != 0 {
                    break;
                }
                if CLEANING.swap(true, Ordering::SeqCst) {
                    // 清理中再次收到信号：立即退出
                    std::process::exit(1);
                }
                tauri::async_runtime::block_on(shutdown_resources(&app));
                std::process::exit(0);
            }
        }
    });
}

/// 启动时自动连接（迁移自 Electron 版 main/index.ts 的启动自动连接逻辑）。
/// auto_connect 开启且已选择服务器时，走统一启动入口 proxy_start_inner，
/// 系统代理、托盘菜单、自动选择服务由该入口一并同步。
async fn auto_connect_on_launch(app: &tauri::AppHandle) -> Result<(), String> {
    let cfg = config::load_config()?;
    if !cfg.auto_connect {
        return Ok(());
    }
    let log = |level: logs::LogLevel, msg: &str| {
        if let Some(logs) = app.try_state::<LogsState>() {
            let entry = logs
                .lock()
                .map(|mut m| m.add_log(level, msg, "autostart"))
                .ok()
                .flatten();
            if let Some(e) = entry {
                let _ = app.emit("event:logReceived", &e);
            }
        }
    };

    // 与启动流程的选中校验保持一致：选中单节点或选中非空分组都算有效
    if crate::proxy::validate_selection(&cfg).is_err() {
        log(
            logs::LogLevel::Warn,
            "启动时自动连接已启用，但未选择服务器或分组，跳过自动连接",
        );
        return Ok(());
    }
    // 与前端 autoConnect 事件的守卫一致：已在运行则不重复触发
    if app.state::<ProxyState>().lock().await.is_running() {
        log(logs::LogLevel::Info, "代理已在运行，跳过启动时自动连接");
        return Ok(());
    }

    log(
        logs::LogLevel::Info,
        "启动时自动连接已启用，正在连接...",
    );
    if let Err(e) = proxy_start_inner(app, None).await {
        log(
            logs::LogLevel::Error,
            &format!("启动时自动连接失败: {}", e),
        );
        return Err(e);
    }
    log(logs::LogLevel::Info, "启动时自动连接成功");
    Ok(())
}

/// 写一条更新检查日志到 LogManager（对应 Electron UpdateService 的日志）。
fn log_update(app: &tauri::AppHandle, level: logs::LogLevel, msg: &str) {
    if let Some(logs) = app.try_state::<LogsState>() {
        let entry = logs
            .lock()
            .map(|mut m| m.add_log(level, msg, "UpdateService"))
            .ok()
            .flatten();
        if let Some(e) = entry {
            let _ = app.emit("event:logReceived", &e);
        }
    }
}

/// 启动时自动检查更新（迁移自 Electron 版 main/index.ts：延迟 5s，避免影响启动体验）。
/// auto_check_update 开启时执行；仅在发现新版本时推送 event:updateCheckResult，
/// 避免每次启动都打扰（"已是最新"不提示）。
async fn auto_check_update_on_launch(app: &tauri::AppHandle) {
    let enabled = match config::load_config() {
        Ok(c) => c.auto_check_update,
        Err(_) => return,
    };
    if !enabled {
        return;
    }
    log_update(app, logs::LogLevel::Info, "正在自动检查更新...");
    match update_check_inner(false).await {
        Ok(r) => {
            let has_update = r.get("hasUpdate").and_then(|v| v.as_bool()).unwrap_or(false);
            if has_update {
                let version = r
                    .get("updateInfo")
                    .and_then(|i| i.get("version"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                log_update(app, logs::LogLevel::Info, &format!("发现新版本: {}", version));
                // 事件可能在 webview 注册监听器之前发出而被丢弃，
                // 因此同时存一份待处理结果供前端挂载时轮询兜底（对齐托盘动作的处理）。
                if let Some(pending) = app.try_state::<PendingUpdateResult>() {
                    if let Ok(mut slot) = pending.lock() {
                        *slot = Some(r.clone());
                    }
                }
                let _ = app.emit("event:updateCheckResult", &r);
            } else {
                log_update(app, logs::LogLevel::Info, "当前已是最新版本");
            }
        }
        Err(e) => {
            log_update(
                app,
                logs::LogLevel::Warn,
                &format!("启动时检查更新失败: {}", e),
            );
        }
    }
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
        // 发送 speedTestResult 事件到前端
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
        // 版本号 +1，前端轮询到变化时弹窗
        if let Some(v) = app.try_state::<tray::SpeedtestVersion>() {
            v.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        tray::refresh_tray_menu(&app).await;
    });
}

// ---------------------------------------------------------------------------
// 自动更新：GitHub Release 检查 + 下载 + 安装（对齐 Electron UpdateService）
// ---------------------------------------------------------------------------
// 检查 https://api.github.com/repos/zhangjh/FlowZ/releases/latest，
// 对比当前版本，有新版则返回下载链接；前端触发后应用内下载安装包（带进度事件），
// 下载完成再启动安装程序并退出应用，无需用户手动操作。

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
    // no_proxy：绕过系统代理/环境变量代理直连 GitHub API，
    // 避免走代理节点导致共享 IP 触发 GitHub 未认证限流（60 次/小时）
    let client = reqwest::Client::builder()
        .user_agent("FlowZ-updater")
        .no_proxy()
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
        // 403/429 通常是 GitHub 对当前出口 IP 的未认证限流（60 次/小时，按 IP 计数）：
        // 命中时给出可操作的中文提示，避免直接把原始 JSON 抛给用户
        if matches!(status.as_u16(), 403 | 429) {
            return Err(
                "GitHub 接口访问过于频繁，请稍后再试（未登录状态下每小时限额 60 次）"
                    .to_string(),
            );
        }
        let body = resp.text().await.unwrap_or_default();
        // 404 = 还没有发布过 release；其他按原文返回
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

    // 按当前平台选安装包；未找到对应平台安装包时视为无更新（对齐 Electron）
    let (download_url, file_name, file_size) = match pick_asset(&release.assets) {
        Some(a) => (a.browser_download_url.clone(), a.name.clone(), a.size),
        None => return Ok(serde_json::json!({ "hasUpdate": false })),
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

/// 下载更新安装包（对应 Electron UpdateService.downloadUpdate）。
/// 通过 `event:updateProgress` 上报进度，返回 { success, filePath }。
#[tauri::command]
async fn update_download(
    app: tauri::AppHandle,
    download_url: String,
    file_name: String,
    file_size: u64,
) -> Result<Value, String> {
    use std::io::Write;

    let emit_progress = |status: &str, percentage: u32, message: &str| {
        let _ = app.emit(
            "event:updateProgress",
            serde_json::json!({
                "status": status,
                "percentage": percentage,
                "message": message,
            }),
        );
    };

    emit_progress("downloading", 0, "正在下载更新...");

    let client = reqwest::Client::builder()
        .user_agent("FlowZ-updater")
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let mut resp = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| {
            emit_progress("error", 0, "下载失败");
            format!("下载失败: {}", e)
        })?;

    if !resp.status().is_success() {
        emit_progress("error", 0, "下载失败");
        return Err(format!("下载失败: HTTP {}", resp.status().as_u16()));
    }

    let total = if file_size > 0 {
        file_size
    } else {
        resp.content_length().unwrap_or(0)
    };

    let file_path = std::env::temp_dir().join(&file_name);
    if file_path.exists() {
        let _ = std::fs::remove_file(&file_path);
    }
    let mut file = std::fs::File::create(&file_path).map_err(|e| {
        emit_progress("error", 0, "创建文件失败");
        format!("创建文件失败: {}", e)
    })?;

    let mut downloaded: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| {
        emit_progress("error", 0, "下载失败");
        format!("下载数据失败: {}", e)
    })? {
        file.write_all(&chunk).map_err(|e| {
            emit_progress("error", 0, "写入文件失败");
            format!("写入文件失败: {}", e)
        })?;
        downloaded += chunk.len() as u64;
        if total > 0 {
            let percentage = ((downloaded.saturating_mul(100)) / total).min(100) as u32;
            let message = format!(
                "{:.1} MB / {:.1} MB",
                downloaded as f64 / 1024.0 / 1024.0,
                total as f64 / 1024.0 / 1024.0
            );
            emit_progress("downloading", percentage, &message);
        }
    }
    file.flush().map_err(|e| format!("刷新文件失败: {}", e))?;
    drop(file);

    emit_progress("downloaded", 100, "下载完成");

    Ok(serde_json::json!({
        "success": true,
        "filePath": file_path.to_string_lossy(),
    }))
}

/// 安装更新（对应 Electron UpdateService.installUpdate）。
/// 先停止代理与守护进程（避免 Windows 文件占用），再启动安装程序并退出应用。
#[tauri::command]
async fn update_install(app: tauri::AppHandle, file_path: String) -> Result<Value, String> {
    let path = std::path::PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("安装包不存在: {}", file_path));
    }

    // 安装前清理代理进程，避免安装包/文件被占用导致安装失败
    shutdown_resources(&app).await;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // VBScript：等待 2 秒确保应用退出后（正常窗口）启动安装程序，并删除自身
        let script = format!(
            "WScript.Sleep 2000\r\n\
             Set WshShell = CreateObject(\"WScript.Shell\")\r\n\
             WshShell.Run \"\"\"{}\"\"\", 1, False\r\n\
             Set fso = CreateObject(\"Scripting.FileSystemObject\")\r\n\
             fso.DeleteFile WScript.ScriptFullName, True\r\n",
            file_path
        );
        let vbs_path = std::env::temp_dir().join("flowz_update.vbs");
        std::fs::write(&vbs_path, script).map_err(|e| format!("写入更新脚本失败: {}", e))?;
        std::process::Command::new("wscript.exe")
            .arg(&vbs_path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;

        // 等待应用退出后打开 DMG，用户拖拽安装
        let script_path = std::env::temp_dir().join("flowz_update.sh");
        let script = format!("#!/bin/bash\nsleep 2\nopen \"{}\"\n", file_path);
        std::fs::write(&script_path, script).map_err(|e| format!("写入更新脚本失败: {}", e))?;
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("设置脚本权限失败: {}", e))?;
        std::process::Command::new("/bin/bash")
            .arg(&script_path)
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
    }

    // 给安装程序启动留出时间后退出应用（退出路径会再次走 graceful_exit，幂等）
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        app2.exit(0);
    });

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
            // 故障转移等后台调用方绕过 proxy_restart 命令，重启成功后在这里同步托盘
            //（托盘刷新放在锁外，refresh_tray_menu 内部会再获取 ProxyState 锁）
            let result = {
                let proxy = app.state::<ProxyState>();
                let mut guard = proxy.lock().await;
                guard.restart(&app, config).await
            };
            if result.is_ok() {
                update_tray_tooltip(&app, true).await;
                tray::refresh_tray_menu(&app).await;
            }
            result
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
    // 直接用正确的 sing-box 路径测速，不依赖 AutoSelectService 初始化时的开发期路径
    let singbox_path = proxy::resolve_singbox_path(&app)?;
    let work_dir = config::user_data_dir().unwrap_or_else(|_| std::env::temp_dir());
    let results = speedtest::test_multiple_servers(&cfg.servers, &singbox_path, &work_dir).await;
    // 转换为 ServerSpeedResult 格式（与 AutoSelectService::test_all_servers 一致）
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mapped: Vec<autoselect::ServerSpeedResult> = results
        .into_iter()
        .map(|r| autoselect::ServerSpeedResult {
            server_id: r.server_id,
            latency: r.latency,
            dial_latency: r.dial_latency,
            last_test_time: now.clone(),
            error: if r.latency.is_none() { Some("无法连接".to_string()) } else { r.error },
        })
        .collect();
    let results = mapped;
    let _svc: Arc<autoselect::AutoSelectService> = autoselect.inner().clone();
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
    // 创建任何后台线程前屏蔽 SIGTERM/SIGINT，使信号统一由专用线程处理
    //（Linux 注销/重启只会发 SIGTERM，不会触发 RunEvent::Exit）
    #[cfg(unix)]
    install_signal_mask();
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
    let app = builder
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .manage(shared_logs)
        .manage(PendingTrayAction::default())
        .manage(PendingUpdateResult::default())
        .manage(tray::SpeedtestVersion::default())
        .manage(Mutex::new(proxy_manager))
        .manage(Mutex::new(sysproxy::SystemProxyManager::new()))
        .manage(autoselect)
        .manage(tray::SpeedResultMap::default())
        .setup(|app| {
            // 启动自愈：上次异常退出（注销/重启/被杀）可能残留系统代理，先恢复
            sysproxy::restore_stale_system_proxy(false);
            // 注销/重启（SIGTERM/SIGINT）时同步清理，对齐原 Electron 版信号处理
            #[cfg(unix)]
            spawn_signal_handler(app.handle().clone());
            // 托盘（动态菜单）
            if let Err(e) = tray::setup_tray(app.handle()) {
                eprintln!("[tray] {}", e);
            }
            // 健康检查后台任务：每 30s 探测 sing-box 存活，意外退出时自动重启
            //（冷却：60s 内最多 3 次）
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
                loop {
                    interval.tick().await;
                    // 托盘刷新必须放在锁外：refresh_tray_menu 内部会再获取 ProxyState 锁
                    let restarted = {
                        let state = app_handle.state::<ProxyState>();
                        let mut mgr = state.lock().await;
                        mgr.tick(&app_handle).await
                    };
                    if restarted {
                        update_tray_tooltip(&app_handle, true).await;
                        tray::refresh_tray_menu(&app_handle).await;
                    }
                }
            });
            // 启动时自动连接（迁移自 Electron）：延迟 2s 等待服务与窗口初始化完成
            let app_handle_auto = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                if let Err(e) = auto_connect_on_launch(&app_handle_auto).await {
                    eprintln!("[autostart] 启动时自动连接失败: {}", e);
                }
            });
            // 启动时自动检查更新（迁移自 Electron）：延迟 5s，避免影响启动体验
            let app_handle_update = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                auto_check_update_on_launch(&app_handle_update).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // minimize_to_tray=true（默认）：阻止关闭、隐藏到托盘；
                // false：允许关闭窗口——退出清理由下方 RunEvent::ExitRequested 统一处理
                //（最后一个窗口关闭会触发 code=None 的退出请求，阻止默认退出后
                // 先停 sing-box、恢复系统代理，再真正退出，避免清理任务随进程被杀）
                let minimize_to_tray = config::load_config()
                    .map(|c| c.minimize_to_tray)
                    .unwrap_or(true);
                if minimize_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
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
            get_pending_update_result,
            get_tray_speedtest_results,
            get_tray_speedtest_version,
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
            update_download,
            update_install,
            update_open_releases,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    // 退出清理的一次性标志：必须在闭包外创建并 move 进去。
    // 若在闭包体内创建，每次事件都是全新状态，prevent_exit 会在
    // "app.exit → ExitRequested → 再 prevent" 之间无限循环，应用永远退不出去
    let cleanup_started = std::sync::atomic::AtomicBool::new(false);
    app.run(move |app, event| {
        use std::sync::atomic::Ordering;
        match event {
            // 正常退出路径（最后一个窗口关闭、托盘退出、Cmd+Q）统一走一次清理：
            // 停 sing-box 与守护进程、恢复系统代理，完成后再真正退出。
            // 进程直接退出会杀掉异步清理任务，导致 sing-box 残留、代理继续生效
            tauri::RunEvent::ExitRequested { api, .. } => {
                if !cleanup_started.swap(true, Ordering::SeqCst) {
                    api.prevent_exit();
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        graceful_exit(&app).await;
                    });
                    // graceful_exit 末尾的 app.exit(0) 会再触发一次 ExitRequested，
                    // 此时标志已置位，直接放行真正退出
                }
            }
            // 系统注销/重启不触发 ExitRequested，仅触发 Exit；此时异步清理已来不及，
            // 同步兜底恢复系统代理，避免重启后浏览器残留代理导致无法上网
            tauri::RunEvent::Exit => {
                sysproxy::restore_stale_system_proxy(true);
            }
            _ => {}
        }
    });
}
