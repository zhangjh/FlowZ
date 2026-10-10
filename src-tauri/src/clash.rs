//! Clash API 客户端（对应 ProxyManager 的 updateClashApi / waitForClashApi /
//! updateModeSelectors / verifySelectors / probeTargetAvailability）。
//!
//! 用于运行时热切换 selector、无需重启 sing-box。

use crate::config::ProxyMode;
use crate::singbox::CLASH_API_PORT;
use serde::Deserialize;
use std::time::Duration;

fn base() -> String {
    format!("http://127.0.0.1:{}", CLASH_API_PORT)
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))
}

/// 等待 Clash API 就绪（进程启动后需要时间初始化）
pub async fn wait_for_api(max_wait: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < max_wait {
        if let Ok(c) = client(Duration::from_secs(1)) {
            if let Ok(resp) = c.get(format!("{}/proxies", base())).send().await {
                if resp.status().is_success() {
                    return true;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    false
}

/// 切换 selector 的选中出站：PUT /proxies/{selector} {"name": target}
pub async fn set_selector(selector: &str, target: &str) -> Result<(), String> {
    let c = client(Duration::from_secs(5))?;
    let resp = c
        .put(format!("{}/proxies/{}", base(), selector))
        .json(&serde_json::json!({ "name": target }))
        .send()
        .await
        .map_err(|e| format!("Clash API 请求失败: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Clash API 返回 {}: {}", status.as_u16(), body));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct SelectorInfo {
    now: Option<String>,
}

/// 查询 selector 当前选中：GET /proxies/{selector} → now 字段
pub async fn get_selector(selector: &str) -> Result<Option<String>, String> {
    let c = client(Duration::from_secs(5))?;
    let resp = c
        .get(format!("{}/proxies/{}", base(), selector))
        .send()
        .await
        .map_err(|e| format!("Clash API 请求失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Clash API 返回 {}", resp.status().as_u16()));
    }
    let info: SelectorInfo = resp
        .json()
        .await
        .map_err(|e| format!("解析 Clash API 响应失败: {}", e))?;
    Ok(info.now)
}

/// 模式 selector 的目标出站（与 singbox.rs 的 mode_selections 一致）
pub fn mode_selections(mode: &ProxyMode) -> (&'static str, &'static str, &'static str) {
    match mode {
        ProxyMode::Global => ("proxy", "proxy", "proxy"),
        ProxyMode::Direct => ("direct", "direct", "direct"),
        ProxyMode::Smart => ("direct", "proxy", "proxy"),
    }
}

/// 更新三个模式 selector
pub async fn update_mode_selectors(mode: &ProxyMode) -> Result<(), String> {
    let (cn, non_cn, fallback) = mode_selections(mode);
    set_selector("mode-cn", cn).await?;
    set_selector("mode-non-cn", non_cn).await?;
    set_selector("mode-fallback", fallback).await?;
    Ok(())
}

/// 验证 selector 切换结果
pub async fn verify_selectors(targets: &[(&str, &str)]) -> Result<(), String> {
    for (selector, expected) in targets {
        let now = get_selector(selector).await?;
        if now.as_deref() != Some(*expected) {
            return Err(format!(
                "selector {} 切换验证失败：期望 {}，实际 {:?}",
                selector, expected, now
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct DelayInfo {
    delay: Option<u64>,
}

/// 探测出站是否真的可用：GET /proxies/{tag}/delay
/// 返回延迟毫秒数；不可达时返回 None
pub async fn probe_delay(tag: &str, timeout_ms: u64) -> Option<u64> {
    let c = client(Duration::from_millis(timeout_ms + 2000)).ok()?;
    let resp = c
        .get(format!("{}/proxies/{}/delay", base(), tag))
        .query(&[
            ("timeout", timeout_ms.to_string()),
            ("url", "http://www.gstatic.com/generate_204".to_string()),
        ])
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let info: DelayInfo = resp.json().await.ok()?;
    info.delay.filter(|&d| d > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_selections_match_ts() {
        assert_eq!(mode_selections(&ProxyMode::Global), ("proxy", "proxy", "proxy"));
        assert_eq!(mode_selections(&ProxyMode::Direct), ("direct", "direct", "direct"));
        assert_eq!(mode_selections(&ProxyMode::Smart), ("direct", "proxy", "proxy"));
    }

    #[test]
    fn base_url_has_port() {
        assert!(base().ends_with(":9091"));
    }
}
