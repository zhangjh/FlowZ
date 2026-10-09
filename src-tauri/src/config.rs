//! ConfigManager 移植（对应 `src/main/services/ConfigManager.ts`）。
//!
//! 职责：用户配置的加载 / 保存 / 验证 / 默认值。
//! 为保证从 Electron 版平滑迁移，配置文件路径与 Electron 版保持一致
//! （`app.getPath('userData')/config.json` 的等价位置），而不是 Tauri 默认的
//! identifier 路径。

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::env;
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

// ---------------------------------------------------------------------------
// 大小写不敏感的枚举反序列化（对应 TS 里随处可见的 `.toLowerCase()` 比较）
// ---------------------------------------------------------------------------

fn de_ci<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: FromStr,
    T::Err: fmt::Display,
{
    let s = String::deserialize(d)?;
    s.parse::<T>().map_err(serde::de::Error::custom)
}

fn ser_lower<T: fmt::Display, S: Serializer>(v: &T, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&v.to_string())
}

macro_rules! ci_enum {
    ($name:ident, $($variant:ident => $str:literal),+) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum $name {
            $($variant),+
        }
        impl FromStr for $name {
            type Err = String;
            fn from_str(input: &str) -> Result<Self, String> {
                match input.to_lowercase().as_str() {
                    $($str => Ok($name::$variant),)+
                    _ => Err(format!("invalid {}: {}", stringify!($name), input)),
                }
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                let s = match self {
                    $($name::$variant => $str),+
                };
                write!(f, "{}", s)
            }
        }
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                ser_lower(self, s)
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                de_ci(d)
            }
        }
    };
}

ci_enum!(Protocol,
    Vless => "vless",
    Trojan => "trojan",
    Hysteria2 => "hysteria2");
ci_enum!(Network,
    Tcp => "tcp",
    Ws => "ws",
    Grpc => "grpc",
    Http => "http");
ci_enum!(Hysteria2Network,
    HTcp => "tcp",
    HUdp => "udp");
ci_enum!(Hysteria2BbrProfile,
    Conservative => "conservative",
    Standard => "standard",
    Aggressive => "aggressive");
ci_enum!(Security,
    None => "none",
    Tls => "tls",
    Reality => "reality");
ci_enum!(LogLevel,
    Debug => "debug",
    Info => "info",
    Warn => "warn",
    Error => "error",
    Fatal => "fatal");
ci_enum!(RuleAction,
    Proxy => "proxy",
    Direct => "direct",
    Block => "block");
ci_enum!(TunStack,
    System => "system",
    Gvisor => "gvisor",
    Mixed => "mixed");
ci_enum!(ProxyMode,
    Global => "global",
    Smart => "smart",
    Direct => "direct");
ci_enum!(AutoSelectMode,
    Latency => "latency",
    Speed => "speed");

// proxyModeType 的取值是 camelCase（"systemProxy"/"tun"），单独手写
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyModeType {
    SystemProxy,
    Tun,
}

impl FromStr for ProxyModeType {
    type Err = String;
    fn from_str(input: &str) -> Result<Self, String> {
        match input.to_lowercase().as_str() {
            "systemproxy" => Ok(ProxyModeType::SystemProxy),
            "tun" => Ok(ProxyModeType::Tun),
            _ => Err(format!("invalid ProxyModeType: {}", input)),
        }
    }
}

impl fmt::Display for ProxyModeType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let v = match self {
            ProxyModeType::SystemProxy => "systemProxy",
            ProxyModeType::Tun => "tun",
        };
        write!(f, "{}", v)
    }
}

impl Serialize for ProxyModeType {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let v = match self {
            ProxyModeType::SystemProxy => "systemProxy",
            ProxyModeType::Tun => "tun",
        };
        s.serialize_str(v)
    }
}

impl<'de> Deserialize<'de> for ProxyModeType {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        de_ci(d)
    }
}

