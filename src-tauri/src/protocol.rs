//! ProtocolParser 移植（对应 `src/main/services/ProtocolParser.ts`）。
//!
//! 解析 vless:// / trojan:// / hysteria2://（hy2:// 别名）协议链接，
//! 以及把 ServerConfig 生成回分享链接。query 参数语义与 TS 的
//! URLSearchParams 对齐（`+` 为空格、取首个值、空值视为缺省）。

use crate::config::{
    GrpcSettings, Hysteria2Network, Hysteria2ObfsSettings, Hysteria2Settings, HttpSettings,
    Network, Protocol, RealitySettings, Security, ServerConfig, TlsSettings, WebSocketSettings,
};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use std::collections::HashMap;
use url::Url;
use uuid::Uuid;

/// encodeURIComponent 等价集合：只保留 A-Za-z0-9 和 -_.!~*'()
const ENCODE_URI_COMPONENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

fn encode_uri_component(s: &str) -> String {
    utf8_percent_encode(s, ENCODE_URI_COMPONENT).to_string()
}

fn decode_uri_component(s: &str) -> Result<String, String> {
    percent_decode_str(s)
        .decode_utf8()
        .map(|c| c.into_owned())
        .map_err(|e| format!("URL 解码失败: {}", e))
}

pub fn is_supported(url: &str) -> bool {
    url.starts_with("vless://")
        || url.starts_with("trojan://")
        || url.starts_with("hysteria2://")
        || url.starts_with("hy2://")
}

/// 批量解析订阅文本：过滤空行/# 注释/非协议行，单行失败跳过不影响其他行
pub fn parse_many(text: &str) -> Vec<ServerConfig> {
    if text.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    for line in text.split(|c| c == '\n' || c == '\r') {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || !is_supported(line) {
            continue;
        }
        if let Ok(cfg) = parse_url(line) {
            out.push(cfg);
        }
    }
    out
}

pub fn parse_url(raw: &str) -> Result<ServerConfig, String> {
    if !is_supported(raw) {
        let scheme = raw.split("://").next().unwrap_or(raw);
        return Err(format!("不支持的协议: {}", scheme));
    }
    let url = Url::parse(raw).map_err(|e| format!("URL 解析失败: {}", e))?;
    let scheme = url.scheme();
    // hy2 是 hysteria2 的别名
    let protocol = match scheme {
        "vless" => Protocol::Vless,
        "trojan" => Protocol::Trojan,
        "hysteria2" | "hy2" => Protocol::Hysteria2,
        other => return Err(format!("不支持的协议: {}", other)),
    };

    let address = url
        .host_str()
        .ok_or_else(|| "URL 解析失败: 缺少地址".to_string())?
        .to_string();
    let port = url.port().unwrap_or(443) as u32;
    // 原始 query 键值对（保持出现顺序、保留空值），供 get()/has() 使用
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let name = match url.fragment() {
        Some(f) if !f.is_empty() => decode_uri_component(f)?,
        _ => format!("{}:{}", address, port),
    };

    match protocol {
        Protocol::Vless => parse_vless(&url, &address, port, &name, &pairs),
        Protocol::Trojan => parse_trojan(&url, &address, port, &name, &pairs),
        Protocol::Hysteria2 => parse_hysteria2(&url, &address, port, &name, &pairs),
    }
}

/// 取首个同名参数；空值视为缺失（对应 TS 的 `params.get(k) || default` 语义）
fn qp_get(pairs: &[(String, String)], key: &str) -> Option<String> {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .filter(|v| !v.is_empty())
}

/// key 是否出现过（含空值），用于 allowInsecure 这类"出现即有意义"的参数
fn qp_has(pairs: &[(String, String)], key: &str) -> bool {
    pairs.iter().any(|(k, _)| k == key)
}

