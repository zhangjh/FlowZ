//! SubscriptionService 移植（对应 `src/main/services/SubscriptionService.ts`）。
//!
//! 从订阅 URL 拉取内容（http/https，20s 超时，跟随重定向），
//! 以及订阅文本的 base64/base64url 自动识别解码。

use base64::{engine::general_purpose::STANDARD as B64, Engine};

/// 解码后的订阅内容
#[derive(Debug)]
pub struct SubscriptionContent {
    pub text: String,
    pub decoded_from_base64: bool,
}

/// 解码订阅文本。
/// 优先按 UTF-8 明文处理；若内容不含 "://"，再尝试 base64/base64url 解码
/// （去掉空白、兼容无填充），解码后含协议链接才算成功。
pub fn decode_subscription_text(text: &str) -> SubscriptionContent {
    let raw = text.trim();

    // 内容里已经包含协议链接，直接按明文处理
    if raw.contains("://") {
        return SubscriptionContent {
            text: raw.to_string(),
            decoded_from_base64: false,
        };
    }

    // 尝试 base64 / base64url 解码
    let compact: String = raw
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    let looks_b64 = !compact.is_empty()
        && compact.len() >= 8
        && compact
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=');
    if looks_b64 {
        // Node 的 Buffer.from(x, 'base64') 容忍缺失的 padding，这里手动补齐
        let mut padded = compact;
        while padded.len() % 4 != 0 {
            padded.push('=');
        }
        if let Ok(decoded) = B64.decode(&padded) {
            if let Ok(s) = String::from_utf8(decoded) {
                if s.contains("://") {
                    return SubscriptionContent {
                        text: s.trim().to_string(),
                        decoded_from_base64: true,
                    };
                }
            }
        }
    }

    SubscriptionContent {
        text: raw.to_string(),
        decoded_from_base64: false,
    }
}

/// 通过 URL 拉取订阅内容（对应 fetchSubscriptionContent）。
pub async fn fetch_subscription_content(
    url: &str,
    timeout_ms: u64,
) -> Result<SubscriptionContent, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("无效的订阅 URL: {}", e))?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("仅支持 http/https 订阅链接".to_string()),
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        // TS 显式要求明文响应（Accept-Encoding: identity），避免收到压缩报文；
        // reqwest 默认不启用解压特性，这里同样只声明 identity。
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .get(url)
        .header("User-Agent", "FlowZ/subscription")
        .header("Accept", "*/*")
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "订阅请求超时".to_string()
            } else {
                format!("订阅请求失败: {}", e)
            }
        })?;

    let status = resp.status();
    if !(200..300).contains(&status.as_u16()) {
        return Err(format!("订阅请求失败: HTTP {}", status.as_u16()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取订阅响应失败: {}", e))?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(decode_subscription_text(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_passthrough() {
        let c = decode_subscription_text("vless://u@h:443\ntrojan://p@h:443");
        assert!(!c.decoded_from_base64);
        assert!(c.text.contains("vless://"));
    }

    #[test]
    fn base64_roundtrip() {
        let plain = "vless://uuid123@host.example:443#node1\n";
        let encoded = B64.encode(plain);
        let c = decode_subscription_text(&encoded);
        assert!(c.decoded_from_base64);
        assert!(c.text.contains("vless://"));
    }

    #[test]
    fn base64url_no_padding() {
        let plain = "trojan://pw@host:443#n";
        let encoded: String = B64
            .encode(plain)
            .replace('+', "-")
            .replace('/', "_")
            .trim_end_matches('=')
            .to_string();
        let c = decode_subscription_text(&encoded);
        assert!(c.decoded_from_base64);
    }

    #[test]
    fn garbage_stays_plaintext() {
        let c = decode_subscription_text("hello world");
        assert!(!c.decoded_from_base64);
        assert_eq!(c.text, "hello world");
    }

    #[test]
    fn rejects_non_http_scheme() {
        let err = tauri::async_runtime::block_on(fetch_subscription_content("ftp://x/y", 1000))
            .unwrap_err();
        assert!(err.contains("http/https"));
    }
}
