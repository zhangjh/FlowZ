//! ProxyManager 移植（对应 `src/main/services/ProxyManager.ts` 的核心流程）。
//!
//! phase-3 范围：
//! - sing-box 配置生成 + 写入（systemProxy 模式）
//! - 进程启动 / 停止 / 重启（含重试、健康检查、自动重启冷却）
//! - 状态查询与事件推送（通道名与 Electron 版一致）
//! - TUN 模式：诚实报错（提权守护进程是 phase-4）
//!
//! 未移植（phase-4+）：PrivilegedSupervisor 提权流程、macOS TUN DNS、
//! Clash API  selector 热切换、日志流式解析。

use crate::config::{self, UserConfig};
use crate::singbox::{self, GenContext};
use crate::supervisor::{self, PrivilegedSupervisor};
use chrono::Utc;
use serde::Serialize;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::{Child, Command};

const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(30);
const MAX_RESTART_COUNT: u32 = 3;
const RESTART_COOLDOWN: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
pub struct ProxyStatusPayload {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct StartedPayload {
    pid: u32,
    timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
struct StoppedPayload {
    timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
struct ErrorPayload {
    error: String,
    timestamp: String,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub struct ProxyManager {
    direct_child: Option<Child>,
    supervisor: Option<PrivilegedSupervisor>,
    pid: Option<u32>,
    start_instant: Option<Instant>,
    start_time_iso: Option<String>,
    restart_count: u32,
    last_restart: Option<Instant>,
    last_config: Option<UserConfig>,
}

impl ProxyManager {
    pub fn new() -> Self {
        ProxyManager {
            direct_child: None,
            supervisor: None,
            pid: None,
            start_instant: None,
            start_time_iso: None,
            restart_count: 0,
            last_restart: None,
            last_config: None,
        }
    }

    pub fn is_running(&mut self) -> bool {
        if let Some(sup) = &self.supervisor {
            return sup.singbox_pid().is_some();
        }
        match &mut self.direct_child {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                _ => false,
            },
            None => false,
        }
    }

    /// 当前是否为 TUN 模式（supervisor 接管）
    pub fn is_tun(&self) -> bool {
        self.supervisor.is_some()
    }

    pub fn status(&mut self) -> ProxyStatusPayload {
        let running = self.is_running();
        ProxyStatusPayload {
            running,
            pid: if running { self.pid } else { None },
            start_time: if running {
                self.start_time_iso.clone()
            } else {
                None
            },
            uptime_secs: if running {
                self.start_instant.map(|t| t.elapsed().as_secs())
            } else {
                None
            },
        }
    }

    /// 启动代理（systemProxy 模式）
    pub async fn start(&mut self, app: &AppHandle, cfg: &UserConfig) -> Result<(), String> {
        self.start_with_reset(app, cfg, true).await
    }

    /// start 的内部实现；reset_count=false 时供自动重启使用（不重置计数）
    async fn start_with_reset(
        &mut self,
        app: &AppHandle,
        cfg: &UserConfig,
        reset_count: bool,
    ) -> Result<(), String> {
        if self.is_running() {
            self.stop(app).await?;
        }
        if reset_count {
            // 手动启动重置重启计数（与 TS 一致）
            self.reset_restart_count();
        }

        // 选中校验
        validate_selection(cfg)?;

        let tun = cfg.proxy_mode_type.to_string().to_lowercase() != "systemproxy";
        let ctx = gen_context(app)?;
        let sb_config = singbox::generate_singbox_config(cfg, &ctx)?;
        let config_path = ctx.user_data_dir.join("singbox_config.json");
        if let Some(dir) = config_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
        }
        let content = serde_json::to_string_pretty(&sb_config)
            .map_err(|e| format!("序列化 sing-box 配置失败: {}", e))?;
        std::fs::write(&config_path, content).map_err(|e| format!("写入 sing-box 配置失败: {}", e))?;

        let singbox = resolve_singbox_path(app)?;
        if !singbox.exists() {
            return Err(format!("找不到 sing-box 可执行文件: {}", singbox.display()));
        }

        if tun {
            self.start_tun(app, &ctx, &singbox).await?;
        } else {
            let mut child = spawn_with_retry(&singbox, &config_path).await?;
            // 排空 stdout/stderr，避免管道写满阻塞子进程（日志流式解析是后续工作）
            drain_pipes(&mut child);

            self.pid = child.id();
            self.direct_child = Some(child);
            self.supervisor = None;
        }
        self.start_instant = Some(Instant::now());
        self.start_time_iso = Some(now_iso());
        self.last_config = Some(cfg.clone());

