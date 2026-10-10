//! 系统 DNS 工具（对应 src/main/utils/dns.ts）。
//!
//! - 各平台读取系统上游 DNS（Linux: resolv.conf；Windows: PowerShell/ipconfig；
//!   macOS: scutil/networksetup）
//! - macOS TUN DNS：劫持地址推导、设置/恢复系统 DNS、原始 DNS 缓存
//!
//! 注意：macOS 分支在 Linux 沙箱无法执行，逻辑与 TS 版逐行对应，
//! 待真机验证。

#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn parse_resolv_conf(path: &str) -> Vec<String> {
    let content = std::fs::read_to_string(path).unwrap_or_default();
    content
        .lines()
        .filter_map(|line| {
            let t = line.trim();
            t.strip_prefix("nameserver ").map(|ip| ip.trim().to_string())
        })
        .filter(|ip| !ip.is_empty())
        .collect()
}

fn is_loopback(ip: &str) -> bool {
    ip.starts_with("127.") || ip == "::1"
}

fn is_docker_bridge(ip: &str) -> bool {
    if !ip.contains('.') {
        return false;
    }
    let parts: Vec<u32> = ip.split('.').filter_map(|p| p.parse().ok()).collect();
    parts.len() == 4 && parts[0] == 172 && (16..=31).contains(&parts[1])
}

fn is_valid_ip(ip: &str) -> bool {
    if let Ok(v4) = ip.parse::<std::net::Ipv4Addr>() {
        return !v4.is_unspecified();
    }
    if ip.contains(':') && !ip.contains('.') {
        // 过滤不可用的 IPv6：site-local / link-local / multicast / unspecified
        let lower = ip.to_lowercase();
        if lower.starts_with("fec") || lower.starts_with("fe8") || lower.starts_with("fe9") ||
           lower.starts_with("fea") || lower.starts_with("feb") || lower.starts_with("ff") {
            return false;
        }
        return ip.parse::<std::net::Ipv6Addr>().is_ok();
    }
    false
}

/// TUN 内部地址判断：macOS 上 FlowZ 会把系统 DNS 指向 TUN 劫持地址，
/// 读取系统 DNS 时必须过滤这些内部地址。
pub fn is_tun_internal_address(ip: &str) -> bool {
    if ip.contains(':') {
        return ip.starts_with("fdfe:dcba:9876:") || ip.starts_with("fdfe:dcba:9876::");
    }
    ip.starts_with("172.19.")
}

#[cfg(target_os = "linux")]
fn get_linux_dns_servers() -> Vec<String> {
    let is_usable = |ip: &String| !is_loopback(ip) && !is_docker_bridge(ip);
    for path in ["/etc/resolv.conf", "/run/systemd/resolve/resolv.conf"] {
        let filtered: Vec<String> = parse_resolv_conf(path).into_iter().filter(is_usable).collect();
        if !filtered.is_empty() {
            return filtered;
        }
    }
    Vec::new()
}

#[cfg(target_os = "windows")]
fn get_windows_dns_servers() -> Vec<String> {
    // 方法 1: PowerShell
    let mut ps_cmd = Command::new("powershell");
    ps_cmd.creation_flags(0x08000000); // 不弹控制台
    if let Ok(out) = ps_cmd
        .args(["-NoProfile", "-Command",
               "Get-DnsClientServerAddress -AddressFamily IPv4,IPv6 | Select-Object -ExpandProperty ServerAddresses"])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        let servers: Vec<String> = text
            .lines()
            .map(|l| l.trim().trim_start_matches('[').trim_end_matches(']').to_string())
            .filter(|ip| !ip.is_empty() && is_valid_ip(ip) && !is_loopback(ip))
            .collect();
        if !servers.is_empty() {
            return dedup_ipv4_first(servers);
        }
    }
    // 方法 2: ipconfig /all
    let mut ipconfig_cmd = Command::new("ipconfig");
    ipconfig_cmd.arg("/all");
    ipconfig_cmd.creation_flags(0x08000000); // 不弹控制台
    if let Ok(out) = ipconfig_cmd.output() {
        let text = String::from_utf8_lossy(&out.stdout);
        let mut servers = Vec::new();
        for line in text.lines() {
            if let Some(idx) = line.find("DNS") {
                if let Some(colon) = line[idx..].find(':') {
                    for part in line[idx + colon + 1..].split_whitespace() {
                        let cleaned = part.trim_start_matches('[').trim_end_matches(']');
                        if is_valid_ip(cleaned) && !is_loopback(cleaned) {
                            servers.push(cleaned.to_string());
                        }
                    }
                }
            }
        }
        if !servers.is_empty() {
            return dedup_ipv4_first(servers);
        }
    }
    Vec::new()
}

