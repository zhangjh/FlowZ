//! 服务器真实测速（对应 SpeedTester）。
//!
//! 与移动端一致的方案：启动一个临时 sing-box，挂 N 个 loopback mixed 入站
//! （每节点独立端口 + 独立出站，按 inbound 路由），并行对每个节点真实拨号：
//!   1. 建连延迟（首个成功请求，含 QUIC/TCP/TLS 握手）
//!   2. 会话延迟（同一目标多次采样取最小值，最接近稳态 RTT）
//! 探测目标统一用 http:// 的 generate_204（与 Clash url-test 同口径）。
//! 不做带宽测试（并行下载测的是"份额"而非真实带宽，会误导用户）。

use crate::config::ServerConfig;
use crate::singbox::{
    self, SingBoxConfig, SingBoxDnsConfig, SingBoxDnsServer, SingBoxInbound, SingBoxLogConfig,
    SingBoxOutbound, SingBoxRouteConfig, SingBoxRouteRule,
};
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::process::Command;

const NODE_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const SINGBOX_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const SESSION_SAMPLES: usize = 3;
const CONCURRENCY: usize = 4;

const PROBE_URLS: &[&str] = &[
    "http://www.gstatic.com/generate_204",
    "http://cp.cloudflare.com/generate_204",
    "http://www.google.com/generate_204",
];

#[derive(Debug, Clone, Serialize)]
pub struct SpeedTestResult {
    pub server_id: String,
    /// 会话延迟（稳态 RTT 采样最小值），不可达为 None
    pub latency: Option<u64>,
    /// 建连延迟（首个成功请求）
    pub dial_latency: Option<u64>,
    pub error: Option<String>,
}

fn is_ip_address(value: &str) -> bool {
    if value.parse::<std::net::Ipv4Addr>().is_ok() {
        return true;
    }
    value.contains(':')
}

/// 构建临时测速配置（对应 buildTestConfig）
pub fn build_test_config(servers: &[ServerConfig], ports: &[u16]) -> SingBoxConfig {
    let mut inbounds = Vec::new();
    let mut outbounds = Vec::new();
    let mut route_rules = Vec::new();
    let mut server_domains: Vec<String> = Vec::new();
    let mut server_ips: Vec<String> = Vec::new();

    for (i, server) in servers.iter().enumerate() {
        let outbound_tag = format!("proxy-{}", i);
        let inbound_tag = format!("speed-in-{}", i);
        inbounds.push(SingBoxInbound {
            inbound_type: "mixed".to_string(),
            tag: inbound_tag.clone(),
            listen: Some("127.0.0.1".to_string()),
            listen_port: Some(ports[i] as u32),
            ..Default::default()
        });
        outbounds.push(singbox::generate_proxy_outbound(server, &outbound_tag));
        route_rules.push(SingBoxRouteRule {
            inbound: Some(vec![inbound_tag]),
            action: "route".to_string(),
            outbound: Some(outbound_tag),
            ..Default::default()
        });

        if is_ip_address(&server.address) {
            let cidr = if server.address.contains(':') {
                format!("{}/128", server.address)
            } else {
                format!("{}/32", server.address)
            };
            if !server_ips.contains(&cidr) {
                server_ips.push(cidr);
            }
        } else if !server_domains.contains(&server.address) {
            server_domains.push(server.address.clone());
        }
    }

    outbounds.push(SingBoxOutbound {
        outbound_type: "direct".to_string(),
        tag: "direct".to_string(),
        ..Default::default()
    });

    // 服务器自身地址直连（避免代理套娃）
    if !server_domains.is_empty() {
        route_rules.insert(
            0,
            SingBoxRouteRule {
                domain: Some(server_domains.clone()),
                action: "route".to_string(),
                outbound: Some("direct".to_string()),
                ..Default::default()
            },
        );
    }
    if !server_ips.is_empty() {
        route_rules.insert(
            0,
            SingBoxRouteRule {
                ip_cidr: Some(server_ips.clone()),
                action: "route".to_string(),
                outbound: Some("direct".to_string()),
                ..Default::default()
            },
        );
    }

    SingBoxConfig {
        log: SingBoxLogConfig {
            level: "warn".to_string(),
            timestamp: false,
            output: None,
        },
        dns: Some(SingBoxDnsConfig {
            servers: vec![SingBoxDnsServer {
                tag: "dns-local".to_string(),
                server_type: "local".to_string(),
                server: None,
                detour: None,
                inet4_range: None,
                inet6_range: None,
            }],
            rules: None,
            final_: Some("dns-local".to_string()),
        }),
        inbounds,
        outbounds,
        route: Some(SingBoxRouteConfig {
            rule_set: None,
            rules: route_rules,
            default_domain_resolver: Some("dns-local".to_string()),
            auto_detect_interface: Some(true),
            final_: Some("direct".to_string()),
        }),
        experimental: None,
    }
}

