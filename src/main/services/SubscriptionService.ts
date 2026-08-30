/**
 * 订阅服务
 * 负责从订阅 URL 拉取订阅内容，以及解析 / 解码订阅文本
 */

import * as http from 'http';
import * as https from 'https';

/**
 * 订阅获取结果
 */
export interface SubscriptionContent {
  /** 原始文本内容（解码后的明文协议链接） */
  text: string;
  /** 是否自动推断为 base64 编码并解码 */
  decodedFromBase64: boolean;
}

/**
 * 通过 URL 拉取订阅内容
 */
export function fetchSubscriptionContent(
  url: string,
  timeoutMs = 20000
): Promise<SubscriptionContent> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      reject(
        new Error(`无效的订阅 URL: ${error instanceof Error ? error.message : String(error)}`)
      );
      return;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      reject(new Error('仅支持 http/https 订阅链接'));
      return;
    }

    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'FlowZ/subscription',
        Accept: '*/*',
        // 部分订阅服务端会返回 gzip/br 压缩内容，这里未实现解压，
        // 显式要求明文响应，避免收到压缩报文后解析失败。
        'Accept-Encoding': 'identity',
      },
    };

    const req = mod.request(options, (res) => {
      // 处理重定向
      const statusCode = res.statusCode || 0;
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        res.resume();
        try {
          const redirectUrl = new URL(res.headers.location, url).toString();
          fetchSubscriptionContent(redirectUrl, timeoutMs).then(resolve).catch(reject);
        } catch (error) {
          reject(
            new Error(`订阅重定向无效: ${error instanceof Error ? error.message : String(error)}`)
          );
        }
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new Error(`订阅请求失败: HTTP ${statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        try {
          resolve(decodeSubscriptionBuffer(buffer));
        } catch (error) {
          reject(error);
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('订阅请求超时'));
    });
    req.end();
  });
}

/**
 * 解码订阅文本
 * 优先尝试按 UTF-8 文本解析；若看起来像 base64 / base64url（无换行、含 base64 字符集且长度满足），则先 base64 解码。
 */
export function decodeSubscriptionText(text: string): SubscriptionContent {
  const raw = text.trim();

  // 如果内容里已经包含 "://" 协议链接，直接按明文处理
  if (raw.includes('://')) {
    return { text: raw, decodedFromBase64: false };
  }

  // 尝试 base64 / base64url 解码：去掉空白后仍符合 base64 字符集，
  // 且解码后含协议链接。不要求长度是 4 的倍数（支持无填充的 base64）。
  const compact = raw
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  if (compact && /^[A-Za-z0-9+/=]+$/.test(compact) && compact.length >= 8) {
    try {
      const decoded = Buffer.from(compact, 'base64').toString('utf-8');
      if (decoded.includes('://')) {
        return { text: decoded.trim(), decodedFromBase64: true };
      }
    } catch {
      // 解码失败则回退到原始明文
    }
  }

  return { text: raw, decodedFromBase64: false };
}

/**
 * 解码订阅原始字节
 */
function decodeSubscriptionBuffer(buffer: Buffer): SubscriptionContent {
  return decodeSubscriptionText(buffer.toString('utf-8'));
}