fn parse_vless(
    _url: &Url,
    address: &str,
    port: u32,
    name: &str,
    pairs: &[(String, String)],
) -> Result<ServerConfig, String> {
    // TS 用原始（未解码）的 username 做 uuid
    let uuid = _url.username();
    if uuid.is_empty() {
        return Err("URL 解析失败: VLESS URL 缺少 UUID".into());
    }
    let mut cfg = ServerConfig {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        protocol: Protocol::Vless,
        address: address.to_string(),
        port,
        uuid: Some(uuid.to_string()),
        encryption: Some(qp_get(pairs, "encryption").unwrap_or_else(|| "none".to_string())),
        flow: qp_get(pairs, "flow"),
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
    };
    if let Some(network) = qp_get(pairs, "type") {
        let net: Network = network
            .parse()
            .map_err(|_| format!("URL 解析失败: 不支持的传输层类型: {}", network))?;
        parse_transport_settings(&mut cfg, pairs, net)?;
        cfg.network = Some(net);
    }
    if let Some(security) = qp_get(pairs, "security") {
        let sec: Security = security
            .parse()
            .map_err(|e| format!("URL 解析失败: {}", e))?;
        if sec == Security::Tls || sec == Security::Reality {
            cfg.tls_settings = Some(parse_tls_settings(pairs));
        }
        if sec == Security::Reality {
            cfg.reality_settings = parse_reality_settings(pairs);
        }
        cfg.security = Some(sec);
    }
    Ok(cfg)
}

fn parse_trojan(
    url: &Url,
    address: &str,
    port: u32,
    name: &str,
    pairs: &[(String, String)],
) -> Result<ServerConfig, String> {
    // TS: decodeURIComponent(url.username)
    let password = decode_uri_component(url.username())
        .map_err(|e| format!("URL 解析失败: {}", e))?;
    if password.is_empty() {
        return Err("URL 解析失败: Trojan URL 缺少密码".into());
    }
    let mut cfg = ServerConfig {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        protocol: Protocol::Trojan,
        address: address.to_string(),
        port,
        uuid: None,
        encryption: None,
        flow: None,
        password: Some(password),
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
    };
    if let Some(network) = qp_get(pairs, "type") {
        let net: Network = network
            .parse()
            .map_err(|_| format!("URL 解析失败: 不支持的传输层类型: {}", network))?;
        parse_transport_settings(&mut cfg, pairs, net)?;
        cfg.network = Some(net);
    }
    if let Some(security) = qp_get(pairs, "security") {
        let sec: Security = security
            .parse()
            .map_err(|e| format!("URL 解析失败: {}", e))?;
        if sec == Security::Tls || sec == Security::Reality {
            cfg.tls_settings = Some(parse_tls_settings(pairs));
        }
        if sec == Security::Reality {
            cfg.reality_settings = parse_reality_settings(pairs);
        }
        cfg.security = Some(sec);
    }
    Ok(cfg)
}

