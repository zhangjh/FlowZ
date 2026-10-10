//! 日志管理（对应 LogManager + ProxyManager 的日志解析流水线）。
//!
//! - LogManager：1000 条环形缓冲，按级别过滤
//! - sing-box stdout 解析：ANSI 清理 → proxy-<uuid> 简化 → 去重 → 低价值过滤
//!   → 级别解析 → 中文友好翻译

use chrono::Utc;
use regex::Regex;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl LogLevel {
    fn priority(self) -> u8 {
        match self {
            LogLevel::Debug => 0,
            LogLevel::Info => 1,
            LogLevel::Warn => 2,
            LogLevel::Error => 3,
            LogLevel::Fatal => 4,
        }
    }

    pub fn parse(s: &str) -> Option<LogLevel> {
        match s.to_uppercase().as_str() {
            "DEBUG" => Some(LogLevel::Debug),
            "INFO" => Some(LogLevel::Info),
            "WARN" | "WARNING" => Some(LogLevel::Warn),
            "ERROR" => Some(LogLevel::Error),
            "FATAL" => Some(LogLevel::Fatal),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: LogLevel,
    pub message: String,
    pub source: String,
}

/// 环形缓冲的日志管理器（对应 LogManager）
pub struct LogManager {
    ring: VecDeque<LogEntry>,
    max_logs: usize,
    level: LogLevel,
}

impl LogManager {
    pub fn new() -> Self {
        LogManager {
            ring: VecDeque::with_capacity(1000),
            max_logs: 1000,
            level: LogLevel::Info,
        }
    }

    pub fn set_level(&mut self, level: LogLevel) {
        self.level = level;
    }

    pub fn get_level(&self) -> LogLevel {
        self.level
    }

    pub fn add_log(&mut self, level: LogLevel, message: &str, source: &str) -> Option<LogEntry> {
        if level.priority() < self.level.priority() {
            return None;
        }
        let entry = LogEntry {
            timestamp: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            level,
            message: message.to_string(),
            source: source.to_string(),
        };
        if self.ring.len() >= self.max_logs {
            self.ring.pop_front();
        }
        self.ring.push_back(entry.clone());
        Some(entry)
    }

    pub fn get_logs(&self, limit: Option<usize>) -> Vec<LogEntry> {
        let take = limit.map(|l| l.min(self.ring.len())).unwrap_or(self.ring.len());
        self.ring.iter().skip(self.ring.len() - take).cloned().collect()
    }

    pub fn clear(&mut self) {
        self.ring.clear();
    }
}

/// sing-box 日志行解析流水线（对应 ProxyManager.parseAndLogLine 系列）
pub struct LogPipeline {
    last_message: String,
    last_count: u32,
    last_time: Option<Instant>,
    ansi_re: Regex,
    uuid_re: Regex,
    level_re: Regex,
    error_word_re: Regex,
}

impl LogPipeline {
    pub fn new() -> Self {
        LogPipeline {
            last_message: String::new(),
            last_count: 0,
            last_time: None,
            ansi_re: Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]").unwrap(),
            uuid_re: Regex::new(
                r"\bproxy-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
            )
            .unwrap(),
            level_re: Regex::new(r"\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b").unwrap(),
            error_word_re: Regex::new(r"\b(error|fatal|warn|warning|failed|failure)\b").unwrap(),
        }
    }

    /// 处理一行原始日志，返回 (level, 友好消息)；None 表示过滤掉
    pub fn process_line(&mut self, line: &str) -> Option<(LogLevel, String)> {
        let line = self.ansi_re.replace_all(line, String::new());
        let line = self.uuid_re.replace_all(&line, "proxy");
        let line = line.trim().to_string();
        if line.is_empty() {
            return None;
        }
        if self.is_duplicate(&line) {
            return None;
        }
        if self.is_low_value(&line) {
            return None;
        }
        match self.parse_singbox_log(&line) {
            Some((level, message)) => {
                let friendly = translate_error_message(&message);
                if friendly.is_empty() {
                    None
                } else {
                    Some((level, friendly))
                }
            }
            None => Some((LogLevel::Info, line)),
        }
    }

    fn is_duplicate(&mut self, message: &str) -> bool {
        let now = Instant::now();
        if message == self.last_message {
            if let Some(t) = self.last_time {
                if now.duration_since(t).as_millis() < 1000 {
                    self.last_count += 1;
                    return self.last_count > 5;
                }
            }
        }
        self.last_message = message.to_string();
        self.last_count = 1;
        self.last_time = Some(now);
        false
    }

    fn is_low_value(&self, line: &str) -> bool {
        let lower = line.to_lowercase();

        // 错误/警告关键词按词边界匹配（避免 NOERROR 误命中）
        if self.error_word_re.is_match(&lower) {
            return false;
        }

        // 高价值模式优先保留
        for pat in [
            "started",
            "stopped",
            "updated default interface",
            "match rule",
            "final rule",
            "rule-set",
            "[proxy]",
        ] {
            if lower.contains(pat) {
                return false;
            }
        }

        // 噪音模式
        for pat in [
            "connection upload closed",
            "connection download closed",
            "forcibly closed",
            "connection closed",
            "connection established",
            "tls handshake",
            "handshake completed",
        ] {
            if lower.contains(pat) {
                return true;
            }
        }

        // 内网直连过滤
        if lower.contains("outbound/direct") {
            if lower.contains("outbound packet connection") {
                return true;
            }
            // 私有 IP 模式（简化版正则）
            let private_re = Regex::new(
                r"\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b",
            )
            .unwrap();
            if private_re.is_match(line) {
                return true;
            }
            return false;
        }

        for pat in [
            "dns query",
            "dns response",
            "dns: exchanged",
            "dns: cached",
            "resolved",
            "udp packet",
            "outbound packet connection",
            "inbound/tun[tun-in]",
            "inbound/http[http-in]",
            "inbound/socks[socks-in]",
        ] {
            if lower.contains(pat) {
                return true;
            }
        }

        false
    }

    fn parse_singbox_log(&self, line: &str) -> Option<(LogLevel, String)> {
        let m = self.level_re.find(line)?;
        let level = LogLevel::parse(m.as_str())?;
        // 去掉时间戳和级别
        let ts_re = Regex::new(r"^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}").unwrap();
        let message = ts_re.replace(line, "");
        let message = self.level_re.replace(&message, "");
        let message = message.trim().trim_start_matches(|c| c == '[' || c == ']').trim();
        Some((level, message.to_string()))
    }
}

/// 错误消息翻译为中文友好提示（对应 translateErrorMessage）
fn translate_error_message(message: &str) -> String {
    let lower = message.to_lowercase();

    if lower.contains("dns") && lower.contains("fail") {
        return format!("DNS 解析失败：无法解析服务器域名，请检查 DNS 设置 [{}]", message);
    }
    if lower.contains("connection refused") {
        return format!("连接被拒绝：无法连接到代理服务器，请检查服务器地址和端口是否正确 [{}]", message);
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        // 提取目标地址
        let target = Regex::new(r"(?i)connection.*?to\s+([^\s:]+(?::\d+)?)")
            .ok()
            .and_then(|re| re.captures(message))
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();
        // 私有 IP 超时不显示
        let private_re = Regex::new(r"^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)").unwrap();
        if !target.is_empty() && private_re.is_match(&target) {
            return String::new();
        }
        return if target.is_empty() {
            "连接超时：服务器响应超时".to_string()
        } else {
            format!("连接超时: {}", target)
        };
    }
    if lower.contains("certificate") || lower.contains("x509") || lower.contains("unknown authority") {
        return format!("TLS 证书错误：服务器证书验证失败 [{}]", message);
    }
    if lower.contains("authentication failed") || lower.contains("auth fail") {
        return format!("认证失败：用户名或密码错误，请检查服务器配置 [{}]", message);
    }
    if lower.contains("permission denied") || lower.contains("access denied") {
        return format!("权限不足：需要管理员权限才能启动 TUN 模式 [{}]", message);
    }
    if lower.contains("address already in use") {
        return "端口已被占用：请更换其他端口或关闭占用端口的程序".to_string();
    }
    if lower.contains("invalid config") || lower.contains("config error") {
        return format!("配置错误：sing-box 配置文件格式不正确 [{}]", message);
    }
    message.to_string()
}

/// 共享的日志管理器（Tauri State 用）
pub type SharedLogManager = Arc<Mutex<LogManager>>;

pub fn new_shared() -> SharedLogManager {
    Arc::new(Mutex::new(LogManager::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_caps_at_1000() {
        let mut m = LogManager::new();
        m.set_level(LogLevel::Debug);
        for i in 0..1500 {
            m.add_log(LogLevel::Info, &format!("msg {}", i), "test");
        }
        assert_eq!(m.get_logs(None).len(), 1000);
        assert_eq!(m.get_logs(Some(10)).len(), 10);
        assert!(m.get_logs(None)[0].message.contains("msg 500"));
    }

    #[test]
    fn level_filtering() {
        let mut m = LogManager::new(); // 默认 info
        assert!(m.add_log(LogLevel::Debug, "d", "t").is_none());
        assert!(m.add_log(LogLevel::Info, "i", "t").is_some());
    }

    #[test]
    fn pipeline_filters_noise() {
        let mut p = LogPipeline::new();
        // DNS 查询被过滤
        assert!(p.process_line("2024-01-01 12:00:00 INFO dns query example.com").is_none());
        // 错误保留并翻译
        let r = p.process_line("2024-01-01 12:00:00 ERROR connection refused to 1.2.3.4:443");
        assert!(r.is_some());
        let (level, msg) = r.unwrap();
        assert_eq!(level, LogLevel::Error);
        assert!(msg.contains("连接被拒绝"));
    }

    #[test]
    fn pipeline_simplifies_proxy_tag() {
        let mut p = LogPipeline::new();
        let r = p.process_line(
            "2024-01-01 12:00:00 INFO outbound/proxy[proxy-11111111-2222-3333-4444-555555555555] started",
        );
        assert!(r.is_some());
        assert!(r.unwrap().1.contains("[proxy]"));
    }

    #[test]
    fn duplicate_suppression() {
        let mut p = LogPipeline::new();
        // 同一消息 1 秒内超过 5 次被过滤；用高价值词避免 low_value 过滤
        for _ in 0..5 {
            assert!(p.process_line("2024-01-01 12:00:00 INFO started ok").is_some());
        }
        assert!(p.process_line("2024-01-01 12:00:00 INFO started ok").is_none());
    }
}
