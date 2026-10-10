//! 托盘动态菜单（对应 TrayManager.updateFullTrayMenu）。
//!
//! 菜单结构（与 Electron 版一致）：
//!   状态（🔵已连接/⚪已断开/🔴连接异常）
//!   启用代理/禁用代理
//!   选择服务器 → 分组（radio）+ 未分组节点（radio，带延迟）+ 管理服务器
//!   代理模式 → 全局代理/智能分流/直连模式（radio）
//!   打开主窗口 / 打开设置 / 检查更新 / 测试全部服务器速度 / 退出

use crate::config::{ProxyMode, ServerConfig, ServerGroup, UserConfig};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// 托盘服务器标签上的延迟缓存
pub type SpeedResultMap = Arc<Mutex<HashMap<String, Option<u64>>>>;
/// 测速完成版本号，每次托盘测速完成时 +1，前端轮询此版本号决定是否弹窗
pub type SpeedtestVersion = Arc<std::sync::atomic::AtomicU64>;

pub struct TrayMenuData {
    pub is_running: bool,
    pub has_error: bool,
    pub servers: Vec<ServerConfig>,
    pub groups: Vec<ServerGroup>,
    pub selected_server_id: Option<String>,
    pub selected_group_id: Option<String>,
    pub proxy_mode: ProxyMode,
    pub speed_results: HashMap<String, Option<u64>>,
}

impl TrayMenuData {
    pub fn from_config(config: &UserConfig, is_running: bool, speed_results: HashMap<String, Option<u64>>) -> Self {
        TrayMenuData {
            is_running,
            has_error: false,
            servers: config.servers.clone(),
            groups: config.server_groups.clone(),
            selected_server_id: config.selected_server_id.clone(),
            selected_group_id: config.selected_group_id.clone(),
            proxy_mode: config.proxy_mode,
            speed_results,
        }
    }
}

fn truncate_label(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        format!("{}...", s.chars().take(max - 3).collect::<String>())
    } else {
        s.to_string()
    }
}