fn parse_hysteria2(
    url: &Url,
    address: &str,
    port: u32,
    name: &str,
    pairs: &[(String, String)],
) -> Result<ServerConfig, String> {
    let password = decode_uri_component(url.username())
        .map_err(|e| format!("URL 解析失败: {}", e))?;
    if password.is_empty() {
        return Err("URL 解析失败: Hysteria2 URL 缺少密码".into());
    }
    let mut cfg = ServerConfig {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        protocol: Protocol::Hysteria2,
        address: address.to_string(),
        port,
        uuid: None,
        encryption: None,
        flow: None,
        password: Some(password),
        hysteria2_settings: None,
        network: None,
        // Hysteria2 协议必须使用 TLS（与 TS 一致）
        security: Some(Security::Tls),
        tls_settings: None,
        reality_settings: None,
        ws_settings: None,
        grpc_settings: None,
        http_settings: None,
        group_id: None,
        created_at: None,
        updated_at: None,
    };

    let mut hs = Hysteria2Settings {
        up_mbps: None,
        down_mbps: None,
        obfs: None,
        network: None,
        server_ports: None,
        hop_interval: None,
        hop_interval_max: None,
        bbr_profile: None,
        disable_chrome_parrot: None,
    };
    let mut has_hs = false;
    if let Some(v) = qp_get(pairs, "up_mbps").or_else(|| qp_get(pairs, "up")) {
        if let Ok(n) = v.parse::<u32>() {
            hs.up_mbps = Some(n);
            has_hs = true;
        }
    }
    if let Some(v) = qp_get(pairs, "down_mbps").or_else(|| qp_get(pairs, "down")) {
        if let Ok(n) = v.parse::<u32>() {
            hs.down_mbps = Some(n);
            has_hs = true;
        }
    }
    if let Some(obfs) = qp_get(pairs, "obfs") {
        if (obfs == "salamander" || obfs == "gecko") && qp_get(pairs, "obfs-password").is_some() {
            hs.obfs = Some(Hysteria2ObfsSettings {
                obfs_type: Some(obfs),
                password: qp_get(pairs, "obfs-password"),
                min_packet_size: None,
                max_packet_size: None,
            });
            has_hs = true;
        }
    }
    if let Some(network) = qp_get(pairs, "network") {
        if let Ok(net) = network.parse::<Hysteria2Network>() {
            hs.network = Some(net);
            has_hs = true;
        }
    }
    if has_hs {
        cfg.hysteria2_settings = Some(hs);
    }

    let mut tls = TlsSettings {
        server_name: None,
        allow_insecure: None,
        alpn: None,
        fingerprint: None,
    };
    let mut has_tls = false;
    if let Some(sni) = qp_get(pairs, "sni").or_else(|| qp_get(pairs, "peer")) {
        tls.server_name = Some(sni);
        has_tls = true;
    }
    if let Some(insecure) = qp_get(pairs, "insecure").or_else(|| qp_get(pairs, "allowInsecure")) {
        if insecure == "1" || insecure == "true" {
            tls.allow_insecure = Some(true);
            has_tls = true;
        }
    }
    if let Some(alpn) = qp_get(pairs, "alpn") {
        tls.alpn = Some(alpn.split(',').map(|s| s.to_string()).collect());
        has_tls = true;
    }
    if has_tls {
        cfg.tls_settings = Some(tls);
    }

    Ok(cfg)
}

fn parse_transport_settings(
    cfg: &mut ServerConfig,
    pairs: &[(String, String)],
    network: Network,
) -> Result<(), String> {
    match network {
        Network::Ws => {
            let mut ws = WebSocketSettings {
                path: None,
                headers: None,
                max_early_data: None,
                early_data_header_name: None,
            };
            if let Some(path) = qp_get(pairs, "path") {
                ws.path = Some(path);
            }
            if let Some(host) = qp_get(pairs, "host") {
                let mut headers = HashMap::new();
                headers.insert("Host".to_string(), host);
                ws.headers = Some(headers);
            }
            if let Some(v) = qp_get(pairs, "maxEarlyData") {
                ws.max_early_data = v.parse::<u32>().ok();
            }
            if let Some(v) = qp_get(pairs, "earlyDataHeaderName") {
                ws.early_data_header_name = Some(v);
            }
            cfg.ws_settings = Some(ws);
        }
        Network::Grpc => {
            let mut grpc = GrpcSettings {
                service_name: None,
                multi_mode: None,
            };
            if let Some(v) = qp_get(pairs, "serviceName") {
                grpc.service_name = Some(v);
            }
            if qp_get(pairs, "mode").as_deref() == Some("multi") {
                grpc.multi_mode = Some(true);
            }
            cfg.grpc_settings = Some(grpc);
        }
        Network::Http => {
            let mut http = HttpSettings {
                host: None,
                path: None,
                method: None,
                headers: None,
            };
            if let Some(v) = qp_get(pairs, "host") {
                http.host = Some(v.split(',').map(|s| s.to_string()).collect());
            }
            if let Some(v) = qp_get(pairs, "path") {
                http.path = Some(v);
            }
            if let Some(v) = qp_get(pairs, "method") {
                http.method = Some(v);
            }
            cfg.http_settings = Some(http);
        }
        Network::Tcp => {}
    }
    Ok(())
}