/// 对单个节点测速：首个成功请求为建连延迟，再采样 SESSION_SAMPLES 次取最小为会话延迟
async fn test_one(port: u16, server_id: &str) -> SpeedTestResult {
    let proxy_url = format!("http://127.0.0.1:{}", port);
    let client = match reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(&proxy_url).unwrap())
        .proxy(reqwest::Proxy::https(&proxy_url).unwrap())
        .timeout(REQUEST_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return SpeedTestResult {
                server_id: server_id.to_string(),
                latency: None,
                dial_latency: None,
                error: Some(format!("创建客户端失败: {}", e)),
            }
        }
    };

    let deadline = Instant::now() + NODE_TIMEOUT;
    let mut dial_latency: Option<u64> = None;
    let mut samples: Vec<u64> = Vec::new();

    // 轮流尝试探测目标，直到拿到首个成功（建连延迟）
    'outer: for _ in 0..PROBE_URLS.len() * 2 {
        if Instant::now() > deadline {
            break;
        }
        for url in PROBE_URLS {
            let start = Instant::now();
            match client.get(*url).send().await {
                Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 204 => {
                    dial_latency = Some(start.elapsed().as_millis() as u64);
                    break 'outer;
                }
                _ => {}
            }
            if Instant::now() > deadline {
                break 'outer;
            }
        }
    }

    let dial = match dial_latency {
        Some(d) => d,
        None => {
            return SpeedTestResult {
                server_id: server_id.to_string(),
                latency: None,
                dial_latency: None,
                error: Some("节点不可达".to_string()),
            }
        }
    };

    // 会话延迟采样
    for _ in 0..SESSION_SAMPLES {
        if Instant::now() > deadline {
            break;
        }
        for url in PROBE_URLS {
            let start = Instant::now();
            if let Ok(resp) = client.get(*url).send().await {
                if resp.status().is_success() || resp.status().as_u16() == 204 {
                    samples.push(start.elapsed().as_millis() as u64);
                    break;
                }
            }
        }
    }

    SpeedTestResult {
        server_id: server_id.to_string(),
        latency: samples.into_iter().min(),
        dial_latency: Some(dial),
        error: None,
    }
}

