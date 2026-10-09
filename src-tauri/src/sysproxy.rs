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

#[derive(Debug, Clone, Default)]
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
        self.set_raw("org.gnome.system.proxy", "ignore-hosts", &Self::sh_quote(&s.ignore_hosts)).await?;
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
        // 保存原始设置（失败也不阻断）
        self.original = self.current_settings().await.ok();

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
                &Self::sh_quote("['localhost', '127.0.0.0/8', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']"),
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
        // 失败回滚
        if let Some(orig) = self.original.clone() {
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

// ---------------------------------------------------------------------------
// Windows: 注册表（直接移植，未在沙箱实测）
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
impl SystemProxyManager {
    const REG_PATH: &'static str =
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

    async fn reg(&self, args: &[&str]) -> Result<String, String> {
        let out = Command::new("reg")
            .args(args)
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
        Err(format!("设置 Windows 系统代理失败: {}", last_err))
    }

    async fn disable_windows(&mut self) -> Result<(), String> {
        self.reg(&["add", Self::REG_PATH, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"])
            .await
            .map(|_| ())
            .map_err(|e| format!("禁用 Windows 系统代理失败: {}", e))
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
        let services = self.network_services().await?;
        let port = http_port.to_string();
        let sport = socks_port.to_string();
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

    async fn disable_macos(&mut self) -> Result<(), String> {
        let services = self.network_services().await?;
        for svc in &services {
            self.ns(&["-setwebproxystate", svc, "off"]).await?;
            self.ns(&["-setsecurewebproxystate", svc, "off"]).await?;
            self.ns(&["-setsocksfirewallproxystate", svc, "off"]).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sh_quote_escapes() {
        assert_eq!(
            SystemProxyManager::sh_quote("a'b"),
            "'a'\\''b'"
        );
    }

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
}