fn parse_tls_settings(pairs: &[(String, String)]) -> TlsSettings {
    let mut tls = TlsSettings {
        server_name: None,
        allow_insecure: None,
        alpn: None,
        fingerprint: None,
    };
    if let Some(sni) = qp_get(pairs, "sni").or_else(|| qp_get(pairs, "host")) {
        tls.server_name = Some(sni);
    }
    // TS 语义：allowInsecure 键出现即设置（即使值为空/"0" 也设为 false）
    if qp_has(pairs, "allowInsecure") {
        let v = qp_get(pairs, "allowInsecure").unwrap_or_default();
        tls.allow_insecure = Some(v == "1" || v == "true");
    }
    if let Some(alpn) = qp_get(pairs, "alpn") {
        tls.alpn = Some(alpn.split(',').map(|s| s.to_string()).collect());
    }
    if let Some(fp) = qp_get(pairs, "fp").or_else(|| qp_get(pairs, "fingerprint")) {
        tls.fingerprint = Some(fp);
    }
    tls
}

fn parse_reality_settings(pairs: &[(String, String)]) -> Option<RealitySettings> {
    let public_key = qp_get(pairs, "pbk")?;
    Some(RealitySettings {
        public_key,
        short_id: qp_get(pairs, "sid"),
    })
}

// ---------------------------------------------------------------------------
// 生成分享链接（对应 generateUrl）
// ---------------------------------------------------------------------------

pub fn generate_url(cfg: &ServerConfig) -> Result<String, String> {
    match cfg.protocol {
        Protocol::Vless => Ok(generate_vless_url(cfg)),
        Protocol::Trojan => Ok(generate_trojan_url(cfg)),
        Protocol::Hysteria2 => Ok(generate_hysteria2_url(cfg)),
    }
}

fn query_string(pairs: &[(String, String)]) -> String {
    if pairs.is_empty() {
        return String::new();
    }
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        ser.append_pair(k, v);
    }
    format!("?{}", ser.finish())
}

fn append_transport_params(out: &mut Vec<(String, String)>, cfg: &ServerConfig) {
    if let Some(net) = &cfg.network {
        out.push(("type".into(), net.to_string()));
    }
    if cfg.network == Some(Network::Ws) {
        if let Some(ws) = &cfg.ws_settings {
            if let Some(p) = &ws.path {
                out.push(("path".into(), p.clone()));
            }
            if let Some(host) = ws.headers.as_ref().and_then(|h| h.get("Host")) {
                out.push(("host".into(), host.clone()));
            }
            if let Some(n) = ws.max_early_data {
                out.push(("maxEarlyData".into(), n.to_string()));
            }
            if let Some(v) = &ws.early_data_header_name {
                out.push(("earlyDataHeaderName".into(), v.clone()));
            }
        }
    }
    if cfg.network == Some(Network::Grpc) {
        if let Some(g) = &cfg.grpc_settings {
            if let Some(v) = &g.service_name {
                out.push(("serviceName".into(), v.clone()));
            }
            if g.multi_mode == Some(true) {
                out.push(("mode".into(), "multi".into()));
            }
        }
    }
    if cfg.network == Some(Network::Http) {
        if let Some(h) = &cfg.http_settings {
            if let Some(host) = &h.host {
                out.push(("host".into(), host.join(",")));
            }
            if let Some(p) = &h.path {
                out.push(("path".into(), p.clone()));
            }
            if let Some(m) = &h.method {
                out.push(("method".into(), m.clone()));
            }
        }
    }
}

