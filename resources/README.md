# 资源文件目录

这个目录包含应用程序的跨平台资源文件。

## 目录结构

```
resources/
├── win/                    # Windows 平台资源
│   ├── sing-box.exe       # sing-box Windows 可执行文件
│   └── app.ico            # 应用图标（同时用作托盘图标）
├── mac-x64/               # macOS Intel (x64) 平台资源
│   ├── sing-box           # sing-box macOS x64 可执行文件
│   └── app.icns           # 应用图标（同时用作托盘图标）
├── mac-arm64/             # macOS Apple Silicon (arm64) 平台资源
│   ├── sing-box           # sing-box macOS arm64 可执行文件
│   └── app.icns           # 应用图标（同时用作托盘图标）
└── data/                  # 共享数据文件
    ├── geoip-cn.srs       # 中国 IP 地址段数据
    ├── geosite-cn.srs     # 中国域名列表
    └── geosite-geolocation-!cn.srs  # 非中国域名列表
```

## 资源管理

应用程序使用 `ResourceManager` 类来管理资源文件的访问：

- 自动检测当前平台和架构
- 处理开发环境和生产环境的路径差异
- 提供统一的资源访问接口

## 开发环境 vs 生产环境

### 开发环境
资源文件从项目根目录的 `resources/` 目录加载：
```
/path/to/project/resources/
```

### 生产环境
资源文件从打包后的 `resources/` 目录加载：
```
/path/to/app/resources/
```

## 打包配置

在 `electron-builder` 配置中，需要将 `resources` 目录包含到打包产物中：

```json
{
  "files": [
    "dist/**/*",
    "resources/**/*"
  ],
  "extraResources": [
    {
      "from": "resources",
      "to": "resources",
      "filter": ["**/*"]
    }
  ]
}
```

## 注意事项

1. **可执行权限**: macOS 的 sing-box 文件需要可执行权限（`chmod +x`）
2. **文件大小**: sing-box 可执行文件较大（~30-35MB），会影响安装包大小
3. **更新**: GeoIP/GeoSite 数据文件需要定期更新以获得最新的路由规则
4. **图标复用**: 托盘图标直接复用应用图标（app.ico/app.icns），Electron 会自动处理不同平台和 DPI 的适配

## sing-box 版本

当前使用的 sing-box 版本：**1.14.1**

下载地址：https://github.com/SagerNet/sing-box/releases