fn dedup_ipv4_first(servers: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut unique: Vec<String> = servers.into_iter().filter(|s| seen.insert(s.clone())).collect();
    unique.sort_by_key(|ip| ip.contains(':') as u8);
    unique
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn mac_network_services() -> Vec<String> {
    let out = Command::new("networksetup")
        .arg("-listallnetworkservices")
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .lines()
            .skip(1)
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with('*'))
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(target_os = "macos")]
fn read_mac_dns_from_scutil() -> Vec<String> {
    let out = match Command::new("scutil").arg("--dns").output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut servers = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("nameserver[") {
            if let Some(colon) = rest.find("]:") {
                let mut ip = rest[colon + 2..].trim().to_string();
                if let Some(pct) = ip.find('%') {
                    ip.truncate(pct);
                }
                servers.push(ip);
            }
        }
    }
    let mut valid: Vec<String> = servers
        .into_iter()
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .filter(|ip| is_valid_ip(ip) && !is_loopback(ip) && !is_tun_internal_address(ip))
        .collect();
    valid.sort_by_key(|ip| ip.contains(':') as u8);
    valid
}

#[cfg(target_os = "macos")]
fn read_mac_dns_from_networksetup() -> Vec<String> {
    let mut servers = Vec::new();
    for service in mac_network_services() {
        let out = match Command::new("networksetup")
            .args(["-getdnsservers", &service])
            .output()
        {
            Ok(o) => o,
            Err(_) => continue,
        };
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let t = line.trim();
            // 形如 "DNS Servers: 8.8.8.8" 或每行一个 IP
            let ips_part = t
                .strip_prefix("DNS Servers:")
                .or_else(|| t.strip_prefix("DNS Server:"))
                .unwrap_or(t);
            for part in ips_part.split_whitespace() {
                if is_valid_ip(part) && !is_loopback(part) && !is_tun_internal_address(part) {
                    servers.push(part.to_string());
                }
            }
        }
    }
    servers.into_iter().collect::<std::collections::HashSet<_>>().into_iter().collect()
}

/// 读取 macOS 当前实际生效的系统 DNS（优先 scutil，fallback networksetup）
#[cfg(target_os = "macos")]
pub fn read_mac_dns_servers() -> Vec<String> {
    let from_scutil = read_mac_dns_from_scutil();
    if !from_scutil.is_empty() {
        return from_scutil;
    }
    read_mac_dns_from_networksetup()
}

/// 设置/恢复 macOS 系统 DNS；servers 为空时恢复 DHCP（empty）
#[cfg(target_os = "macos")]
pub fn set_system_dns_servers(servers: &[String]) -> Result<(), String> {
    let args = if servers.is_empty() {
        "empty".to_string()
    } else {
        servers.join(" ")
    };
    for service in mac_network_services() {
        let status = Command::new("networksetup")
            .args(["-setdnsservers", &service])
            .args(args.split_whitespace())
            .status()
            .map_err(|e| format!("networksetup 执行失败: {}", e))?;
        if !status.success() {
            return Err(format!("设置 {} 的 DNS 失败", service));
        }
    }
    // 刷新 DNS 缓存
    let _ = Command::new("dscacheutil").arg("-flushcache").status();
    let _ = Command::new("killall")
        .args(["-HUP", "mDNSResponder"])
        .status();
    Ok(())
}

