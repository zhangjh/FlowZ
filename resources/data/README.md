# GeoIP 和 GeoSite 数据文件

## 文件说明

- `geoip-cn.srs` - 中国 IP 地址段数据（sing-box rule-set 格式）
- `geosite-cn.srs` - 中国域名列表（sing-box rule-set 格式）
- `geosite-geolocation-!cn.srs` - 非中国域名列表（sing-box rule-set 格式）

## 数据来源

- `geosite-cn.srs` 来自 [Dreista/sing-box-rule-set-cn](https://github.com/Dreista/sing-box-rule-set-cn)，
  基于 [felixonmars/dnsmasq-china-list](https://github.com/felixonmars/dnsmasq-china-list)，
  包含大量在中国大陆有 CDN 接入点的域名（含微软、Apple 等国外公司的中国可直连域名）。
- `geosite-geolocation-!cn.srs` 和 `geoip-cn.srs` 来自 sing-box 官方：
  - https://github.com/SagerNet/sing-geoip
  - https://github.com/SagerNet/sing-geosite

## 更新

```bash
# GeoSite 中国（Dreista/sing-box-rule-set-cn，基于 dnsmasq-china-list）
curl -L -o geosite-cn.srs https://raw.githubusercontent.com/Dreista/sing-box-rule-set-cn/rule-set/accelerated-domains.china.conf.srs

# GeoSite 非中国（SagerNet 官方）
curl -L -o geosite-geolocation-\!cn.srs https://github.com/SagerNet/sing-geosite/releases/latest/download/geosite-geolocation-\!cn.srs

# GeoIP 中国（SagerNet 官方）
curl -L -o geoip-cn.srs https://github.com/SagerNet/sing-geoip/releases/latest/download/geoip-cn.srs
```
