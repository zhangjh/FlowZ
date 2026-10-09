//! 自动选择最佳服务器服务（对应 AutoSelectService）。
//!
//! - 定时健康检查当前服务器（默认 60s，可配置）
//! - 当前服务器不可用时：全量测速 → 选最快 → 保存配置 → 热更新（失败则重启）
//! - 手动测速：test_all_servers
//!
//! 后台任务模型：AutoSelectService 持有 tokio JoinHandle，start/stop 控制。
//! 与 ProxyManager 的交互通过回调 trait 解耦，便于单测。

use crate::config::{ServerConfig, UserConfig};
use crate::logs::{LogLevel, SharedLogManager};
use crate::speedtest;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSpeedResult {
    pub server_id: String,
    pub latency: Option<u64>,
    pub dial_latency: Option<u64>,
    pub last_test_time: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSelectStatus {
    pub enabled: bool,
    pub current_best_server_id: Option<String>,
    pub last_test_results: Vec<ServerSpeedResult>,
    pub last_test_time: Option<String>,
    pub failover_count: u32,
}

/// 代理操作的回调（对应 IProxyManager）
pub trait ProxyControl: Send + Sync {
    fn hot_reload<'a>(
        &'a self,
        config: &'a UserConfig,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>>;
    fn restart<'a>(
        &'a self,
        config: &'a UserConfig,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>;
    fn is_running(&self) -> bool;
}

/// 事件推送回调（对应 IIpcEventEmitter）
pub trait EventEmitter: Send + Sync {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

pub struct AutoSelectService {
    inner: Arc<Mutex<Inner>>,
    logs: SharedLogManager,
    singbox_path: PathBuf,
    work_dir: PathBuf,
}

struct Inner {
    enabled: bool,
    config: Option<UserConfig>,
    current_best_server_id: Option<String>,
    last_test_results: Vec<ServerSpeedResult>,
    last_test_time: Option<String>,
    failover_count: u32,
    is_testing: bool,
    is_failing_over: bool,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl AutoSelectService {
    pub fn new(logs: SharedLogManager, singbox_path: PathBuf, work_dir: PathBuf) -> Self {
        AutoSelectService {
            inner: Arc::new(Mutex::new(Inner {
                enabled: false,
                config: None,
                current_best_server_id: None,
                last_test_results: Vec::new(),
                last_test_time: None,
                failover_count: 0,
                is_testing: false,
                is_failing_over: false,
                task: None,
            })),
            logs,
            singbox_path,
            work_dir,
        }
    }

    fn log(&self, level: LogLevel, msg: &str) {
        if let Ok(mut m) = self.logs.lock() {
            m.add_log(level, msg, "AutoSelectService");
        }
    }

    /// 启动服务（对应 start）：只记录配置，健康检查等代理启动后由 notify_proxy_started 触发
    pub fn configure(&self, config: UserConfig) {
        let enabled = config.auto_select.enabled && config.selected_group_id.is_none();
        let mut inner = self.inner.lock().unwrap();
        inner.config = Some(config);
        if inner.enabled != enabled {
            inner.enabled = enabled;
        }
        if !enabled {
            Self::stop_task_inner(&mut inner);
        }
    }

    /// 代理启动后调用：开始健康检查
    pub fn notify_proxy_started<P, E>(&self, proxy: Arc<P>, emitter: Arc<E>)
    where
        P: ProxyControl + 'static,
        E: EventEmitter + 'static,
    {
        let enabled = self.inner.lock().unwrap().enabled;
        if !enabled {
            return;
        }
        self.log(LogLevel::Info, "自动选择服务已初始化，开始健康检查");
        self.start_health_check(proxy, emitter);
    }

    pub fn stop(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.enabled = false;
        Self::stop_task_inner(&mut inner);
        drop(inner);
        self.log(LogLevel::Info, "自动选择服务已停止");
    }

    fn stop_task_inner(inner: &mut Inner) {
        if let Some(handle) = inner.task.take() {
            handle.abort();
        }
    }

    fn start_health_check<P, E>(&self, proxy: Arc<P>, emitter: Arc<E>)
    where
        P: ProxyControl + 'static,
        E: EventEmitter + 'static,
    {
        let mut inner = self.inner.lock().unwrap();
        if inner.task.is_some() {
            return;
        }
        let interval_secs = inner
            .config
            .as_ref()
            .map(|c| c.auto_select.interval)
            .unwrap_or(60);
        let this = self.clone_handle();
        let handle = tokio::spawn(async move {
            // 延迟 5s 第一次检查
            tokio::time::sleep(Duration::from_secs(5)).await;
            loop {
                this.perform_health_check(proxy.clone(), emitter.clone()).await;
                tokio::time::sleep(Duration::from_secs(interval_secs as u64)).await;
            }
        });
        inner.task = Some(handle);
    }

    fn clone_handle(&self) -> Self {
        AutoSelectService {
            inner: self.inner.clone(),
            logs: self.logs.clone(),
            singbox_path: self.singbox_path.clone(),
            work_dir: self.work_dir.clone(),
        }
    }

    async fn perform_health_check<P, E>(&self, proxy: Arc<P>, _emitter: Arc<E>)
    where
        P: ProxyControl + 'static,
        E: EventEmitter + 'static,
    {
        // 并发保护
        {
            let inner = self.inner.lock().unwrap();
            if inner.is_testing || inner.is_failing_over || !inner.enabled {
                return;
            }
        }
        let (servers, selected_id) = {
            let inner = self.inner.lock().unwrap();
            match &inner.config {
                Some(c) => (c.servers.clone(), c.selected_server_id.clone()),
                None => return,
            }
        };
        if servers.is_empty() {
            return;
        }
        let current = selected_id
            .as_ref()
            .and_then(|id| servers.iter().find(|s| &s.id == id));

        match current {
            None => {
                self.log(LogLevel::Warn, "没有选中的服务器，尝试选择最佳服务器");
                self.perform_failover(proxy, _emitter).await;
            }
            Some(server) => {
                let latency =
                    speedtest::test_latency(server, &self.singbox_path, &self.work_dir, Duration::from_secs(3)).await;
                match latency {
                    Some(ms) => {
                        self.log(LogLevel::Debug, &format!("当前服务器 {} 健康，延迟: {}ms", server.name, ms));
                    }
                    None => {
                        self.log(LogLevel::Warn, &format!("当前服务器 {} 不可用，触发故障转移", server.name));
                        self.perform_failover(proxy, _emitter).await;
                    }
                }
            }
        }
    }

    /// 立即触发故障转移（渲染进程检测到请求失败时调用）
    pub async fn trigger_immediate_failover<P, E>(&self, proxy: Arc<P>, emitter: Arc<E>)
    where
        P: ProxyControl + 'static,
        E: EventEmitter + 'static,
    {
        let (enabled, servers, selected_id) = {
            let inner = self.inner.lock().unwrap();
            if !inner.enabled || inner.is_testing || inner.is_failing_over {
                return;
            }
            match &inner.config {
                Some(c) => (true, c.servers.clone(), c.selected_server_id.clone()),
                None => return,
            }
        };
        let _ = enabled;
        let current = selected_id
            .as_ref()
            .and_then(|id| servers.iter().find(|s| &s.id == id));
        match current {
            None => {
                self.perform_failover(proxy, emitter).await;
            }
            Some(server) => {
                self.log(LogLevel::Info, &format!("立即故障转移：检测当前服务器 {}...", server.name));
                let latency = speedtest::test_latency(
                    server,
                    &self.singbox_path,
                    &self.work_dir,
                    Duration::from_secs(3),
                )
                .await;
                if latency.is_some() {
                    self.log(LogLevel::Info, &format!("当前服务器 {} 正常，无需切换", server.name));
                    return;
                }
                self.log(LogLevel::Warn, &format!("当前服务器 {} 确认故障，开始转移", server.name));
                self.perform_failover(proxy, emitter).await;
            }
        }
    }

    /// 手动测试全部服务器
    pub async fn test_all_servers(&self, servers: Vec<ServerConfig>) -> Vec<ServerSpeedResult> {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.is_testing {
                self.log(LogLevel::Warn, "速度测试正在进行中，请稍后再试");
                return inner.last_test_results.clone();
            }
            inner.is_testing = true;
        }
        self.log(LogLevel::Info, &format!("开始测试 {} 个服务器...", servers.len()));
        let results = speedtest::test_multiple_servers(&servers, &self.singbox_path, &self.work_dir).await;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mapped: Vec<ServerSpeedResult> = results
            .into_iter()
            .map(|r| ServerSpeedResult {
                server_id: r.server_id,
                latency: r.latency,
                dial_latency: r.dial_latency,
                last_test_time: now.clone(),
                error: if r.latency.is_none() { Some("无法连接".to_string()) } else { r.error },
            })
            .collect();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.last_test_results = mapped.clone();
            inner.last_test_time = Some(now);
            inner.is_testing = false;
            // 更新最佳服务器
            if let Some(best) = Self::best_server(&servers, &mapped) {
                if inner.current_best_server_id.as_deref() != Some(&best.id) {
                    self.log(LogLevel::Info, &format!("最佳服务器已更新: {}", best.name));
                    inner.current_best_server_id = Some(best.id.clone());
                }
            }
        }
        self.log(LogLevel::Info, "服务器测试完成");
        mapped
    }

    fn best_server<'a>(servers: &'a [ServerConfig], results: &[ServerSpeedResult]) -> Option<&'a ServerConfig> {
        let mut best: Option<(&ServerConfig, u64)> = None;
        for r in results.iter().filter(|r| r.latency.is_some()) {
            let latency = r.latency.unwrap();
            let server = servers.iter().find(|s| s.id == r.server_id)?;
            if best.map(|(_, l)| latency < l).unwrap_or(true) {
                best = Some((server, latency));
            }
        }
        best.map(|(s, _)| s)
    }

    async fn perform_failover<P, E>(&self, proxy: Arc<P>, emitter: Arc<E>)
    where
        P: ProxyControl + 'static,
        E: EventEmitter + 'static,
    {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.is_failing_over {
                return;
            }
            inner.is_failing_over = true;
        }

        let result: Result<(), String> = async {
            let (servers, failover_enabled, old_id) = {
                let inner = self.inner.lock().unwrap();
                let cfg = inner.config.clone().ok_or("无配置")?;
                (
                    cfg.servers.clone(),
                    cfg.auto_select.failover_enabled,
                    cfg.selected_server_id.clone(),
                )
            };
            if !failover_enabled {
                self.log(LogLevel::Info, "故障转移已禁用");
                return Ok(());
            }
            if servers.is_empty() {
                return Err("没有可用的服务器".to_string());
            }

            let results = speedtest::test_multiple_servers(&servers, &self.singbox_path, &self.work_dir).await;
            let best = results
                .iter()
                .filter(|r| r.latency.is_some())
                .min_by_key(|r| r.latency.unwrap())
                .and_then(|r| servers.iter().find(|s| s.id == r.server_id).map(|s| (s, r.latency.unwrap())))
                .ok_or("没有可用的备用服务器")?;

            if Some(&best.0.id) == old_id.as_ref() {
                self.log(LogLevel::Info, "当前服务器仍是最佳选择，无需切换");
                return Ok(());
            }

            self.log(LogLevel::Info, &format!("故障转移到: {} (延迟: {}ms)", best.0.name, best.1));

            // 更新配置并保存
            let mut new_config = {
                let inner = self.inner.lock().unwrap();
                inner.config.clone().ok_or("无配置")?
            };
            new_config.selected_server_id = Some(best.0.id.clone());
            crate::config::save_config(&new_config)?;
            {
                let mut inner = self.inner.lock().unwrap();
                inner.config = Some(new_config.clone());
                inner.current_best_server_id = Some(best.0.id.clone());
                inner.failover_count += 1;
                let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                inner.last_test_results = results
                    .iter()
                    .map(|r| ServerSpeedResult {
                        server_id: r.server_id.clone(),
                        latency: r.latency,
                        dial_latency: r.dial_latency,
                        last_test_time: now.clone(),
                        error: if r.latency.is_none() { Some("无法连接".to_string()) } else { None },
                    })
                    .collect();
                inner.last_test_time = Some(now);
            }

            emitter.emit("event:configChanged", serde_json::json!({ "newValue": new_config }));

            // 热更新，失败则重启
            if !proxy.hot_reload(&new_config).await {
                self.log(LogLevel::Warn, "热更新失败，尝试重启代理");
                emitter.emit("event:proxyRestarting", serde_json::json!({}));
                proxy.restart(&new_config).await?;
            }

            let failover_count = self.inner.lock().unwrap().failover_count;
            emitter.emit(
                "event:autoSelectFailover",
                serde_json::json!({
                    "from": old_id,
                    "to": best.0.id,
                    "server": best.0,
                    "latency": best.1,
                    "failoverCount": failover_count,
                }),
            );
            Ok(())
        }
        .await;

        if let Err(e) = result {
            self.log(LogLevel::Error, &format!("故障转移失败: {}", e));
        }
        self.inner.lock().unwrap().is_failing_over = false;
    }

    pub fn get_status(&self) -> AutoSelectStatus {
        let inner = self.inner.lock().unwrap();
        AutoSelectStatus {
            enabled: inner.enabled,
            current_best_server_id: inner.current_best_server_id.clone(),
            last_test_results: inner.last_test_results.clone(),
            last_test_time: inner.last_test_time.clone(),
            failover_count: inner.failover_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn best_server_picks_lowest_latency() {
        let servers = vec![
            ServerConfig {
                id: "a".to_string(),
                name: "A".to_string(),
                protocol: crate::config::Protocol::Vless,
                address: "a.example.com".to_string(),
                port: 443,
                uuid: None, encryption: None, flow: None, password: None,
                hysteria2_settings: None, network: None, security: None,
                tls_settings: None, reality_settings: None, ws_settings: None,
                grpc_settings: None, http_settings: None, group_id: None,
                created_at: None, updated_at: None,
            },
            ServerConfig {
                id: "b".to_string(),
                name: "B".to_string(),
                protocol: crate::config::Protocol::Vless,
                address: "b.example.com".to_string(),
                port: 443,
                uuid: None, encryption: None, flow: None, password: None,
                hysteria2_settings: None, network: None, security: None,
                tls_settings: None, reality_settings: None, ws_settings: None,
                grpc_settings: None, http_settings: None, group_id: None,
                created_at: None, updated_at: None,
            },
        ];
        let results = vec![
            ServerSpeedResult { server_id: "a".to_string(), latency: Some(200), dial_latency: Some(300), last_test_time: String::new(), error: None },
            ServerSpeedResult { server_id: "b".to_string(), latency: Some(50), dial_latency: Some(80), last_test_time: String::new(), error: None },
        ];
        assert_eq!(AutoSelectService::best_server(&servers, &results).unwrap().id, "b");
    }

    #[test]
    fn configure_disables_with_group_selected() {
        let logs = crate::logs::new_shared();
        let svc = AutoSelectService::new(logs, PathBuf::from("/tmp"), PathBuf::from("/tmp"));
        let mut cfg = match crate::config::load_config() {
            Ok(c) => c,
            Err(_) => return, // 无配置文件时跳过
        };
        cfg.auto_select.enabled = true;
        cfg.selected_group_id = Some("g1".to_string());
        svc.configure(cfg);
        assert!(!svc.get_status().enabled);
    }
}
