//! sing-box 配置生成器（对应 ProxyManager 的 generate*Config 系列方法）。
//!
//! 生成 sing-box 1.14.x 格式配置。纯逻辑，可单测。

use crate::config::{
    Network, Protocol, ProxyMode, Security, ServerConfig, UserConfig,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::PathBuf;
use std::str::FromStr;

pub const CLASH_API_PORT: u16 = 9091;

const PRIVATE_IP_CIDRS: &[&str] = &[
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8",
];

// ---------------------------------------------------------------------------
// sing-box JSON 结构（snake_case，与 sing-box 配置键一致）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingBoxLogConfig {
    pub level: String,
    pub timestamp: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingBoxDnsServer {
    pub tag: String,
    #[serde(rename = "type")]
    pub server_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detour: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inet4_range: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inet6_range: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SingBoxDnsRule {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_set: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_type: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_suffix: Option<Vec<String>>,
    pub server: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingBoxDnsConfig {
    pub servers: Vec<SingBoxDnsServer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<SingBoxDnsRule>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "final")]
    pub final_: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SingBoxInbound {
    #[serde(rename = "type")]
    pub inbound_type: String,
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen_port: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtu: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_route: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strict_route: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dns_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route_exclude_address: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SingBoxTlsConfig {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insecure: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpn: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub utls: Option<SingBoxUtlsConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reality: Option<SingBoxRealityConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingBoxUtlsConfig {
    pub enabled: bool,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingBoxRealityConfig {
    pub enabled: bool,
    pub public_key: String,
    pub short_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SingBoxObfsConfig {
    #[serde(rename = "type")]
    pub obfs_type: String,
    pub password: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_packet_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_packet_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SingBoxTransportConfig {
    #[serde(rename = "type")]
    pub transport_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SingBoxOutbound {
    #[serde(rename = "type")]
    pub outbound_type: String,
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_port: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outbounds: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tolerance: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupt_exist_connections: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet_encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub up_mbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub down_mbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub obfs: Option<SingBoxObfsConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_ports: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_interval: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_interval_max: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbr_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_chrome_parrot: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tls: Option<SingBoxTlsConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<SingBoxTransportConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_resolver: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SingBoxRouteRule {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inbound: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_set: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_suffix: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_keyword: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_regex: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_cidr: Option<Vec<String>>,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outbound: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingBoxRuleSet {
    pub tag: String,
    #[serde(rename = "type")]
    pub rule_set_type: String,
    pub format: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SingBoxRouteConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_set: Option<Vec<SingBoxRuleSet>>,
    pub rules: Vec<SingBoxRouteRule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_domain_resolver: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_detect_interface: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "final")]
    pub final_: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SingBoxExperimental {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_file: Option<SingBoxCacheFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clash_api: Option<SingBoxClashApi>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingBoxCacheFile {
    pub enabled: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingBoxClashApi {
    pub external_controller: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingBoxConfig {
    pub log: SingBoxLogConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dns: Option<SingBoxDnsConfig>,
    pub inbounds: Vec<SingBoxInbound>,
    pub outbounds: Vec<SingBoxOutbound>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<SingBoxRouteConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experimental: Option<SingBoxExperimental>,
}

// ---------------------------------------------------------------------------
// 生成上下文（平台相关路径）
// ---------------------------------------------------------------------------

pub struct GenContext {
    /// 用户数据目录（cache.db、singbox 日志）
    pub user_data_dir: PathBuf,
    /// .srs 规则数据目录
    pub data_dir: PathBuf,
}

fn is_tun_mode(proxy_mode_type: &str) -> bool {
    proxy_mode_type.to_lowercase() != "systemproxy"
}

/// 0=不是IP，4=IPv4，6=IPv6（对应 net.isIP）
fn ip_version(addr: &str) -> u8 {
    match IpAddr::from_str(addr) {
        Ok(IpAddr::V4(_)) => 4,
        Ok(IpAddr::V6(_)) => 6,
        Err(_) => 0,
    }
}

fn is_loopback_ip(ip: &str) -> bool {
    ip.starts_with("127.") || ip == "::1"
}

fn is_docker_bridge_ip(ip: &str) -> bool {
    if ip.contains(':') {
        return false;
    }
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    matches!(
        (parts[0].parse::<u8>(), parts[1].parse::<u8>()),
        (Ok(172), Ok(b)) if (16..=31).contains(&b)
    )
}

fn parse_resolv_conf(path: &str) -> Vec<String> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    content
        .lines()
        .filter_map(|line| {
            let t = line.trim();
            t.strip_prefix("nameserver ")
                .map(|ip| ip.trim().to_string())
                .filter(|ip| !ip.is_empty())
        })
        .collect()
}

/// 系统上游 DNS（对应 getSystemDnsServers 的 Linux 分支；其他平台返回空走 type:'local'）
pub fn get_system_dns_servers() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        let usable = |ip: &str| !is_loopback_ip(ip) && !is_docker_bridge_ip(ip);
        for path in ["/etc/resolv.conf", "/run/systemd/resolve/resolv.conf"] {
            let filtered: Vec<String> = parse_resolv_conf(path)
                .into_iter()
                .filter(|ip| usable(ip))
                .collect();
            if !filtered.is_empty() {
                return filtered;
            }
        }
        vec![]
    }
    #[cfg(not(target_os = "linux"))]
    {
        vec![]
    }
}

fn server_outbound_tag(server_id: &str) -> String {
    format!("proxy-{}", server_id)
}

/// 运行时 proxy selector 的目标 tag（对应 getProxyTargetTag）
pub fn get_proxy_target_tag(config: &UserConfig) -> String {
    let is_group = config.selected_group_id.is_some() && !get_active_servers(config).is_empty();
    if is_group {
        return format!("group-{}", config.selected_group_id.as_deref().unwrap_or(""));
    }
    match &config.selected_server_id {
        Some(id) => server_outbound_tag(id),
        None => "direct".to_string(),
    }
}

fn get_active_servers<'a>(config: &'a UserConfig) -> Vec<&'a ServerConfig> {
    if let Some(ref gid) = config.selected_group_id {
        if let Some(group) = config.server_groups.iter().find(|g| &g.id == gid) {
            if !group.server_ids.is_empty() {
                let members: Vec<&ServerConfig> = config
                    .servers
                    .iter()
                    .filter(|s| group.server_ids.contains(&s.id))
                    .collect();
                if !members.is_empty() {
                    return members;
                }
            }
        }
    }
    if let Some(ref sid) = config.selected_server_id {
        if let Some(s) = config.servers.iter().find(|s| &s.id == sid) {
            return vec![s];
        }
    }
    vec![]
}

fn mode_selections(mode: &ProxyMode) -> (&'static str, &'static str, &'static str) {
    match mode {
        ProxyMode::Global => ("proxy", "proxy", "proxy"),
        ProxyMode::Direct => ("direct", "direct", "direct"),
        // 智能模式：国内直连、境外代理、兜底代理（与 TS 注释一致）
        ProxyMode::Smart => ("direct", "proxy", "proxy"),
    }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

pub fn generate_singbox_config(
    config: &UserConfig,
    ctx: &GenContext,
) -> Result<SingBoxConfig, String> {
    let active = get_active_servers(config);
    if active.is_empty() {
        return Err("未选择服务器或分组".to_string());
    }
    let is_group = config.selected_group_id.as_ref().map(|gid| {
        config
            .server_groups
            .iter()
            .any(|g| &g.id == gid && !g.server_ids.is_empty())
    }).unwrap_or(false);

    Ok(SingBoxConfig {
        log: generate_log_config(config, ctx),
        dns: Some(generate_dns_config(config)),
        inbounds: generate_inbounds(config),
        outbounds: generate_outbounds(config, &active, is_group),
        route: Some(generate_route_config(config, ctx)),
        experimental: Some(SingBoxExperimental {
            cache_file: Some(SingBoxCacheFile {
                enabled: true,
                path: ctx.user_data_dir.join("cache.db").to_string_lossy().into_owned(),
            }),
            clash_api: Some(SingBoxClashApi {
                external_controller: format!("127.0.0.1:{}", CLASH_API_PORT),
                secret: None,
            }),
        }),
    })
}

fn generate_log_config(config: &UserConfig, ctx: &GenContext) -> SingBoxLogConfig {
    // TS 默认 debug（应用层过滤低价值日志）
    let mut out = SingBoxLogConfig {
        level: "debug".to_string(),
        timestamp: true,
        output: None,
    };
    // TUN 模式下提权运行抓不到 stdout，输出到文件
    if is_tun_mode(&config.proxy_mode_type.to_string()) {
        out.output = Some(
            ctx.user_data_dir
                .join("singbox.log")
                .to_string_lossy()
                .into_owned(),
        );
    }
    out
}

fn generate_dns_config(config: &UserConfig) -> SingBoxDnsConfig {
    let tun = is_tun_mode(&config.proxy_mode_type.to_string());
    let system_dns = get_system_dns_servers();

    let mut servers = Vec::new();
    if tun && !system_dns.is_empty() {
        // TUN 模式必须用 type:'udp' + 显式上游，避免 DNS 死循环（见 TS 注释）
        servers.push(SingBoxDnsServer {
            tag: "dns-local".to_string(),
            server_type: "udp".to_string(),
            server: Some(system_dns[0].clone()),
            detour: None,
            inet4_range: None,
            inet6_range: None,
        });
    } else {
        servers.push(SingBoxDnsServer {
            tag: "dns-local".to_string(),
            server_type: "local".to_string(),
            server: None,
            detour: None,
            inet4_range: None,
            inet6_range: None,
        });
    }
    servers.push(SingBoxDnsServer {
        tag: "fakeip".to_string(),
        server_type: "fakeip".to_string(),
        server: None,
        detour: None,
        inet4_range: Some("198.18.0.0/15".to_string()),
        inet6_range: Some("fc00::/18".to_string()),
    });

    let mut rules = Vec::new();

    // 代理服务器域名走本地 DNS（避免死循环）；用全部节点（热切换兼容）
    let mut proxy_domains: HashSet<String> = HashSet::new();
    for s in &config.servers {
        if !s.address.is_empty() && ip_version(&s.address) == 0 {
            proxy_domains.insert(s.address.clone());
        }
    }
    if !proxy_domains.is_empty() {
        let mut domains: Vec<String> = proxy_domains.into_iter().collect();
        domains.sort();
        rules.push(SingBoxDnsRule {
            domain: Some(domains),
            server: "dns-local".to_string(),
            ..Default::default()
        });
    }

    // bypassFakeIP 域名走本地真实解析
    let mut bypass: Vec<String> = Vec::new();
    for rule in &config.custom_rules {
        if !rule.enabled {
            continue;
        }
        let has_flag = rule.bypass_fake_ip == Some(true);
        if !has_flag || rule.domains.is_empty() {
            continue;
        }
        for d in &rule.domains {
            bypass.push(d.strip_prefix("*.").unwrap_or(d).to_string());
        }
    }
    if !bypass.is_empty() {
        rules.push(SingBoxDnsRule {
            domain_suffix: Some(bypass),
            server: "dns-local".to_string(),
            ..Default::default()
        });
    }

    // 普通 A/AAAA 查询走 FakeIP
    rules.push(SingBoxDnsRule {
        query_type: Some(vec!["A".to_string(), "AAAA".to_string()]),
        server: "fakeip".to_string(),
        ..Default::default()
    });

    SingBoxDnsConfig {
        servers,
        rules: Some(rules),
        final_: Some("dns-local".to_string()),
    }
}

fn generate_inbounds(config: &UserConfig) -> Vec<SingBoxInbound> {
    let mut inbounds = vec![
        SingBoxInbound {
            inbound_type: "http".to_string(),
            tag: "http-in".to_string(),
            listen: Some("127.0.0.1".to_string()),
            listen_port: Some(config.http_port),
            interface_name: None,
            address: None,
            mtu: None,
            auto_route: None,
            strict_route: None,
            stack: None,
            dns_mode: None,
            route_exclude_address: None,
        },
        SingBoxInbound {
            inbound_type: "socks".to_string(),
            tag: "socks-in".to_string(),
            listen: Some("127.0.0.1".to_string()),
            listen_port: Some(config.socks_port),
            interface_name: None,
            address: None,
            mtu: None,
            auto_route: None,
            strict_route: None,
            stack: None,
            dns_mode: None,
            route_exclude_address: None,
        },
    ];

    if is_tun_mode(&config.proxy_mode_type.to_string()) {
        let tun = &config.tun_config;
        let mut exclude = vec!["127.0.0.0/8".to_string(), "::1/128".to_string()];
        for ip in get_system_dns_servers() {
            exclude.push(if ip.contains(':') {
                format!("{}/128", ip)
            } else {
                format!("{}/32", ip)
            });
        }
        // 平台差异与 TS 一致：win/mac 用 gvisor，mac 不用 strict_route
        #[cfg(target_os = "macos")]
        let (stack, strict_route) = ("gvisor".to_string(), false);
        #[cfg(target_os = "windows")]
        let (stack, strict_route) = ("gvisor".to_string(), tun.strict_route);
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let (stack, strict_route) = (tun.stack.to_string(), tun.strict_route);

        inbounds.push(SingBoxInbound {
            inbound_type: "tun".to_string(),
            tag: "tun-in".to_string(),
            listen: None,
            listen_port: None,
            interface_name: tun.interface_name.clone(),
            address: Some(vec![
                tun.inet4_address.clone().unwrap_or_else(|| "172.19.0.1/30".to_string()),
                tun.inet6_address.clone().unwrap_or_else(|| "fdfe:dcba:9876::1/126".to_string()),
            ]),
            mtu: Some(if tun.mtu == 0 { 1400 } else { tun.mtu }),
            auto_route: Some(tun.auto_route),
            strict_route: Some(strict_route),
            stack: Some(stack),
            dns_mode: Some("hijack".to_string()),
            route_exclude_address: Some(exclude),
        });
    }

    inbounds
}

fn generate_outbounds(
    config: &UserConfig,
    active: &[&ServerConfig],
    is_group: bool,
) -> Vec<SingBoxOutbound> {
    // 保留全部节点的出站（Clash API 热切换）
    let server_outbounds: Vec<SingBoxOutbound> = config
        .servers
        .iter()
        .map(|s| generate_proxy_outbound(s, &server_outbound_tag(&s.id)))
        .collect();
    let server_tags: Vec<String> = server_outbounds.iter().map(|o| o.tag.clone()).collect();
    let member_tags: Vec<String> = active
        .iter()
        .map(|s| server_outbound_tag(&s.id))
        .collect();

    let mut group_tags: Vec<String> = Vec::new();
    let mut all_outbounds = server_outbounds;
    let mut proxy_default = if let Some(ref sid) = config.selected_server_id {
        server_outbound_tag(sid)
    } else {
        member_tags.first().cloned().unwrap_or_else(|| "direct".to_string())
    };

    if is_group && !active.is_empty() {
        if let Some(ref gid) = config.selected_group_id {
            let group_tag = format!("group-{}", gid);
            group_tags.push(group_tag.clone());
            all_outbounds.push(SingBoxOutbound {
                outbound_type: "urltest".to_string(),
                tag: group_tag.clone(),
                outbounds: Some(member_tags),
                url: Some("http://www.gstatic.com/generate_204".to_string()),
                interval: Some("10m".to_string()),
                tolerance: Some(50),
                interrupt_exist_connections: Some(true),
                ..Default::default()
            });
            proxy_default = group_tag;
        }
    }

    let (cn, non_cn, fallback) = mode_selections(&config.proxy_mode);
    let mut outbounds = vec![
        generate_selector_outbound("mode-cn", cn),
        generate_selector_outbound("mode-non-cn", non_cn),
        generate_selector_outbound("mode-fallback", fallback),
        SingBoxOutbound {
            outbound_type: "selector".to_string(),
            tag: "proxy".to_string(),
            outbounds: Some(
                group_tags
                    .iter()
                    .chain(server_tags.iter())
                    .cloned()
                    .collect(),
            ),
            default: Some(proxy_default),
            interrupt_exist_connections: Some(true),
            ..Default::default()
        },
    ];
    outbounds.extend(all_outbounds);
    outbounds.push(SingBoxOutbound {
        outbound_type: "direct".to_string(),
        tag: "direct".to_string(),
        ..Default::default()
    });
    outbounds
}

fn generate_selector_outbound(tag: &str, selected: &str) -> SingBoxOutbound {
    SingBoxOutbound {
        outbound_type: "selector".to_string(),
        tag: tag.to_string(),
        outbounds: Some(vec!["direct".to_string(), "proxy".to_string()]),
        default: Some(selected.to_string()),
        interrupt_exist_connections: Some(true),
        ..Default::default()
    }
}

pub fn generate_proxy_outbound(server: &ServerConfig, tag: &str) -> SingBoxOutbound {
    let mut o = SingBoxOutbound {
        outbound_type: server.protocol.to_string(),
        tag: tag.to_string(),
        server: Some(server.address.clone()),
        server_port: Some(server.port),
        domain_resolver: Some("dns-local".to_string()),
        ..Default::default()
    };

    match server.protocol {
        Protocol::Vless => {
            o.uuid = server.uuid.clone();
            o.flow = server.flow.clone();
            o.packet_encoding = Some("xudp".to_string());
        }
        Protocol::Trojan => {
            o.password = server.password.clone();
        }
        Protocol::Hysteria2 => {
            o.password = server.password.clone();
            if let Some(hy2) = &server.hysteria2_settings {
                o.up_mbps = hy2.up_mbps;
                o.down_mbps = hy2.down_mbps;
                if let Some(obfs) = &hy2.obfs {
                    if let (Some(t), Some(pw)) = (obfs.obfs_type.clone(), obfs.password.clone()) {
                        let mut oc = SingBoxObfsConfig {
                            obfs_type: t.clone(),
                            password: pw,
                            ..Default::default()
                        };
                        if t == "gecko" {
                            oc.min_packet_size = obfs.min_packet_size;
                            oc.max_packet_size = obfs.max_packet_size;
                        }
                        o.obfs = Some(oc);
                    }
                }
                o.network = hy2.network.map(|n| n.to_string());
                if let Some(ports) = &hy2.server_ports {
                    if !ports.is_empty() {
                        o.server_ports = Some(ports.clone());
                        o.server_port = None; // 与 server_port 互斥
                        o.hop_interval = hy2.hop_interval.clone();
                        o.hop_interval_max = hy2.hop_interval_max.clone();
                    }
                }
                o.bbr_profile = hy2.bbr_profile.map(|b| b.to_string());
                if hy2.disable_chrome_parrot == Some(true) {
                    o.disable_chrome_parrot = Some(true);
                }
            }
        }
    }

    // TLS 配置（TS 条件：security === 'tls' || tlsSettings 存在）
    let want_tls = server.security == Some(Security::Tls) || server.tls_settings.is_some();
    if want_tls {
        let tls = server.tls_settings.as_ref();
        let mut tc = SingBoxTlsConfig {
            enabled: true,
            server_name: Some(
                tls.and_then(|t| t.server_name.clone())
                    .unwrap_or_else(|| server.address.clone()),
            ),
            insecure: Some(tls.and_then(|t| t.allow_insecure).unwrap_or(false)),
            alpn: tls.and_then(|t| t.alpn.clone()),
            utls: None,
            reality: None,
        };
        if server.protocol != Protocol::Hysteria2 {
            tc.utls = Some(SingBoxUtlsConfig {
                enabled: true,
                fingerprint: tls
                    .and_then(|t| t.fingerprint.clone())
                    .unwrap_or_else(|| "chrome".to_string()),
            });
        }
        o.tls = Some(tc);
    }

    // Reality 配置（会覆盖上面的 tls）
    if server.security == Some(Security::Reality) {
        if let Some(r) = &server.reality_settings {
            let tls = server.tls_settings.as_ref();
            o.tls = Some(SingBoxTlsConfig {
                enabled: true,
                server_name: Some(
                    tls.and_then(|t| t.server_name.clone())
                        .unwrap_or_else(|| server.address.clone()),
                ),
                insecure: None,
                alpn: None,
                utls: Some(SingBoxUtlsConfig {
                    enabled: true,
                    fingerprint: tls
                        .and_then(|t| t.fingerprint.clone())
                        .unwrap_or_else(|| "chrome".to_string()),
                }),
                reality: Some(SingBoxRealityConfig {
                    enabled: true,
                    public_key: r.public_key.clone(),
                    short_id: r.short_id.clone().unwrap_or_default(),
                }),
            });
        }
    }

    // 传输层（hysteria2 除外，非 tcp 才需要）
    if server.protocol != Protocol::Hysteria2 {
        if let Some(net) = &server.network {
            if *net != Network::Tcp {
                o.transport = generate_transport_config(server);
            }
        }
    }

    o
}

fn generate_transport_config(server: &ServerConfig) -> Option<SingBoxTransportConfig> {
    match server.network {
        Some(Network::Ws) => {
            if let Some(ws) = &server.ws_settings {
                return Some(SingBoxTransportConfig {
                    transport_type: "ws".to_string(),
                    path: Some(ws.path.clone().unwrap_or_else(|| "/".to_string())),
                    headers: ws.headers.clone(),
                    service_name: None,
                });
            }
            None
        }
        Some(Network::Grpc) => {
            if let Some(g) = &server.grpc_settings {
                return Some(SingBoxTransportConfig {
                    transport_type: "grpc".to_string(),
                    path: None,
                    headers: None,
                    service_name: Some(g.service_name.clone().unwrap_or_default()),
                });
            }
            None
        }
        _ => None,
    }
}

fn generate_route_config(config: &UserConfig, ctx: &GenContext) -> SingBoxRouteConfig {
    let mut rules: Vec<SingBoxRouteRule> = Vec::new();

    // 协议嗅探必须最前
    rules.push(SingBoxRouteRule {
        action: "sniff".to_string(),
        ..Default::default()
    });
    // DNS 劫持
    rules.push(SingBoxRouteRule {
        protocol: Some("dns".to_string()),
        action: "hijack-dns".to_string(),
        ..Default::default()
    });

    // 代理服务器自身直连（防死循环），域名与 IP 分开
    let active = get_active_servers(config);
    let mut cidrs: HashSet<String> = HashSet::new();
    let mut domains: HashSet<String> = HashSet::new();
    for s in &active {
        if s.address.is_empty() {
            continue;
        }
        match ip_version(&s.address) {
            6 => {
                cidrs.insert(format!("{}/128", s.address));
            }
            4 => {
                cidrs.insert(format!("{}/32", s.address));
            }
            _ => {
                domains.insert(s.address.clone());
            }
        }
    }
    if !cidrs.is_empty() {
        let mut v: Vec<String> = cidrs.into_iter().collect();
        v.sort();
        rules.push(SingBoxRouteRule {
            ip_cidr: Some(v),
            action: "route".to_string(),
            outbound: Some("direct".to_string()),
            ..Default::default()
        });
    }
    if !domains.is_empty() {
        let mut v: Vec<String> = domains.into_iter().collect();
        v.sort();
        rules.push(SingBoxRouteRule {
            domain: Some(v),
            action: "route".to_string(),
            outbound: Some("direct".to_string()),
            ..Default::default()
        });
    }

    // 自定义规则（domain_suffix 统一后缀匹配）
    for rule in &config.custom_rules {
        if !rule.enabled || rule.domains.is_empty() {
            continue;
        }
        let mut ds: Vec<String> = rule
            .domains
            .iter()
            .map(|d| d.strip_prefix("*.").unwrap_or(d).to_string())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        ds.sort();
        let mut r = SingBoxRouteRule {
            action: "route".to_string(),
            domain_suffix: Some(ds),
            ..Default::default()
        };
        match rule.action {
            crate::config::RuleAction::Proxy => r.outbound = Some("proxy".to_string()),
            crate::config::RuleAction::Direct => r.outbound = Some("direct".to_string()),
            // sing-box 1.11 起 block 出站废弃，用 reject 动作
            crate::config::RuleAction::Block => r.action = "reject".to_string(),
        }
        rules.push(r);
    }

    // 私有 IP 直连
    rules.push(SingBoxRouteRule {
        ip_cidr: Some(PRIVATE_IP_CIDRS.iter().map(|s| s.to_string()).collect()),
        action: "route".to_string(),
        outbound: Some("direct".to_string()),
        ..Default::default()
    });

    // 上游 DNS IP 直连（防 TUN 死循环）
    let mut dns_cidrs: HashSet<String> = HashSet::new();
    for ip in get_system_dns_servers() {
        dns_cidrs.insert(if ip.contains(':') {
            format!("{}/128", ip)
        } else {
            format!("{}/32", ip)
        });
    }
    if !dns_cidrs.is_empty() {
        let mut v: Vec<String> = dns_cidrs.into_iter().collect();
        v.sort();
        rules.push(SingBoxRouteRule {
            ip_cidr: Some(v),
            action: "route".to_string(),
            outbound: Some("direct".to_string()),
            ..Default::default()
        });
    }

    // 智能分流（顺序与 TS 一致：geosite-cn → geosite-!cn → geoip-cn → fallback）
    rules.push(SingBoxRouteRule {
        rule_set: Some("geosite-cn".to_string()),
        action: "route".to_string(),
        outbound: Some("mode-cn".to_string()),
        ..Default::default()
    });
    rules.push(SingBoxRouteRule {
        rule_set: Some("geosite-geolocation-!cn".to_string()),
        action: "route".to_string(),
        outbound: Some("mode-non-cn".to_string()),
        ..Default::default()
    });
    rules.push(SingBoxRouteRule {
        rule_set: Some("geoip-cn".to_string()),
        action: "route".to_string(),
        outbound: Some("mode-cn".to_string()),
        ..Default::default()
    });
    rules.push(SingBoxRouteRule {
        action: "route".to_string(),
        outbound: Some("mode-fallback".to_string()),
        ..Default::default()
    });

    let data = |name: &str| {
        ctx.data_dir
            .join(name)
            .to_string_lossy()
            .into_owned()
    };
    SingBoxRouteConfig {
        rule_set: Some(vec![
            SingBoxRuleSet {
                tag: "geosite-cn".to_string(),
                rule_set_type: "local".to_string(),
                format: "binary".to_string(),
                path: data("geosite-cn.srs"),
            },
            SingBoxRuleSet {
                tag: "geosite-geolocation-!cn".to_string(),
                rule_set_type: "local".to_string(),
                format: "binary".to_string(),
                path: data("geosite-geolocation-!cn.srs"),
            },
            SingBoxRuleSet {
                tag: "geoip-cn".to_string(),
                rule_set_type: "local".to_string(),
                format: "binary".to_string(),
                path: data("geoip-cn.srs"),
            },
        ]),
        rules,
        default_domain_resolver: Some("dns-local".to_string()),
        auto_detect_interface: Some(true),
        final_: Some("direct".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::default_config;

    pub fn sample_ctx() -> GenContext {
        GenContext {
            user_data_dir: PathBuf::from("/tmp/flowz-test"),
            data_dir: PathBuf::from("/tmp/flowz-test/data"),
        }
    }

    pub fn sample_config() -> UserConfig {
        let mut cfg = default_config();
        cfg.servers.push(crate::config::ServerConfig {
            id: "srv1".into(),
            name: "test-vless".into(),
            protocol: Protocol::Vless,
            address: "example.com".into(),
            port: 443,
            uuid: Some("11111111-2222-4333-8444-555555555555".into()),
            encryption: Some("none".into()),
            flow: None,
            password: None,
            hysteria2_settings: None,
            network: Some(Network::Ws),
            security: Some(Security::Tls),
            tls_settings: Some(crate::config::TlsSettings {
                server_name: Some("example.com".into()),
                allow_insecure: None,
                alpn: None,
                fingerprint: Some("chrome".into()),
            }),
            reality_settings: None,
            ws_settings: Some(crate::config::WebSocketSettings {
                path: Some("/ws".into()),
                headers: None,
                max_early_data: None,
                early_data_header_name: None,
            }),
            grpc_settings: None,
            http_settings: None,
            group_id: None,
            created_at: None,
            updated_at: None,
        });
        cfg.selected_server_id = Some("srv1".into());
        cfg
    }

    #[test]
    fn full_config_snapshot() {
        let cfg = sample_config();
        let sb = generate_singbox_config(&cfg, &sample_ctx()).unwrap();
        assert_eq!(sb.inbounds.len(), 2); // http-in + socks-in（系统代理模式无 tun）
        assert_eq!(sb.inbounds[0].listen_port, Some(65533));
        assert_eq!(sb.inbounds[1].listen_port, Some(65534));

        // outbounds: 3 mode selector + proxy selector + 1 server + direct
        assert_eq!(sb.outbounds.len(), 6);
        let proxy = sb.outbounds.iter().find(|o| o.tag == "proxy-srv1").unwrap();
        assert_eq!(proxy.outbound_type, "vless");
        assert_eq!(proxy.packet_encoding.as_deref(), Some("xudp"));
        assert_eq!(proxy.domain_resolver.as_deref(), Some("dns-local"));
        let tls = proxy.tls.as_ref().unwrap();
        assert!(tls.enabled);
        assert_eq!(tls.utls.as_ref().unwrap().fingerprint, "chrome");
        let tr = proxy.transport.as_ref().unwrap();
        assert_eq!(tr.transport_type, "ws");
        assert_eq!(tr.path.as_deref(), Some("/ws"));

        // dns: dns-local + fakeip；代理域名走 dns-local
        let dns = sb.dns.as_ref().unwrap();
        assert_eq!(dns.servers.len(), 2);
        assert_eq!(dns.servers[0].server_type, "local");
        assert_eq!(dns.final_.as_deref(), Some("dns-local"));

        // route: 首条 sniff，含 geosite rule_set
        let route = sb.route.as_ref().unwrap();
        assert_eq!(route.rules[0].action, "sniff");
        assert_eq!(route.rules[1].action, "hijack-dns");
        assert_eq!(route.rule_set.as_ref().unwrap().len(), 3);
        assert_eq!(route.final_.as_deref(), Some("direct"));

        // clash api
        let exp = sb.experimental.as_ref().unwrap();
        assert_eq!(
            exp.clash_api.as_ref().unwrap().external_controller,
            "127.0.0.1:9091"
        );
    }

    #[test]
    fn no_server_selected_errors() {
        let cfg = default_config();
        assert!(generate_singbox_config(&cfg, &sample_ctx()).is_err());
    }

    #[test]
    fn group_mode_generates_urltest() {
        let mut cfg = sample_config();
        cfg.server_groups.push(crate::config::ServerGroup {
            id: "g1".into(),
            name: "g".into(),
            url: None,
            server_ids: vec!["srv1".into()],
            subscription_server_ids: None,
            manual_server_ids: None,
            excluded_subscription_keys: None,
            created_at: None,
            updated_at: None,
        });
        cfg.selected_group_id = Some("g1".into());
        cfg.selected_server_id = None;
        let sb = generate_singbox_config(&cfg, &sample_ctx()).unwrap();
        let urltest = sb.outbounds.iter().find(|o| o.tag == "group-g1").unwrap();
        assert_eq!(urltest.outbound_type, "urltest");
        assert_eq!(
            urltest.outbounds.as_deref().unwrap(),
            &["proxy-srv1".to_string()]
        );
        let proxy_sel = sb.outbounds.iter().find(|o| o.tag == "proxy").unwrap();
        assert_eq!(proxy_sel.default.as_deref(), Some("group-g1"));
    }

    #[test]
    fn smart_mode_selections() {
        let mut cfg = sample_config();
        cfg.proxy_mode = ProxyMode::Smart;
        let sb = generate_singbox_config(&cfg, &sample_ctx()).unwrap();
        let get = |tag: &str| {
            sb.outbounds
                .iter()
                .find(|o| o.tag == tag)
                .unwrap()
                .default
                .clone()
                .unwrap()
        };
        assert_eq!(get("mode-cn"), "direct");
        assert_eq!(get("mode-non-cn"), "proxy");
        assert_eq!(get("mode-fallback"), "proxy");
    }

    #[test]
    fn ip_version_detection() {
        assert_eq!(ip_version("1.2.3.4"), 4);
        assert_eq!(ip_version("::1"), 6);
        assert_eq!(ip_version("example.com"), 0);
    }
}