        let _ = app.emit(
            "event:proxyStarted",
            StartedPayload {
                pid: self.pid.unwrap_or(0),
                timestamp: now_iso(),
            },
        );
        Ok(())
    }

    /// TUN 模式：通过特权守护进程启动（单次授权复用）
    async fn start_tun(
        &mut self,
        app: &AppHandle,
        ctx: &GenContext,
        singbox: &std::path::Path,
    ) -> Result<(), String> {
        let _ = app;
        let pid_file = ctx.user_data_dir.join("singbox.pid");
        let mut sup = PrivilegedSupervisor::new(
            singbox.to_path_buf(),
            ctx.user_data_dir.join("singbox_config.json"),
            ctx.user_data_dir.clone(),
            pid_file,
        );
        if !sup.ensure_started().await? {
            return Err("特权守护进程未能启动（用户可能取消了授权）".to_string());
        }
        sup.send_command(supervisor::CMD_START)?;
        let pid = sup
            .wait_for_singbox_pid(Duration::from_secs(10))
            .await
            .ok_or_else(|| "sing-box 未能启动（PID 文件未出现）".to_string())?;
        self.pid = Some(pid);
        self.direct_child = None;
        self.supervisor = Some(sup);
        Ok(())
    }

    pub async fn stop(&mut self, app: &AppHandle) -> Result<(), String> {
        if let Some(sup) = &mut self.supervisor {
            // TUN 模式：守护进程负责停止（supervisor 脚本内 SIGTERM→SIGKILL）
            let _ = sup.send_command(supervisor::CMD_STOP);
            self.supervisor = None;
        }
        if let Some(mut child) = self.direct_child.take() {
            // 先 SIGTERM，5 秒后仍未退出则 SIGKILL（与 TS 的 stopSingBoxProcess 一致）
            if let Some(pid) = self.pid {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
            let exited = wait_for_exit(&mut child, Duration::from_secs(5)).await;
            if !exited {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
        self.pid = None;
        self.start_instant = None;
        self.start_time_iso = None;
        let _ = app.emit(
            "event:proxyStopped",
            StoppedPayload {
                timestamp: now_iso(),
            },
        );
        Ok(())
    }

    /// App 退出前调用：停止代理并退出特权守护进程
    pub async fn shutdown(&mut self, app: &AppHandle) -> Result<(), String> {
        self.stop(app).await?;
        if let Some(mut sup) = self.supervisor.take() {
            let _ = sup.shutdown().await;
        }
        Ok(())
    }

    pub async fn restart(&mut self, app: &AppHandle, cfg: &UserConfig) -> Result<(), String> {
        let _ = app.emit("event:proxyRestarting", serde_json::json!({}));
        self.stop(app).await?;
        self.start(app, cfg).await
    }

    fn reset_restart_count(&mut self) {
        self.restart_count = 0;
        self.last_restart = None;
    }

    fn should_auto_restart(&mut self) -> bool {
        let now = Instant::now();
        if let Some(last) = self.last_restart {
            if now.duration_since(last) > RESTART_COOLDOWN {
                self.restart_count = 0;
            }
        }
        if self.restart_count >= MAX_RESTART_COUNT {
            return false;
        }
        self.restart_count += 1;
        self.last_restart = Some(now);
        true
    }

    /// 健康检查 tick：由后台任务每 30s 调用一次（持有 State 锁）。
    /// 返回 true 表示发生了自动重启。
    pub async fn tick(&mut self, app: &AppHandle) -> bool {
        let alive = self.is_running();
        if alive || self.last_config.is_none() {
            return false;
        }
        // 进程意外退出
        if self.should_auto_restart() {
            let _ = app.emit("event:proxyRestarting", serde_json::json!({}));
            if let Some(cfg) = self.last_config.clone() {
                // 重启时不重置计数（与 TS 的 isRestarting 语义一致）
                match self.start_with_reset(app, &cfg, false).await {
                    Ok(_) => return true,
                    Err(e) => {
                        let _ = app.emit(
                            "event:proxyError",
                            ErrorPayload {
                                error: format!("自动重启失败: {}", e),
                                timestamp: now_iso(),
                            },
                        );
                    }
                }
            }
        } else {
            let _ = app.emit(
                "event:proxyStopped",
                StoppedPayload {
                    timestamp: now_iso(),
                },
            );
            self.pid = None;
            self.start_instant = None;
            self.start_time_iso = None;
        }
        false
    }
}

/// 选中校验（与 TS start() 的 hasActive 检查一致）
fn validate_selection(cfg: &UserConfig) -> Result<(), String> {
    let has_active = cfg.selected_server_id.is_some()
        || cfg.selected_group_id.as_ref().map(|gid| {
            cfg.server_groups
                .iter()
                .any(|g| &g.id == gid && !g.server_ids.is_empty())
        }).unwrap_or(false);
    if !has_active {
        return Err("No server selected".to_string());
    }
    if let Some(ref gid) = cfg.selected_group_id {
        let group = cfg.server_groups.iter().find(|g| &g.id == gid);
        let valid = group
            .map(|g| {
                g.server_ids
                    .iter()
                    .filter(|id| cfg.servers.iter().any(|s| &s.id == *id))
                    .count()
            })
            .unwrap_or(0);
        if group.is_none() || valid == 0 {
            return Err("Selected group has no valid servers".to_string());
        }
    } else if let Some(ref sid) = cfg.selected_server_id {
        if !cfg.servers.iter().any(|s| &s.id == sid) {
            return Err("Selected server not found".to_string());
        }
    }
    Ok(())
}

fn gen_context(app: &AppHandle) -> Result<GenContext, String> {
    let user_data_dir = config::user_data_dir()?;
    // .srs 数据目录：环境变量 > Tauri resource dir > 开发期相对路径
    let data_dir = if let Ok(p) = std::env::var("FLOWZ_DATA_DIR") {
        PathBuf::from(p)
    } else if let Ok(res) = app.path().resource_dir() {
        let cand = res.join("data");
        if cand.exists() {
            cand
        } else {
            PathBuf::from("resources/data")
        }
    } else {
        PathBuf::from("resources/data")
    };
    Ok(GenContext {
        user_data_dir,
        data_dir,
    })
}

fn resolve_singbox_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("FLOWZ_SINGBOX_PATH") {
        return Ok(PathBuf::from(p));
    }
    let filename = if cfg!(target_os = "windows") {
        "sing-box.exe"
    } else {
        "sing-box"
    };
    // Tauri 打包后的 resource 目录（保持与 Electron 一致的 resources/<platform>/ 布局）
    if let Ok(res) = app.path().resource_dir() {
        #[cfg(target_os = "windows")]
        let cand = res.join("win").join(filename);
        #[cfg(target_os = "macos")]
        let cand = res.join("mac").join(filename);
        #[cfg(target_os = "linux")]
        let cand = res.join("linux").join(filename);
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        let cand = res.join(filename);
        if cand.exists() {
            return Ok(cand);
        }
    }
    // 开发期：仓库 resources/<platform>/ 布局
    #[cfg(target_os = "windows")]
    let dev = PathBuf::from("resources/win").join(filename);
    #[cfg(target_os = "macos")]
    let dev = PathBuf::from("resources/mac-arm64").join(filename);
    #[cfg(target_os = "linux")]
    let dev = PathBuf::from("resources/linux-x64").join(filename);
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let dev = PathBuf::from("resources").join(filename);
    Ok(dev)
}

fn is_retryable(msg: &str) -> bool {
    let m = msg.to_lowercase();
    for pat in [
        "找不到",
        "权限",
        "permission",
        "enoent",
        "eacces",
        "eperm",
        "配置文件格式错误",
        "invalid config",
    ] {
        if m.contains(pat) {
            return false;
        }
    }
    true
}

async fn spawn_with_retry(singbox: &PathBuf, config_path: &PathBuf) -> Result<Child, String> {
    let mut last_err = String::new();
    // 最多 3 次尝试（首试 + 2 次重试），延迟 2s、4s（与 TS exponentialBackoff 一致）
    for (attempt, delay) in [(0, 0), (1, 2), (2, 4)] {
        if delay > 0 {
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
        match spawn_singbox(singbox, config_path).await {
            Ok(child) => return Ok(child),
            Err(e) => {
                last_err = e.clone();
                if attempt >= 2 || !is_retryable(&e) {
                    return Err(e);
                }
            }
        }
    }
    Err(last_err)
}

async fn spawn_singbox(singbox: &PathBuf, config_path: &PathBuf) -> Result<Child, String> {
    Command::new(singbox)
        .arg("run")
        .arg("-c")
        .arg(config_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 sing-box 失败: {}", e))
}

/// 排空子进程的 stdout/stderr，防止管道写满阻塞
fn drain_pipes(child: &mut Child) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
    }
}

async fn wait_for_exit(child: &mut Child, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    return false;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(_) => return false,
        }
    }
}
