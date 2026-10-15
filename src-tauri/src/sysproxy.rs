//! SystemProxyManager 移植（对应 `src/main/services/SystemProxyManager.ts`）。
//!
//! 三平台都是 shell-out：
//! - Linux: gsettings（GNOME 代理 schema）
//! - Windows: reg add HKCU\...\Internet Settings
//! - macOS: networksetup
//! Windows/macOS 分支为直接移植，沙箱内无法实测，调用前请真机验证。

use serde::Serialize;
#[cfg(target_os = "linux")]
use std::process::Stdio;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Default)]
pub struct SystemProxyStatus {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_proxy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub https_proxy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub socks_proxy: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct LinuxProxySettings {
    mode: String,
    http_host: String,
    http_port: u32,
    https_host: String,
    https_port: u32,
    socks_host: String,
    socks_port: u32,
    ignore_hosts: String,
}

pub struct SystemProxyManager {
    #[allow(dead_code)]
    original: Option<LinuxProxySettings>,
}

impl SystemProxyManager {
    pub fn new() -> Self {
        SystemProxyManager { original: None }
    }

    pub async fn enable_proxy(
        &mut self,
        address: &str,
        http_port: u32,
        socks_port: u32,
    ) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            self.enable_linux(address, http_port, socks_port).await
        }
        #[cfg(target_os = "windows")]
        {
            self.enable_windows(address, http_port, socks_port).await
        }
        #[cfg(target_os = "macos")]
        {
            self.enable_macos(address, http_port, socks_port).await
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
        {
            let _ = (address, http_port, socks_port);
            Err("不支持的平台".to_string())
        }
    }