fn increment_ipv4(ip: &str) -> Option<String> {
    let mut parts: Vec<u32> = ip.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    if parts.len() != 4 {
        return None;
    }
    parts[3] += 1;
    for i in (1..=3).rev() {
        if parts[i] > 255 {
            parts[i] = 0;
            parts[i - 1] += 1;
        }
    }
    if parts[0] > 255 {
        return None;
    }
    Some(parts.iter().map(|n| n.to_string()).collect::<Vec<_>>().join("."))
}

/// 计算 TUN DNS 劫持地址：TUN 地址的下一个 IP（如 172.19.0.1/30 → 172.19.0.2）
pub fn get_tun_dns_addresses(addresses: &[String]) -> Vec<String> {
    addresses
        .iter()
        .filter_map(|entry| {
            let ip = entry.split('/').next()?;
            if ip.contains(':') {
                // IPv6 递增（简化：只处理常见情况）
                increment_ipv6(ip)
            } else {
                increment_ipv4(ip)
            }
        })
        .collect()
}

fn increment_ipv6(ip: &str) -> Option<String> {
    let addr: std::net::Ipv6Addr = ip.parse().ok()?;
    let mut segments = addr.segments();
    for i in (0..8).rev() {
        let (v, overflow) = segments[i].overflowing_add(1);
        segments[i] = v;
        if !overflow {
            break;
        }
        if i == 0 {
            return None;
        }
    }
    Some(std::net::Ipv6Addr::from(segments).to_string())
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/// 获取系统上游 DNS（TUN 模式下避免 DNS 死循环用）
pub fn get_system_dns_servers() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        return get_linux_dns_servers();
    }
    #[cfg(target_os = "windows")]
    {
        return get_windows_dns_servers();
    }
    #[cfg(target_os = "macos")]
    {
        let cached = MAC_DNS_CACHE.lock().map(|c| c.clone()).unwrap_or_default();
        if let Some(servers) = cached {
            return servers;
        }
        let servers: Vec<String> = read_mac_dns_servers()
            .into_iter()
            .filter(|ip| !is_tun_internal_address(ip))
            .collect();
        let result = if servers.is_empty() {
            // 兜底公共 DNS，避免 dns-local 回退导致死循环
            vec!["223.5.5.5".to_string(), "119.29.29.29".to_string()]
        } else {
            servers
        };
        if let Ok(mut c) = MAC_DNS_CACHE.lock() {
            *c = Some(result.clone());
        }
        return result;
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        return Vec::new();
    }
}

#[cfg(target_os = "macos")]
static MAC_DNS_CACHE: std::sync::Mutex<Option<Vec<String>>> =
    std::sync::Mutex::new(None);

/// 重置 macOS 原始 DNS 缓存
#[cfg(target_os = "macos")]
pub fn reset_mac_dns_cache() {
    if let Ok(mut c) = MAC_DNS_CACHE.lock() {
        *c = None;
    }
}

#[cfg(not(target_os = "macos"))]
pub fn reset_mac_dns_cache() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tun_internal_address_detection() {
        assert!(is_tun_internal_address("172.19.0.2"));
        assert!(is_tun_internal_address("fdfe:dcba:9876::2"));
        assert!(!is_tun_internal_address("8.8.8.8"));
        assert!(!is_tun_internal_address("223.5.5.5"));
    }

    #[test]
    fn tun_dns_address_derivation() {
        let addrs = vec!["172.19.0.1/30".to_string(), "fdfe:dcba:9876::1/126".to_string()];
        let dns = get_tun_dns_addresses(&addrs);
        assert_eq!(dns[0], "172.19.0.2");
        assert!(dns[1].starts_with("fdfe:dcba:9876::"));
    }

    #[test]
    fn resolv_conf_parsing() {
        let servers = parse_resolv_conf("/etc/resolv.conf");
        // 沙箱环境一定有 resolv.conf，至少不 panic
        let _ = servers;
    }

    #[test]
    fn system_dns_no_loopback() {
        for ip in get_system_dns_servers() {
            assert!(!is_loopback(&ip), "DNS 不应包含回环地址: {}", ip);
        }
    }
}