pub fn build_menu(app: &AppHandle, data: &TrayMenuData) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    use tauri::menu::{
        CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
    };

    let status_label = if data.has_error {
        "🔴 连接异常"
    } else if data.is_running {
        "🔵 已连接"
    } else {
        "⚪ 已断开"
    };
    let status = MenuItemBuilder::with_id("status", status_label)
        .enabled(false)
        .build(app)
        .map_err(|e| e.to_string())?;

    let toggle = MenuItemBuilder::with_id(
        "toggle",
        if data.is_running { "禁用代理" } else { "启用代理" },
    )
    .build(app)
    .map_err(|e| e.to_string())?;

    // ---- 选择服务器子菜单 ----
    let mut server_sub = SubmenuBuilder::new(app, "选择服务器");
    let grouped_ids: std::collections::HashSet<&str> = data
        .groups
        .iter()
        .flat_map(|g| g.server_ids.iter().map(|s| s.as_str()))
        .collect();
    let ungrouped: Vec<&ServerConfig> = data
        .servers
        .iter()
        .filter(|s| !grouped_ids.contains(s.id.as_str()))
        .collect();

    for group in &data.groups {
        let member_count = group
            .server_ids
            .iter()
            .filter(|id| data.servers.iter().any(|s| &s.id == *id))
            .count();
        let label = truncate_label(&format!("{}（分组·{}节点）", group.name, member_count), 30);
        let item = CheckMenuItemBuilder::with_id(format!("group:{}", group.id), label)
            .checked(Some(&group.id) == data.selected_group_id.as_ref())
            .build(app)
            .map_err(|e| e.to_string())?;
        server_sub = server_sub.item(&item);
    }
    if !data.groups.is_empty() {
        server_sub = server_sub.item(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?);
    }
    for server in ungrouped {
        let latency_str = match data.speed_results.get(&server.id) {
            Some(Some(ms)) => format!(" [{}ms]", ms),
            Some(None) => " [超时]".to_string(),
            None => String::new(),
        };
        let label = truncate_label(
            &format!("{}（{}）{}", server.name, server.protocol.to_string().to_uppercase(), latency_str),
            30,
        );
        let item = CheckMenuItemBuilder::with_id(format!("server:{}", server.id), label)
            .checked(Some(&server.id) == data.selected_server_id.as_ref())
            .build(app)
            .map_err(|e| e.to_string())?;
        server_sub = server_sub.item(&item);
    }
    if !data.servers.is_empty() || !data.groups.is_empty() {
        server_sub = server_sub.item(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?);
    } else {
        let empty = MenuItemBuilder::with_id("no-servers", "未配置服务器")
            .enabled(false)
            .build(app)
            .map_err(|e| e.to_string())?;
        server_sub = server_sub.item(&empty);
        server_sub = server_sub.item(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?);
    }
    let manage = MenuItemBuilder::with_id("manage-servers", "管理服务器")
        .build(app)
        .map_err(|e| e.to_string())?;
    let server_menu = server_sub.item(&manage).build().map_err(|e| e.to_string())?;

    // ---- 代理模式子菜单 ----
    let mode_labels = [
        (ProxyMode::Global, "全局代理"),
        (ProxyMode::Smart, "智能分流"),
        (ProxyMode::Direct, "直连模式"),
    ];
    let mut mode_sub = SubmenuBuilder::new(app, "代理模式");
    for (mode, label) in mode_labels {
        let item = CheckMenuItemBuilder::with_id(
            format!("mode:{}", mode.to_string().to_lowercase()),
            label,
        )
        .checked(data.proxy_mode == mode)
        .build(app)
        .map_err(|e| e.to_string())?;
        mode_sub = mode_sub.item(&item);
    }
    let mode_menu = mode_sub.build().map_err(|e| e.to_string())?;

    let show = MenuItemBuilder::with_id("show", "打开主窗口")
        .build(app)
        .map_err(|e| e.to_string())?;
    let settings = MenuItemBuilder::with_id("settings", "打开设置")
        .build(app)
        .map_err(|e| e.to_string())?;
    let update = MenuItemBuilder::with_id("update", "检查更新")
        .build(app)
        .map_err(|e| e.to_string())?;
    let speedtest = MenuItemBuilder::with_id("speedtest", "服务器测速")
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("quit", "退出")
        .build(app)
        .map_err(|e| e.to_string())?;

    MenuBuilder::new(app)
        .item(&status)
        .item(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .item(&toggle)
        .item(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .item(&server_menu)
        .item(&mode_menu)
        .item(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .item(&show)
        .item(&settings)
        .item(&update)
        .item(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .item(&speedtest)
        .item(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .item(&quit)
        .build()
        .map_err(|e| e.to_string())
}

/// 刷新托盘菜单（配置/状态变化后调用）
pub async fn refresh_tray_menu(app: &AppHandle) {
    let tray = match app.tray_by_id("main") {
        Some(t) => t,
        None => return,
    };
    let config = match crate::config::load_config() {
        Ok(c) => c,
        Err(_) => return,
    };
    let running = match app.try_state::<crate::ProxyState>() {
        Some(s) => s.lock().await.is_running(),
        None => false,
    };
    let speeds = app
        .try_state::<SpeedResultMap>()
        .map(|s| s.lock().map(|m| m.clone()).unwrap_or_default())
        .unwrap_or_default();
    let data = TrayMenuData::from_config(&config, running, speeds);
    match build_menu(app, &data) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(e) => eprintln!("[tray] 刷新菜单失败: {}", e),
    }
    // 更新托盘图标：连接时彩色，断开时灰色（与原版一致）
    update_tray_icon(app, running);
}

/// 更新托盘图标（彩色/灰色）
pub fn update_tray_icon(app: &AppHandle, connected: bool) {
    let tray = match app.tray_by_id("main") {
        Some(t) => t,
        None => return,
    };
    let filename = if connected { "app.png" } else { "app-gray.png" };
    // 从打包资源目录加载（与 setup_tray 一致）
    let icon_path = app
        .path()
        .resource_dir()
        .map(|d| d.join(filename))
        .unwrap_or_else(|_| std::path::PathBuf::from("resources").join(filename));
    if let Ok(rgba) = image::open(&icon_path).map(|img| img.to_rgba8()) {
        let (w, h) = (rgba.width(), rgba.height());
        let icon = tauri::image::Image::new_owned(rgba.into_raw(), w, h);
        let _ = tray.set_icon(Some(icon));
    }
}

/// 创建托盘（动态菜单 + 事件分发）
pub fn setup_tray(app: &AppHandle) -> Result<(), String> {
    use tauri::tray::{MouseButton, TrayIconBuilder};

    let icon_path = app
        .path()
        .resource_dir()
        .ok()
        .map(|r| r.join("bundle-resources").join("app.png"))
        .filter(|p| p.exists())
        .or_else(|| {
            app.path()
                .resource_dir()
                .ok()
                .map(|r| r.join("app.png"))
                .filter(|p| p.exists())
        })
        .unwrap_or_else(|| std::path::PathBuf::from("resources/app.png"));
    let rgba = image::open(&icon_path)
        .map_err(|e| format!("加载托盘图标失败: {}", e))?
        .to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let icon = tauri::image::Image::new_owned(rgba.into_raw(), w, h);

    let speeds = app
        .try_state::<SpeedResultMap>()
        .map(|s| s.lock().map(|m| m.clone()).unwrap_or_default())
        .unwrap_or_default();
    let data = match crate::config::load_config() {
        Ok(c) => TrayMenuData::from_config(&c, false, speeds),
        Err(_) => TrayMenuData {
            is_running: false,
            has_error: false,
            servers: Vec::new(),
            groups: Vec::new(),
            selected_server_id: None,
            selected_group_id: None,
            proxy_mode: crate::config::ProxyMode::Smart,
            speed_results: speeds,
        },
    };
    let menu = build_menu(app, &data)?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("FlowZ")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let app = app.clone();
            let id = event.id().as_ref().to_string();
            tauri::async_runtime::spawn(async move {
                handle_menu_event(&app, &id).await;
            });
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 写托盘日志到实时日志
fn tray_log(app: &AppHandle, msg: &str) {
    if let Some(logs) = app.try_state::<crate::logs::SharedLogManager>() {
        let entry = logs
            .lock()
            .map(|mut m| {
                m.add_log(
                    crate::logs::LogLevel::Info,
                    &format!("[tray] {}", msg),
                    "tray",
                )
            })
            .ok()
            .flatten();
        if let Some(e) = entry {
            let _ = app.emit("event:logReceived", &e);
        }
    }
}

/// 托盘菜单事件分发
async fn handle_menu_event(app: &AppHandle, id: &str) {
    tray_log(app, &format!("收到菜单点击: {}", id));
    match id {
        "show" => {
            tray_log(app, "打开主窗口");
            show_main_window(app);
        }
        "toggle" => {
            tray_log(app, "执行 toggle");
            let running = match app.try_state::<crate::ProxyState>() {
                Some(s) => s.lock().await.is_running(),
                None => false,
            };
            if running {
                tray_log(app, "正在停止代理...");
                if let Err(e) = crate::proxy_stop_inner(&app).await {
                    tray_log(app, &format!("停止代理失败: {}", e));
                } else {
                    tray_log(app, "停止代理完成");
                    // 通知前端刷新（proxyStopped 事件的双保险）
                    let _ = app.emit("event:configChanged", serde_json::json!({}));
                }
            } else {
                tray_log(app, "正在启动代理...");
                if let Err(e) = crate::proxy_start_inner(&app, None).await {
                    tray_log(app, &format!("启动代理失败: {}", e));
                } else {
                    tray_log(app, "启动代理完成");
                    // 通知前端刷新（proxyStarted 事件的双保险）
                    let _ = app.emit("event:configChanged", serde_json::json!({}));
                }
            }
            refresh_tray_menu(app).await;
        }
        "manage-servers" => {
            tray_log(app, "打开servers页面");
            show_main_window(app);
            // 事件 + 轮询双保险
            let _ = app.emit("event:navigate", serde_json::json!({ "page": "servers" }));
            if let Some(pending) = app.try_state::<crate::PendingTrayAction>() {
                if let Ok(mut p) = pending.lock() {
                    *p = Some("navigate:servers".to_string());
                }
            }
            tray_log(app, "已发送 navigate 事件");
        }
        "settings" => {
            tray_log(app, "打开settings页面");
            show_main_window(app);
            // 事件 + 轮询双保险
            let _ = app.emit("event:navigate", serde_json::json!({ "page": "settings" }));
            if let Some(pending) = app.try_state::<crate::PendingTrayAction>() {
                if let Ok(mut p) = pending.lock() {
                    *p = Some("navigate:settings".to_string());
                }
            }
            tray_log(app, "已发送 navigate 事件");
        }
        "update" => {
            tray_log(app, "开始检查更新...");
            match crate::update_check_inner(false).await {
                Ok(r) => {
                    tray_log(app, "检查更新完成，已发送事件");
                    let _ = app.emit("event:updateCheckResult", &r);
                }
                Err(e) => tray_log(app, &format!("检查更新失败: {}", e)),
            }
        }
        "speedtest" => {
            tray_log(app, "开始服务器测速...");
            crate::run_tray_speedtest(&app);
        }
        "quit" => {
            tray_log(app, "正在退出...");
            let proxy = app.state::<crate::ProxyState>();
            {
                let mut mgr = proxy.lock().await;
                let _ = mgr.shutdown(app).await;
            }
            // 恢复系统代理设置，避免注册表残留导致断网
            let sysproxy = app.state::<crate::SysProxyState>();
            {
                let mut sp = sysproxy.lock().await;
                let _ = sp.disable_proxy().await;
            }
            app.exit(0);
        }
        _ if id.starts_with("server:") => {
            let server_id = &id["server:".len()..];
            tray_log(app, &format!("切换服务器: {}", server_id));
            let proxy = app.state::<crate::ProxyState>();
            if let Err(e) = proxy.lock().await.switch_server(app, server_id).await {
                tray_log(app, &format!("切换服务器失败: {}", e));
            } else {
                tray_log(app, "切换服务器完成");
            }
            refresh_tray_menu(app).await;
        }
        _ if id.starts_with("group:") => {
            let group_id = &id["group:".len()..];
            tray_log(app, &format!("切换分组: {}", group_id));
            if let Err(e) = crate::switch_group(app, group_id).await {
                tray_log(app, &format!("切换分组失败: {}", e));
            } else {
                tray_log(app, "切换分组完成");
            }
            refresh_tray_menu(app).await;
        }
        _ if id.starts_with("mode:") => {
            let mode = &id["mode:".len()..];
            tray_log(app, &format!("切换代理模式: {}", mode));
            if let Err(e) = crate::switch_proxy_mode(app, mode).await {
                tray_log(app, &format!("切换代理模式失败: {}", e));
            } else {
                tray_log(app, "切换代理模式完成");
            }
            refresh_tray_menu(app).await;
        }
        _ => {}
    }
}