    pub async fn disable_proxy(&mut self) -> Result<(), String> {
        // 有备份优先按备份还原（跨平台统一出口，注销/崩溃后的自愈也复用它）
        if let Some(backup) = load_backup() {
            apply_backup(&backup);
            remove_backup();
            self.original = None;
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        {
            self.disable_linux().await
        }
        #[cfg(target_os = "windows")]
        {
            self.disable_windows().await
        }
        #[cfg(target_os = "macos")]
        {
            self.disable_macos().await
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
        {
            Err("不支持的平台".to_string())
        }
    }

    pub async fn get_proxy_status(&self) -> SystemProxyStatus {
        #[cfg(target_os = "linux")]
        {
            self.status_linux().await
        }
        #[cfg(not(target_os = "linux"))]
        {
            // Windows/macOS 状态查询：直接移植为后续实现保留，当前返回未启用
            // TODO(phase-5): 补全 win/mac 的 getProxyStatus
            SystemProxyStatus::default()
        }
    }
}

// ---------------------------------------------------------------------------
// Linux: gsettings
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
impl SystemProxyManager {
    async fn ensure_gsettings(&self) -> Result<(), String> {
        let ok = Command::new("sh")
            .arg("-c")
            .arg("command -v gsettings")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            Ok(())
        } else {
            Err("未找到 gsettings，当前 Linux 桌面环境暂不支持自动设置系统代理".to_string())
        }
    }

    async fn get_raw(&self, schema: &str, key: &str) -> Result<String, String> {
        let out = Command::new("gsettings")
            .arg("get")
            .arg(schema)
            .arg(key)
            .output()
            .await
            .map_err(|e| format!("gsettings get 失败: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "gsettings get {} {} 失败: {}",
                schema,
                key,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn unquote(s: &str) -> String {
        s.strip_prefix('\'')
            .and_then(|t| t.strip_suffix('\''))
            .unwrap_or(s)
            .replace("\\'", "'")
    }

    async fn get_string(&self, schema: &str, key: &str) -> Result<String, String> {
        Ok(Self::unquote(&self.get_raw(schema, key).await?))
    }

    async fn get_int(&self, schema: &str, key: &str) -> Result<u32, String> {
        Ok(self.get_raw(schema, key).await?.parse::<u32>().unwrap_or(0))
    }

    async fn set_raw(&self, schema: &str, key: &str, value: &str) -> Result<(), String> {
        let out = Command::new("gsettings")
            .arg("set")
            .arg(schema)
            .arg(key)
            .arg(value)
            .output()
            .await
            .map_err(|e| format!("gsettings set 失败: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "gsettings set {} {} 失败: {}",
                schema,
                key,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(())
    }

    fn sh_quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }

    async fn set_string(&self, schema: &str, key: &str, value: &str) -> Result<(), String> {
        self.set_raw(schema, key, &Self::sh_quote(value)).await
    }

    async fn set_int(&self, schema: &str, key: &str, value: u32) -> Result<(), String> {
        self.set_raw(schema, key, &value.to_string()).await
    }

    async fn current_settings(&self) -> Result<LinuxProxySettings, String> {
        Ok(LinuxProxySettings {
            mode: self.get_string("org.gnome.system.proxy", "mode").await?,
            http_host: self.get_string("org.gnome.system.proxy.http", "host").await?,
            http_port: self.get_int("org.gnome.system.proxy.http", "port").await?,
            https_host: self.get_string("org.gnome.system.proxy.https", "host").await?,
            https_port: self.get_int("org.gnome.system.proxy.https", "port").await?,
            socks_host: self.get_string("org.gnome.system.proxy.socks", "host").await?,
            socks_port: self.get_int("org.gnome.system.proxy.socks", "port").await?,
            ignore_hosts: self.get_raw("org.gnome.system.proxy", "ignore-hosts").await?,
        })
    }

    async fn restore_settings(&self, s: &LinuxProxySettings) -> Result<(), String> {
        self.set_string("org.gnome.system.proxy.http", "host", &s.http_host).await?;
        self.set_int("org.gnome.system.proxy.http", "port", s.http_port).await?;
        self.set_string("org.gnome.system.proxy.https", "host", &s.https_host).await?;
        self.set_int("org.gnome.system.proxy.https", "port", s.https_port).await?;
        self.set_string("org.gnome.system.proxy.socks", "host", &s.socks_host).await?;
        self.set_int("org.gnome.system.proxy.socks", "port", s.socks_port).await?;
        self.set_raw("org.gnome.system.proxy", "ignore-hosts", &s.ignore_hosts).await?;
        self.set_string("org.gnome.system.proxy", "mode", &s.mode).await?;
        Ok(())
    }

    async fn enable_linux(
        &mut self,
        address: &str,
        http_port: u32,
        socks_port: u32,
    ) -> Result<(), String> {
        self.ensure_gsettings().await?;
        // 保存原始设置（失败也不阻断）；首次启用才落盘，供异常退出后自愈
        let mut created_backup = false;
        if load_backup().is_none() {
            if let Ok(s) = self.current_settings().await {
                save_backup(&ProxyBackup::Linux {
                    settings: s.clone(),
                    applied_http_port: Some(http_port as u16),
                });
                self.original = Some(s);
                created_backup = true;
            }
        }

        let apply = || async {
            self.set_string("org.gnome.system.proxy.http", "host", address).await?;
            self.set_int("org.gnome.system.proxy.http", "port", http_port).await?;
            self.set_string("org.gnome.system.proxy.https", "host", address).await?;
            self.set_int("org.gnome.system.proxy.https", "port", http_port).await?;
            self.set_string("org.gnome.system.proxy.socks", "host", address).await?;
            self.set_int("org.gnome.system.proxy.socks", "port", socks_port).await?;
            self.set_raw(
                "org.gnome.system.proxy",
                "ignore-hosts",
                "['localhost', '127.0.0.0/8', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']",
            ).await?;
            self.set_string("org.gnome.system.proxy", "mode", "manual").await?;
            Ok::<(), String>(())
        };

        // 最多 3 次尝试（与 TS maxRetries:2 一致）
        let mut last_err = String::new();
        for attempt in 0..3 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            match apply().await {
                Ok(_) => return Ok(()),
                Err(e) => {
                    let m = e.to_lowercase();
                    last_err = e;
                    if m.contains("no such schema") || m.contains("permission") {
                        break;
                    }
                }
            }
        }
        // 失败回滚：优先用本次新建的备份还原，其次用内存中的原始设置
        if created_backup {
            if let Some(backup) = load_backup() {
                apply_backup(&backup);
            }
            remove_backup();
            self.original = None;
        } else if let Some(orig) = self.original.clone() {
            let _ = self.restore_settings(&orig).await;
        }
        Err(format!(
            "设置 Linux 系统代理失败: {}\n\n可能的原因:\n1. 当前桌面环境不支持 GNOME gsettings 代理配置\n2. gsettings 命令不可用\n3. 系统策略限制修改代理设置",
            last_err
        ))
    }

    async fn disable_linux(&mut self) -> Result<(), String> {
        self.ensure_gsettings().await?;
        if let Some(orig) = self.original.take() {
            self.restore_settings(&orig)
                .await
                .map_err(|e| format!("恢复原始代理设置失败: {}", e))?;
        } else {
            self.set_string("org.gnome.system.proxy", "mode", "none")
                .await
                .map_err(|e| format!("禁用 Linux 系统代理失败: {}", e))?;
        }
        Ok(())
    }

    async fn status_linux(&self) -> SystemProxyStatus {
        let mut st = SystemProxyStatus::default();
        if self.ensure_gsettings().await.is_err() {
            return st;
        }
        let mode = self.get_string("org.gnome.system.proxy", "mode").await.unwrap_or_default();
        if mode != "manual" {
            return st;
        }
        st.enabled = true;
        let http_host = self.get_string("org.gnome.system.proxy.http", "host").await.unwrap_or_default();
        let http_port = self.get_int("org.gnome.system.proxy.http", "port").await.unwrap_or(0);
        let https_host = self.get_string("org.gnome.system.proxy.https", "host").await.unwrap_or_default();
        let https_port = self.get_int("org.gnome.system.proxy.https", "port").await.unwrap_or(0);
        let socks_host = self.get_string("org.gnome.system.proxy.socks", "host").await.unwrap_or_default();
        let socks_port = self.get_int("org.gnome.system.proxy.socks", "port").await.unwrap_or(0);
        if !http_host.is_empty() && http_port > 0 {
            st.http_proxy = Some(format!("{}:{}", http_host, http_port));
        }
        if !https_host.is_empty() && https_port > 0 {
            st.https_proxy = Some(format!("{}:{}", https_host, https_port));
        }
        if !socks_host.is_empty() && socks_port > 0 {
            st.socks_proxy = Some(format!("{}:{}", socks_host, socks_port));
        }
        st
    }
}

/// 同步执行 gsettings set（供无法 await 的自愈/退出路径复用）。
#[cfg(target_os = "linux")]
fn gsettings_set_sync(schema: &str, key: &str, value: &str) -> bool {
    std::process::Command::new("gsettings")
        .args(["set", schema, key, value])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn apply_backup_linux(s: &LinuxProxySettings) {
    let _ = gsettings_set_sync(
        "org.gnome.system.proxy.http",
        "host",
        &SystemProxyManager::sh_quote(&s.http_host),
    );
    let _ = gsettings_set_sync("org.gnome.system.proxy.http", "port", &s.http_port.to_string());
    let _ = gsettings_set_sync(
        "org.gnome.system.proxy.https",
        "host",
        &SystemProxyManager::sh_quote(&s.https_host),
    );
    let _ = gsettings_set_sync("org.gnome.system.proxy.https", "port", &s.https_port.to_string());
    let _ = gsettings_set_sync(
        "org.gnome.system.proxy.socks",
        "host",
        &SystemProxyManager::sh_quote(&s.socks_host),
    );
    let _ = gsettings_set_sync("org.gnome.system.proxy.socks", "port", &s.socks_port.to_string());
    let _ = gsettings_set_sync("org.gnome.system.proxy", "ignore-hosts", &s.ignore_hosts);
    let _ = gsettings_set_sync(
        "org.gnome.system.proxy",
        "mode",
        &SystemProxyManager::sh_quote(&s.mode),
    );
}

// ---------------------------------------------------------------------------
// 系统代理备份：进程异常退出（注销/重启/被杀）后下次启动自愈用
// ---------------------------------------------------------------------------

/// macOS 单个网络服务的原始代理状态。
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct MacServiceBackup {
    service: String,
    web_enabled: bool,
    web_server: String,
    web_port: u16,
    secure_enabled: bool,
    secure_server: String,
    secure_port: u16,
    socks_enabled: bool,
    socks_server: String,
    socks_port: u16,
    bypass_domains: String,
}

/// 按平台记录「启用代理前」的原始系统代理设置，用于退出/崩溃后还原。
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "platform", rename_all = "snake_case")]
enum ProxyBackup {
    Windows {
        proxy_enable: Option<String>,
        proxy_server: Option<String>,
        proxy_override: Option<String>,
        #[serde(default)]
        applied_http_port: Option<u16>,
    },
    Macos {
        services: Vec<MacServiceBackup>,
        #[serde(default)]
        applied_http_port: Option<u16>,
    },
    Linux {
        settings: LinuxProxySettings,
        #[serde(default)]
        applied_http_port: Option<u16>,
    },
}

impl ProxyBackup {
    fn applied_http_port(&self) -> Option<u16> {
        match self {
            ProxyBackup::Windows { applied_http_port, .. }
            | ProxyBackup::Macos { applied_http_port, .. }
            | ProxyBackup::Linux { applied_http_port, .. } => *applied_http_port,
        }
    }
}

fn backup_file() -> Option<std::path::PathBuf> {
    crate::config::user_data_dir()
        .ok()
        .map(|d| d.join("sysproxy_backup.json"))
}

fn load_backup() -> Option<ProxyBackup> {
    let path = backup_file()?;
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_backup(b: &ProxyBackup) {
    let Some(path) = backup_file() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(b) {
        let _ = std::fs::write(&path, text);
    }
}

/// 保存备份；已存在则不覆盖，返回是否新写入（避免重复 enable 覆盖真正的原始值）。
#[allow(dead_code)]
fn save_backup_if_absent(b: ProxyBackup) -> bool {
    if load_backup().is_some() {
        return false;
    }
    save_backup(&b);
    true
}

fn remove_backup() {
    if let Some(path) = backup_file() {
        let _ = std::fs::remove_file(path);
    }
}

/// 本地端口是否有进程监听：用于区分「代理遗留」与「代理仍在运行（多实例）」。
fn port_listening(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(200),
    )
    .is_ok()
}

/// 按备份还原系统代理（同步实现，供 disable/自愈/退出等无法 await 的路径复用）。
fn apply_backup(b: &ProxyBackup) {
    match b {
        #[cfg(target_os = "windows")]
        ProxyBackup::Windows {
            proxy_enable,
            proxy_server,
            proxy_override,
            applied_http_port,
        } => {
            apply_backup_windows(
                proxy_enable.as_deref(),
                proxy_server.as_deref(),
                proxy_override.as_deref(),
                *applied_http_port,
            );
        }
        #[cfg(target_os = "macos")]
        ProxyBackup::Macos { services, .. } => apply_backup_macos(services),
        #[cfg(target_os = "linux")]
        ProxyBackup::Linux { settings, .. } => apply_backup_linux(settings),
        #[allow(unreachable_patterns)]
        _ => {}
    }
}

/// 恢复被 FlowZ 遗留的系统代理设置。
/// - `force=false`（启动自愈）：仅当存在备份且代理端口无人监听时才恢复，
///   避免多实例场景下误关正在运行的代理。
/// - `force=true`（进程退出）：无视端口监听直接恢复，用于系统注销/重启兜底。
pub fn restore_stale_system_proxy(force: bool) {
    let Some(backup) = load_backup() else {
        return;
    };
    let running = backup.applied_http_port().map(port_listening).unwrap_or(false);
    if !force && running {
        return;
    }
    apply_backup(&backup);
    remove_backup();
}

// ---------------------------------------------------------------------------
// Windows: 注册表
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
impl SystemProxyManager {
    const REG_PATH: &'static str =
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

    async fn reg(&self, args: &[&str]) -> Result<String, String> {
        let mut cmd = Command::new("reg");
        cmd.args(args);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW，不弹控制台
        let out = cmd
            .output()
            .await
            .map_err(|e| format!("reg 执行失败: {}", e))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    async fn enable_windows(
        &mut self,
        address: &str,
        http_port: u32,
        socks_port: u32,
    ) -> Result<(), String> {
        // 仅在首次启用时保存原始设置，避免重复 enable 覆盖真正的原始值。
        // 备份存在即代表「FlowZ 可能正在占用系统代理」，异常退出后据此自愈。
        // 若当前系统代理已是 FlowZ 自己设置的（上次异常退出残留），不能把它当成
        // “原始值”保存，否则退出/自愈时会把残留代理“恢复”回去，导致永远关不掉。
        let raw_enable = reg_query_sync("ProxyEnable");
        let raw_server = reg_query_sync("ProxyServer");
        let raw_override = reg_query_sync("ProxyOverride");
        let enable_on = raw_enable
            .as_deref()
            .map(|v| v.contains("0x1") || v.trim() == "1")
            .unwrap_or(false);
        let self_leftover = enable_on
            && raw_server
                .as_deref()
                .map(|s| proxy_server_is_self(s, address, http_port))
                .unwrap_or(false);
        let created_backup = save_backup_if_absent(ProxyBackup::Windows {
            proxy_enable: if self_leftover {
                Some("0x0".to_string())
            } else {
                raw_enable
            },
            proxy_server: if self_leftover { None } else { raw_server },
            proxy_override: if self_leftover { None } else { raw_override },
            applied_http_port: Some(http_port as u16),
        });
        let proxy_server = format!(
            "http={0}:{1};https={0}:{1};socks={0}:{2}",
            address, http_port, socks_port
        );
        let proxy_override = "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>";
        let steps: Vec<Vec<String>> = vec![
            vec!["add".into(), Self::REG_PATH.into(), "/v".into(), "ProxyServer".into(), "/t".into(), "REG_SZ".into(), "/d".into(), proxy_server, "/f".into()],
            vec!["add".into(), Self::REG_PATH.into(), "/v".into(), "ProxyEnable".into(), "/t".into(), "REG_DWORD".into(), "/d".into(), "1".into(), "/f".into()],
            vec!["add".into(), Self::REG_PATH.into(), "/v".into(), "ProxyOverride".into(), "/t".into(), "REG_SZ".into(), "/d".into(), proxy_override.into(), "/f".into()],
        ];
        let mut last_err = String::new();
        for attempt in 0..3 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            let mut ok = true;
            for s in &steps {
                let args: Vec<&str> = s.iter().map(|x| x.as_str()).collect();
                if let Err(e) = self.reg(&args).await {
                    let m = e.to_lowercase();
                    last_err = e;
                    ok = false;
                    if m.contains("access denied") || m.contains("permission") {
                        break;
                    }
                    break;
                }
            }
            if ok {
                return Ok(());
            }
        }
        // 设置失败：若本次新建了备份则回滚并清除，避免下次启动误判
        if created_backup {
            if let Some(backup) = load_backup() {
                apply_backup(&backup);
            }
            remove_backup();
        }
        Err(format!("设置 Windows 系统代理失败: {}", last_err))
    }

    async fn disable_windows(&mut self) -> Result<(), String> {
        // 备份的还原由 disable_proxy 统一处理，这里只做无备份时的兜底关闭
        self.reg(&["add", Self::REG_PATH, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"])
            .await
            .map(|_| ())
            .map_err(|e| format!("禁用 Windows 系统代理失败: {}", e))
    }
}

/// 同步查询单个注册表值（供无法 await 的自愈/退出路径复用）。
/// 使用进程内 winreg，避免 spawn reg.exe：系统关机时无法创建新进程，
/// 反之外部进程失败且会弹出 0xc0000142 错误框。
#[cfg(target_os = "windows")]
fn reg_query_sync(name: &str) -> Option<String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let subkey = SystemProxyManager::REG_PATH
        .strip_prefix("HKCU\\")
        .unwrap_or(SystemProxyManager::REG_PATH);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu.open_subkey(subkey).ok()?;
    if let Ok(s) = key.get_value::<String, _>(name) {
        return Some(s);
    }
    if let Ok(d) = key.get_value::<u32, _>(name) {
        return Some(format!("0x{:x}", d));
    }
    None
}

/// 同步写入单个注册表值（进程内 winreg，理由同 `reg_query_sync`）。
#[cfg(target_os = "windows")]
fn reg_add_sync(name: &str, ty: &str, value: &str) -> bool {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};

    let subkey = SystemProxyManager::REG_PATH
        .strip_prefix("HKCU\\")
        .unwrap_or(SystemProxyManager::REG_PATH);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey_with_flags(subkey, KEY_SET_VALUE) else {
        return false;
    };
    if ty == "REG_DWORD" {
        let s = value.trim();
        let v: u32 = match s.strip_prefix("0x") {
            Some(hex) => u32::from_str_radix(hex, 16).unwrap_or(0),
            None => s.parse().unwrap_or(0),
        };
        key.set_value(name, &v).is_ok()
    } else {
        key.set_value(name, &value.to_string()).is_ok()
    }
}

/// 判断系统代理服务器串是否指向 FlowZ 自己的本地监听地址。
/// 用于识别“上次异常退出残留的自有代理”，避免把它误当成用户原始设置保存/恢复。
#[allow(dead_code)]
fn proxy_server_is_self(server: &str, address: &str, http_port: u32) -> bool {
    server.contains(&format!("{}:{}", address, http_port))
}

#[cfg(target_os = "windows")]
fn apply_backup_windows(
    proxy_enable: Option<&str>,
    proxy_server: Option<&str>,
    proxy_override: Option<&str>,
    applied_http_port: Option<u16>,
) {
    // 防御：备份里的“原始值”若其实是 FlowZ 自己设置的残留代理（异常退出时被误当成原始值捕获），
    // 恢复它只会把代理重新指回本机已停端口导致断网，此时直接关闭代理。
    let enable_on = proxy_enable
        .map(|v| v.contains("0x1") || v.trim() == "1")
        .unwrap_or(false);
    let is_self = enable_on
        && match (applied_http_port, proxy_server) {
            (Some(p), Some(s)) => proxy_server_is_self(s, "127.0.0.1", p as u32),
            _ => false,
        };
    if is_self {
        let _ = reg_add_sync("ProxyEnable", "REG_DWORD", "0");
        return;
    }
    if let Some(pe) = proxy_enable {
        let enabled = pe.contains("0x1") || pe.trim() == "1";
        let _ = reg_add_sync("ProxyEnable", "REG_DWORD", if enabled { "1" } else { "0" });
    }
    if let Some(ps) = proxy_server {
        if !ps.is_empty() {
            let _ = reg_add_sync("ProxyServer", "REG_SZ", ps);
        }
    }
    if let Some(po) = proxy_override {
        if !po.is_empty() {
            let _ = reg_add_sync("ProxyOverride", "REG_SZ", po);
        }
    }
}

// ---------------------------------------------------------------------------
// macOS: networksetup（直接移植，未在沙箱实测）
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
impl SystemProxyManager {
    async fn ns(&self, args: &[&str]) -> Result<String, String> {
        let out = Command::new("networksetup")
            .args(args)
            .output()
            .await
            .map_err(|e| format!("networksetup 执行失败: {}", e))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    async fn network_services(&self) -> Result<Vec<String>, String> {
        let out = self.ns(&["-listallnetworkservices"]).await?;
        Ok(out
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with('*'))
            .collect())
    }

    async fn enable_macos(
        &mut self,
        address: &str,
        http_port: u32,
        socks_port: u32,
    ) -> Result<(), String> {
        // 首次启用保存原始设置，异常退出后自愈用
        let created_backup = save_backup_if_absent(ProxyBackup::Macos {
            services: capture_macos_backup(),
            applied_http_port: Some(http_port as u16),
        });

        let port = http_port.to_string();
        let sport = socks_port.to_string();
        let result: Result<(), String> = async {
            let services = self.network_services().await?;
            for svc in &services {
                self.ns(&["-setwebproxy", svc, address, &port]).await?;
                self.ns(&["-setwebproxystate", svc, "on"]).await?;
                self.ns(&["-setsecurewebproxy", svc, address, &port]).await?;
                self.ns(&["-setsecurewebproxystate", svc, "on"]).await?;
                self.ns(&["-setsocksfirewallproxy", svc, address, &sport]).await?;
                self.ns(&["-setsocksfirewallproxystate", svc, "on"]).await?;
            }
            Ok(())
        }
        .await;

        if let Err(e) = result {
            if created_backup {
                if let Some(backup) = load_backup() {
                    apply_backup(&backup);
                }
                remove_backup();
            }
            return Err(format!("设置 macOS 系统代理失败: {}", e));
        }
        Ok(())
    }

    async fn disable_macos(&mut self) -> Result<(), String> {
        // 备份的还原由 disable_proxy 统一处理，这里只做无备份时的兜底关闭
        let services = self.network_services().await?;
        for svc in &services {
            self.ns(&["-setwebproxystate", svc, "off"]).await?;
            self.ns(&["-setsecurewebproxystate", svc, "off"]).await?;
            self.ns(&["-setsocksfirewallproxystate", svc, "off"]).await?;
        }
        Ok(())
    }
}

/// 同步执行 networksetup（供无法 await 的自愈/退出路径复用）。
#[cfg(target_os = "macos")]
fn ns_sync(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("networksetup")
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(target_os = "macos")]
fn macos_services_sync() -> Vec<String> {
    ns_sync(&["-listallnetworkservices"])
        .map(|out| {
            out.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty() && !l.starts_with('*'))
                .collect()
        })
        .unwrap_or_default()
}

/// 解析 networksetup -get*proxy 输出：返回（是否启用, 服务器, 端口）。
#[cfg(target_os = "macos")]
fn parse_proxy_block(out: &str) -> (bool, String, u16) {
    let mut enabled = false;
    let mut server = String::new();
    let mut port = 0u16;
    for line in out.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("Enabled:") {
            enabled = v.trim().eq_ignore_ascii_case("yes");
        } else if let Some(v) = line.strip_prefix("Server:") {
            server = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("Port:") {
            port = v.trim().parse().unwrap_or(0);
        }
    }
    (enabled, server, port)
}

#[cfg(target_os = "macos")]
fn capture_macos_backup() -> Vec<MacServiceBackup> {
    let mut result = Vec::new();
    for service in macos_services_sync() {
        let web = ns_sync(&["-getwebproxy", &service])
            .map(|o| parse_proxy_block(&o))
            .unwrap_or((false, String::new(), 0));
        let secure = ns_sync(&["-getsecurewebproxy", &service])
            .map(|o| parse_proxy_block(&o))
            .unwrap_or((false, String::new(), 0));
        let socks = ns_sync(&["-getsocksfirewallproxy", &service])
            .map(|o| parse_proxy_block(&o))
            .unwrap_or((false, String::new(), 0));
        let bypass_domains = ns_sync(&["-getproxybypassdomains", &service])
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        result.push(MacServiceBackup {
            service,
            web_enabled: web.0,
            web_server: web.1,
            web_port: web.2,
            secure_enabled: secure.0,
            secure_server: secure.1,
            secure_port: secure.2,
            socks_enabled: socks.0,
            socks_server: socks.1,
            socks_port: socks.2,
            bypass_domains,
        });
    }
    result
}

#[cfg(target_os = "macos")]
fn restore_ns_proxy(service: &str, kind: &str, enabled: bool, server: &str, port: u16) {
    let set_cmd = format!("-set{}proxy", kind);
    let state_cmd = format!("-set{}proxystate", kind);
    let port_s = port.to_string();
    if enabled && !server.is_empty() && port > 0 {
        let _ = ns_sync(&[set_cmd.as_str(), service, server, port_s.as_str()]);
        let _ = ns_sync(&[state_cmd.as_str(), service, "on"]);
    } else {
        let _ = ns_sync(&[state_cmd.as_str(), service, "off"]);
    }
}

#[cfg(target_os = "macos")]
fn apply_backup_macos(services: &[MacServiceBackup]) {
    for s in services {
        restore_ns_proxy(&s.service, "web", s.web_enabled, &s.web_server, s.web_port);
        restore_ns_proxy(&s.service, "secureweb", s.secure_enabled, &s.secure_server, s.secure_port);
        restore_ns_proxy(&s.service, "socksfirewall", s.socks_enabled, &s.socks_server, s.socks_port);
        if !s.bypass_domains.is_empty() {
            let mut args: Vec<String> =
                vec!["-setproxybypassdomains".to_string(), s.service.clone()];
            args.extend(s.bypass_domains.split_whitespace().map(|d| d.to_string()));
            let refs: Vec<&str> = args.iter().map(|a| a.as_str()).collect();
            let _ = ns_sync(&refs);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn sh_quote_escapes() {
        assert_eq!(
            SystemProxyManager::sh_quote("a'b"),
            "'a'\\''b'"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unquote_strips() {
        assert_eq!(SystemProxyManager::unquote("'manual'"), "manual");
        assert_eq!(SystemProxyManager::unquote("none"), "none");
    }

    #[tokio::test]
    async fn status_without_gsettings_is_disabled() {
        // 沙箱有 gsettings 但无 dbus 会话：get 失败 → enabled=false，不抛错
        let m = SystemProxyManager::new();
        let st = m.get_proxy_status().await;
        // 不断言具体值（环境相关），只保证不 panic
        let _ = st.enabled;
    }

    #[test]
    fn detects_self_proxy_residue() {
        let flowz = "http=127.0.0.1:65533;https=127.0.0.1:65533;socks=127.0.0.1:65534";
        assert!(proxy_server_is_self(flowz, "127.0.0.1", 65533));
        assert!(proxy_server_is_self(flowz, "127.0.0.1", 65534));
        assert!(!proxy_server_is_self(flowz, "127.0.0.1", 7890));
        assert!(!proxy_server_is_self("http=corp:8080", "127.0.0.1", 65533));
    }
}