fn append_security_params(out: &mut Vec<(String, String)>, cfg: &ServerConfig) {
    if let Some(sec) = &cfg.security {
        out.push(("security".into(), sec.to_string()));
    }
    if let Some(tls) = &cfg.tls_settings {
        if let Some(v) = &tls.server_name {
            out.push(("sni".into(), v.clone()));
        }
        if tls.allow_insecure == Some(true) {
            out.push(("allowInsecure".into(), "1".into()));
        }
        if let Some(alpn) = &tls.alpn {
            if !alpn.is_empty() {
                out.push(("alpn".into(), alpn.join(",")));
            }
        }
        if let Some(fp) = &tls.fingerprint {
            out.push(("fp".into(), fp.clone()));
        }
    }
    if cfg.security == Some(Security::Reality) {
        if let Some(r) = &cfg.reality_settings {
            out.push(("pbk".into(), r.public_key.clone()));
            if let Some(sid) = &r.short_id {
                out.push(("sid".into(), sid.clone()));
            }
        }
    }
}

fn generate_vless_url(cfg: &ServerConfig) -> String {
    let mut q = Vec::new();
    if let Some(e) = &cfg.encryption {
        q.push(("encryption".into(), e.clone()));
    }
    if let Some(f) = &cfg.flow {
        q.push(("flow".into(), f.clone()));
    }
    append_transport_params(&mut q, cfg);
    append_security_params(&mut q, cfg);
    let name = encode_uri_component(&cfg.name);
    format!(
        "vless://{}@{}:{}{}#{}",
        cfg.uuid.as_deref().unwrap_or(""),
        cfg.address,
        cfg.port,
        query_string(&q),
        name
    )
}

fn generate_trojan_url(cfg: &ServerConfig) -> String {
    let mut q = Vec::new();
    append_transport_params(&mut q, cfg);
    append_security_params(&mut q, cfg);
    let name = encode_uri_component(&cfg.name);
    let password = encode_uri_component(cfg.password.as_deref().unwrap_or(""));
    format!(
        "trojan://{}@{}:{}{}#{}",
        password,
        cfg.address,
        cfg.port,
        query_string(&q),
        name
    )
}