// ---------------------------------------------------------------------------
// 配置结构体（字段名与 TS 侧 JSON 保持 camelCase 一致）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TlsSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_insecure: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpn: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RealitySettings {
    pub public_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_early_data: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub early_data_header_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrpcSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_mode: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::HashMap<String, Vec<String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hysteria2ObfsSettings {
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub obfs_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_packet_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_packet_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hysteria2Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub up_mbps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub down_mbps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub obfs: Option<Hysteria2ObfsSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<Hysteria2Network>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_ports: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hop_interval: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hop_interval_max: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bbr_profile: Option<Hysteria2BbrProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disable_chrome_parrot: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub address: String,
    pub port: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hysteria2_settings: Option<Hysteria2Settings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<Network>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security: Option<Security>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_settings: Option<TlsSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reality_settings: Option<RealitySettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ws_settings: Option<WebSocketSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grpc_settings: Option<GrpcSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_settings: Option<HttpSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerGroup {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub server_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_server_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_server_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_subscription_keys: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DomainRule {
    pub id: String,
    pub domains: Vec<String>,
    pub action: RuleAction,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bypass_fake_ip: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TunModeConfig {
    pub mtu: u32,
    pub stack: TunStack,
    pub auto_route: bool,
    pub strict_route: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inet4_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inet6_address: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoSelectConfig {
    pub enabled: bool,
    pub mode: AutoSelectMode,
    pub interval: u32,
    pub failover_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserConfig {
    pub servers: Vec<ServerConfig>,
    pub selected_server_id: Option<String>,
    #[serde(default)]
    pub server_groups: Vec<ServerGroup>,
    #[serde(default)]
    pub selected_group_id: Option<String>,
    pub proxy_mode: ProxyMode,
    pub proxy_mode_type: ProxyModeType,
    pub tun_config: TunModeConfig,
    pub custom_rules: Vec<DomainRule>,
    pub auto_start: bool,
    pub auto_connect: bool,
    pub minimize_to_tray: bool,
    #[serde(default = "default_true")]
    pub auto_check_update: bool,
    pub socks_port: u32,
    pub http_port: u32,
    pub log_level: LogLevel,
    #[serde(default = "default_auto_select")]
    pub auto_select: AutoSelectConfig,
}

fn default_true() -> bool {
    true
}

fn default_auto_select() -> AutoSelectConfig {
    AutoSelectConfig {
        enabled: false,
        mode: AutoSelectMode::Latency,
        interval: 60,
        failover_enabled: true,
    }
}

// ---------------------------------------------------------------------------
// 默认配置（对应 createDefaultConfig）
// ---------------------------------------------------------------------------

pub fn default_config() -> UserConfig {
    UserConfig {
        servers: vec![],
        selected_server_id: None,
        server_groups: vec![],
        selected_group_id: None,
        proxy_mode: ProxyMode::Global,
        proxy_mode_type: ProxyModeType::SystemProxy,
        tun_config: TunModeConfig {
            mtu: 9000,
            stack: TunStack::System,
            auto_route: true,
            strict_route: true,
            interface_name: None,
            inet4_address: None,
            inet6_address: None,
        },
        custom_rules: vec![],
        auto_start: false,
        auto_connect: false,
        minimize_to_tray: true,
        auto_check_update: true,
        socks_port: 65534,
        http_port: 65533,
        log_level: LogLevel::Info,
        auto_select: default_auto_select(),
    }
}

// ---------------------------------------------------------------------------
// 验证（对应 validateConfig；注意它会原地补齐兼容字段）
// ---------------------------------------------------------------------------

pub fn validate_config(cfg: &mut UserConfig) -> Result<(), String> {
    for s in &cfg.servers {
        if s.id.is_empty() {
            return Err("Server id is required and must be a string".into());
        }
        if s.name.is_empty() {
            return Err("Server name is required and must be a string".into());
        }
        if s.address.is_empty() {
            return Err("Server address is required and must be a string".into());
        }
        if s.port < 1 || s.port > 65535 {
            return Err("Server port must be a number between 1 and 65535".into());
        }
        match s.protocol {
            Protocol::Vless => {
                if s.uuid.as_deref().map(|u| u.is_empty()).unwrap_or(true) {
                    return Err("VLESS server requires uuid".into());
                }
            }
            Protocol::Trojan => {
                if s.password.as_deref().map(|p| p.is_empty()).unwrap_or(true) {
                    return Err("Trojan server requires password".into());
                }
            }
            Protocol::Hysteria2 => {}
        }
    }

    if let Some(ref id) = cfg.selected_server_id {
        if !cfg.servers.iter().any(|s| &s.id == id) {
            return Err("selectedServerId references a non-existent server".into());
        }
    }

    // 分组兼容字段补齐（对应 TS 的三处 if (!Array.isArray(...))）
    for g in &mut cfg.server_groups {
        if g.id.is_empty() {
            return Err("Group id is required and must be a string".into());
        }
        if g.name.is_empty() {
            return Err("Group name is required and must be a string".into());
        }
        let has_url = g.url.as_deref().map(|u| !u.is_empty()).unwrap_or(false);
        if g.subscription_server_ids.is_none() {
            g.subscription_server_ids = Some(if has_url {
                g.server_ids.clone()
            } else {
                vec![]
            });
        }
        if g.manual_server_ids.is_none() {
            g.manual_server_ids = Some(if has_url {
                vec![]
            } else {
                g.server_ids.clone()
            });
        }
        if g.excluded_subscription_keys.is_none() {
            g.excluded_subscription_keys = Some(vec![]);
        }
        // 去重合并
        let mut seen = std::collections::HashSet::new();
        let mut merged = Vec::new();
        for id in g
            .subscription_server_ids
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .chain(g.manual_server_ids.as_deref().unwrap_or(&[]).iter())
        {
            if seen.insert(id.clone()) {
                merged.push(id.clone());
            }
        }
        g.server_ids = merged;
    }

    if let Some(ref gid) = cfg.selected_group_id {
        if !cfg.server_groups.iter().any(|g| &g.id == gid) {
            return Err("selectedGroupId references a non-existent group".into());
        }
    }

    // 分组和单节点互斥：分组优先（与 TS 一致）
    if cfg.selected_group_id.is_some() && cfg.selected_server_id.is_some() {
        cfg.selected_server_id = None;
    }

    if cfg.tun_config.mtu < 1280 || cfg.tun_config.mtu > 65535 {
        return Err("tunConfig.mtu must be a number between 1280 and 65535".into());
    }

    for r in &cfg.custom_rules {
        if r.id.is_empty() {
            return Err("Rule id is required and must be a string".into());
        }
        if r.domains.is_empty() || r.domains.iter().any(|d| d.trim().is_empty()) {
            return Err("Rule domains is required and must be a non-empty array".into());
        }
    }

    if cfg.socks_port < 1 || cfg.socks_port > 65535 {
        return Err("socksPort must be a number between 1 and 65535".into());
    }
    if cfg.http_port < 1 || cfg.http_port > 65535 {
        return Err("httpPort must be a number between 1 and 65535".into());
    }
    if cfg.auto_select.interval < 10 {
        return Err("autoSelect.interval must be a number >= 10".into());
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 路径（与 Electron 版 app.getPath('userData') 等价，保证迁移不断档）
// ---------------------------------------------------------------------------

pub(crate) fn user_data_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        env::var("APPDATA")
            .map(|p| PathBuf::from(p).join("FlowZ"))
            .map_err(|_| "APPDATA not set".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        // 对应 paths.ts 的 root 提权兼容：SUDO_USER 存在时用真实用户目录
        if let Ok(sudo_user) = env::var("SUDO_USER") {
            if !sudo_user.is_empty() {
                return Ok(PathBuf::from(format!(
                    "/Users/{}/Library/Application Support/FlowZ",
                    sudo_user
                )));
            }
        }
        env::var("HOME")
            .map(|p| {
                PathBuf::from(p)
                    .join("Library/Application Support")
                    .join("FlowZ")
            })
            .map_err(|_| "HOME not set".to_string())
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = env::var("XDG_CONFIG_HOME") {
            if !xdg.is_empty() {
                return Ok(PathBuf::from(xdg).join("FlowZ"));
            }
        }
        env::var("HOME")
            .map(|p| PathBuf::from(p).join(".config").join("FlowZ"))
            .map_err(|_| "HOME not set".to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("unsupported platform".to_string())
    }
}

pub fn config_path() -> Result<PathBuf, String> {
    user_data_dir().map(|d| d.join("config.json"))
}

// ---------------------------------------------------------------------------
// 加载 / 保存
// ---------------------------------------------------------------------------

pub fn load_config() -> Result<UserConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        let def = default_config();
        save_config(&def)?;
        return Ok(def);
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("读取配置文件失败: {}", e))?;
    let mut cfg: UserConfig =
        serde_json::from_str(&content).map_err(|e| format!("配置文件损坏: {}", e))?;
    validate_config(&mut cfg).map_err(|e| format!("配置验证失败: {}", e))?;
    Ok(cfg)
}

pub fn save_config(cfg: &UserConfig) -> Result<(), String> {
    let mut owned = cfg.clone();
    validate_config(&mut owned)?;
    let path = config_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    let content =
        serde_json::to_string_pretty(&owned).map_err(|e| format!("序列化配置失败: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("写入配置文件失败: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_validates() {
        let mut cfg = default_config();
        assert!(validate_config(&mut cfg).is_ok());
        assert_eq!(cfg.socks_port, 65534);
        assert_eq!(cfg.proxy_mode_type, ProxyModeType::SystemProxy);
    }

    #[test]
    fn default_config_json_roundtrip_matches_ts_shape() {
        let cfg = default_config();
        let v = serde_json::to_value(&cfg).unwrap();
        // 关键字段名必须是 camelCase（与 Electron 版 config.json 互通）
        assert_eq!(v["proxyMode"], "global");
        assert_eq!(v["proxyModeType"], "systemProxy");
        assert_eq!(v["socksPort"], 65534);
        assert_eq!(v["tunConfig"]["stack"], "system");
        assert_eq!(v["logLevel"], "info");
        assert_eq!(v["autoSelect"]["mode"], "latency");
    }

    #[test]
    fn rejects_bad_server() {
        let mut cfg = default_config();
        cfg.servers.push(ServerConfig {
            id: "1".into(),
            name: "bad".into(),
            protocol: Protocol::Vless,
            address: "example.com".into(),
            port: 443,
            uuid: None, // 缺 uuid
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
        });
        assert!(validate_config(&mut cfg).is_err());
    }

    #[test]
    fn group_compat_fields_filled() {
        let mut cfg = default_config();
        cfg.server_groups.push(ServerGroup {
            id: "g1".into(),
            name: "sub".into(),
            url: Some("https://example.com/sub".into()),
            server_ids: vec!["s1".into()],
            subscription_server_ids: None,
            manual_server_ids: None,
            excluded_subscription_keys: None,
            created_at: None,
            updated_at: None,
        });
        validate_config(&mut cfg).unwrap();
        let g = &cfg.server_groups[0];
        assert_eq!(g.subscription_server_ids.as_deref().unwrap(), &["s1"]);
        assert!(g.manual_server_ids.as_deref().unwrap().is_empty());
    }

    #[test]
    fn protocol_case_insensitive() {
        let p: Protocol = serde_json::from_str("\"VLESS\"").unwrap();
        assert_eq!(p, Protocol::Vless);
        assert_eq!(serde_json::to_string(&Protocol::Hysteria2).unwrap(), "\"hysteria2\"");
    }
}