fn find_free_port(start: u16) -> u16 {
    for port in start..start + 1000 {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    start
}

/// 并行测速（对应 testMultipleServers）
pub async fn test_multiple_servers(
    servers: &[ServerConfig],
    singbox_path: &Path,
    work_dir: &Path,
) -> Vec<SpeedTestResult> {
    if servers.is_empty() {
        return Vec::new();
    }

    // 分配端口
    let mut ports = Vec::with_capacity(servers.len());
    let mut next = 16500u16;
    for _ in servers {
        let p = find_free_port(next);
        ports.push(p);
        next = p + 1;
    }

    // 写临时配置并启动 sing-box
    let config = build_test_config(servers, &ports);
    let config_path = work_dir.join("speedtest_config.json");
    let content = match serde_json::to_string_pretty(&config) {
        Ok(c) => c,
        Err(e) => {
            return servers
                .iter()
                .map(|s| SpeedTestResult {
                    server_id: s.id.clone(),
                    latency: None,
                    dial_latency: None,
                    error: Some(format!("序列化测速配置失败: {}", e)),
                })
                .collect();
        }
    };
    if std::fs::write(&config_path, content).is_err() {
        return Vec::new();
    }

    let mut child = match Command::new(singbox_path)
        .arg("run")
        .arg("-c")
        .arg(&config_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return servers
                .iter()
                .map(|s| SpeedTestResult {
                    server_id: s.id.clone(),
                    latency: None,
                    dial_latency: None,
                    error: Some(format!("启动测速 sing-box 失败: {}", e)),
                })
                .collect();
        }
    };

    // 等待入站就绪（轮询第一个端口）
    let ready = async {
        let start = Instant::now();
        while start.elapsed() < SINGBOX_STARTUP_TIMEOUT {
            if tokio::net::TcpStream::connect(("127.0.0.1", ports[0]))
                .await
                .is_ok()
            {
                return true;
            }
            // 进程已退出则直接失败
            if child.try_wait().ok().flatten().is_some() {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        false
    }
    .await;

    let mut results = Vec::new();
    if ready {
        // 并发度 4 分批
        let pairs: Vec<(&ServerConfig, u16)> =
            servers.iter().zip(ports.iter().copied()).collect();
        for chunk in pairs.chunks(CONCURRENCY) {
            let mut set = tokio::task::JoinSet::new();
            for (s, p) in chunk {
                let sid = s.id.clone();
                let port = *p;
                set.spawn(async move { test_one(port, &sid).await });
            }
            while let Some(r) = set.join_next().await {
                if let Ok(res) = r {
                    results.push(res);
                }
            }
        }
    } else {
        for s in servers {
            results.push(SpeedTestResult {
                server_id: s.id.clone(),
                latency: None,
                dial_latency: None,
                error: Some("测速 sing-box 未能在 20s 内就绪".to_string()),
            });
        }
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
    results
}

/// 单节点延迟测试（对应 testLatency，供故障转移快速检测用）
pub async fn test_latency(
    server: &ServerConfig,
    singbox_path: &Path,
    work_dir: &Path,
    timeout: Duration,
) -> Option<u64> {
    let results = tokio::time::timeout(
        timeout,
        test_multiple_servers(std::slice::from_ref(server), singbox_path, work_dir),
    )
    .await
    .ok()?;
    results.into_iter().next()?.latency
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Protocol;

    fn dummy_server(id: &str) -> ServerConfig {
        ServerConfig {
            id: id.to_string(),
            name: id.to_string(),
            protocol: Protocol::Vless,
            address: "example.com".to_string(),
            port: 443,
            uuid: Some("11111111-2222-3333-4444-555555555555".to_string()),
            encryption: None,
            flow: None,
            password: None,
            hysteria2_settings: None,
            network: None,
            security: None,
            tls_settings: None,
            reality_settings: None,
            ws_settings: None,
            grpc_settings: None,
            http_settings: None,
            group_id: None,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn test_config_structure() {
        let servers = vec![dummy_server("a"), dummy_server("b")];
        let cfg = build_test_config(&servers, &[16500, 16501]);
        assert_eq!(cfg.inbounds.len(), 2);
        assert_eq!(cfg.inbounds[0].tag, "speed-in-0");
        assert_eq!(cfg.outbounds.len(), 3); // 2 proxy + direct
        // 服务器域名直连规则在最前
        assert_eq!(cfg.route.as_ref().unwrap().rules[0].outbound.as_deref(), Some("direct"));
        // 每节点 inbound→outbound 路由
        let r = &cfg.route.as_ref().unwrap().rules;
        assert!(r.iter().any(|rule| rule.inbound == Some(vec!["speed-in-1".to_string()])));
    }

    #[test]
    fn config_passes_singbox_check() {
        // 用仓库自带的 sing-box 二进制做真实校验；没有二进制时跳过
        let candidates = [
            "../resources/linux-x64/sing-box",
            "resources/linux-x64/sing-box",
        ];
        let bin = candidates.iter().find(|p| std::path::Path::new(p).exists());
        let bin = match bin {
            Some(b) => b,
            None => {
                eprintln!("skip: sing-box binary not found");
                return;
            }
        };
        let servers = vec![dummy_server("a")];
        let cfg = build_test_config(&servers, &[16500]);
        let path = std::env::temp_dir().join("flowz_speedtest_check.json");
        std::fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
        let out = std::process::Command::new(bin)
            .arg("check")
            .arg("-c")
            .arg(&path)
            .output()
            .expect("run sing-box check");
        assert!(
            out.status.success(),
            "sing-box check failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn config_serializes_for_singbox() {
        let servers = vec![dummy_server("a")];
        let cfg = build_test_config(&servers, &[16500]);
        let json = serde_json::to_value(&cfg).unwrap();
        // route.rules[].inbound 必须序列化
        assert_eq!(json["route"]["rules"][1]["inbound"][0], "speed-in-0");
        assert_eq!(json["log"]["level"], "warn");
    }
}