fn generate_hysteria2_url(cfg: &ServerConfig) -> String {
    let mut q = Vec::new();
    if let Some(hs) = &cfg.hysteria2_settings {
        if let Some(n) = hs.up_mbps {
            q.push(("up_mbps".into(), n.to_string()));
        }
        if let Some(n) = hs.down_mbps {
            q.push(("down_mbps".into(), n.to_string()));
        }
        if let Some(obfs) = &hs.obfs {
            q.push((
                "obfs".into(),
                obfs.obfs_type.clone().unwrap_or_else(|| "salamander".into()),
            ));
            if let Some(pw) = &obfs.password {
                q.push(("obfs-password".into(), pw.clone()));
            }
        }
        if let Some(net) = &hs.network {
            q.push(("network".into(), net.to_string()));
        }
    }
    if let Some(tls) = &cfg.tls_settings {
        if let Some(v) = &tls.server_name {
            q.push(("sni".into(), v.clone()));
        }
        if tls.allow_insecure == Some(true) {
            q.push(("insecure".into(), "1".into()));
        }
        if let Some(alpn) = &tls.alpn {
            if !alpn.is_empty() {
                q.push(("alpn".into(), alpn.join(",")));
            }
        }
    }
    let name = encode_uri_component(&cfg.name);
    let password = encode_uri_component(cfg.password.as_deref().unwrap_or(""));
    format!(
        "hysteria2://{}@{}:{}{}#{}",
        password,
        cfg.address,
        cfg.port,
        query_string(&q),
        name
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_vless_ws_tls() {
        let url = "vless://11111111-2222-4333-8444-555555555555@example.com:443?encryption=none&security=tls&sni=example.com&type=ws&path=%2Fws&host=example.com#%E6%B5%8B%E8%AF%95";
        let cfg = parse_url(url).unwrap();
        assert_eq!(cfg.protocol, Protocol::Vless);
        assert_eq!(cfg.uuid.as_deref(), Some("11111111-2222-4333-8444-555555555555"));
        assert_eq!(cfg.address, "example.com");
        assert_eq!(cfg.port, 443);
        assert_eq!(cfg.name, "测试");
        assert_eq!(cfg.network, Some(Network::Ws));
        assert_eq!(cfg.ws_settings.as_ref().unwrap().path.as_deref(), Some("/ws"));
        assert_eq!(cfg.security, Some(Security::Tls));
        assert_eq!(
            cfg.tls_settings.as_ref().unwrap().server_name.as_deref(),
            Some("example.com")
        );
        // round-trip
        let gen = generate_url(&cfg).unwrap();
        let cfg2 = parse_url(&gen).unwrap();
        assert_eq!(cfg2.uuid, cfg.uuid);
        assert_eq!(cfg2.name, cfg.name);
        assert_eq!(cfg2.ws_settings, cfg.ws_settings);
    }

    #[test]
    fn parse_trojan_encoded_password() {
        let url = "trojan://p%40ss%3Aword@example.com:443?security=tls&sni=example.com#srv";
        let cfg = parse_url(url).unwrap();
        assert_eq!(cfg.protocol, Protocol::Trojan);
        assert_eq!(cfg.password.as_deref(), Some("p@ss:word"));
        assert_eq!(cfg.name, "srv");
    }

    #[test]
    fn parse_hysteria2_full() {
        let url = "hysteria2://secret@example.com:8443?obfs=salamander&obfs-password=obfspw&sni=example.com&insecure=1&up_mbps=100&down_mbps=200#hy2";
        let cfg = parse_url(url).unwrap();
        assert_eq!(cfg.protocol, Protocol::Hysteria2);
        assert_eq!(cfg.security, Some(Security::Tls));
        let hs = cfg.hysteria2_settings.as_ref().unwrap();
        assert_eq!(hs.up_mbps, Some(100));
        assert_eq!(hs.down_mbps, Some(200));
        assert_eq!(hs.obfs.as_ref().unwrap().obfs_type.as_deref(), Some("salamander"));
        assert_eq!(hs.obfs.as_ref().unwrap().password.as_deref(), Some("obfspw"));
        assert_eq!(cfg.tls_settings.as_ref().unwrap().allow_insecure, Some(true));
        let gen = generate_url(&cfg).unwrap();
        assert!(gen.starts_with("hysteria2://"));
        let cfg2 = parse_url(&gen).unwrap();
        assert_eq!(cfg2.password, cfg.password);
    }

    #[test]
    fn parse_reality() {
        let url = "vless://uuid@example.com:443?encryption=none&security=reality&pbk=PUBKEY123&sid=abcd&sni=example.com&fp=chrome#r";
        let cfg = parse_url(url).unwrap();
        assert_eq!(cfg.security, Some(Security::Reality));
        let r = cfg.reality_settings.as_ref().unwrap();
        assert_eq!(r.public_key, "PUBKEY123");
        assert_eq!(r.short_id.as_deref(), Some("abcd"));
    }

    #[test]
    fn parse_many_skips_bad_lines() {
        let text = "# comment\n\nvless://u@a.com:443\nnot-a-url\ntrojan://pw@b.com:443#x\n";
        let servers = parse_many(text);
        assert_eq!(servers.len(), 2);
    }

    #[test]
    fn rejects_unsupported_and_missing_uuid() {
        assert!(parse_url("ss://abc@x.com:1").is_err());
        assert!(parse_url("vless://@example.com:443").is_err());
        assert!(parse_url("trojan://@example.com:443").is_err());
    }

    #[test]
    fn default_port_443() {
        let cfg = parse_url("trojan://pw@example.com#x").unwrap();
        assert_eq!(cfg.port, 443);
    }
}
