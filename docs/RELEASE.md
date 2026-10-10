# 发布指南

本文档描述了如何发布 FlowZ 的新版本。

## 前置要求

1. **GitHub CLI**: 安装 GitHub CLI 工具
   ```bash
   # macOS
   brew install gh
   
   # Windows
   winget install --id GitHub.cli
   ```

2. **认证**: 确保已登录 GitHub CLI
   ```bash
   gh auth login
   ```

3. **权限**: 确保有仓库的写入权限

## 发布流程

### 方式一：手动发布（推荐用于测试）

1. **更新版本号**
   
   编辑 `package.json` 中的 `version` 字段：
   ```json
   {
     "version": "1.0.1"
   }
   ```

2. **更新 CHANGELOG**
   
   在 `CHANGELOG.md` 中添加新版本的更新内容：
   ```markdown
   ## [1.0.1] - 2024-12-14
   
   ### Added
   - 新功能描述
   
   ### Fixed
   - 修复的问题
   ```

3. **提交更改**
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: bump version to 1.0.1"
   git push
   ```

4. **构建打包产物**
   ```bash
   npm run release:prepare
   ```
   
   这将构建并打包所有平台的安装包。

5. **执行发布脚本**
   ```bash
   npm run release
   ```
   
   脚本将自动：
   - 创建 Git tag (v1.0.1)
   - 推送 tag 到远程仓库
   - 生成 Release Notes
   - 创建 GitHub Release
   - 上传所有打包产物

### 方式二：自动发布（推荐用于生产）

1. **更新版本号和 CHANGELOG**（同上）

2. **提交并推送更改**
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: bump version to 1.0.1"
   git push
   ```

3. **创建并推送 tag**
   ```bash
   git tag -a v1.0.1 -m "Release 1.0.1"
   git push origin v1.0.1
   ```

4. **GitHub Actions 自动构建**
   
   推送 tag 后，GitHub Actions 会自动：
   - 在 Windows 和 macOS 上构建应用
   - 打包所有格式（NSIS、DMG、ZIP）
   - 创建 GitHub Release
   - 上传所有产物

5. **检查 Release**
   
   访问 GitHub 仓库的 Releases 页面，确认发布成功。

## 版本号规范

遵循 [语义化版本](https://semver.org/lang/zh-CN/) 规范：

- **主版本号 (MAJOR)**: 不兼容的 API 修改
- **次版本号 (MINOR)**: 向下兼容的功能性新增
- **修订号 (PATCH)**: 向下兼容的问题修正

示例：
- `1.0.0` → `1.0.1`: 修复 bug
- `1.0.0` → `1.1.0`: 添加新功能
- `1.0.0` → `2.0.0`: 重大更新，可能不兼容

## 打包产物

每次发布会生成以下文件：

### Windows
- `FlowZ-{version}-win-x64.exe` - NSIS 安装程序
- `FlowZ-{version}-win-x64.zip` - 便携版

### macOS
- `FlowZ-{version}-mac-x64.dmg` - Intel 芯片 DMG 镜像
- `FlowZ-{version}-mac-arm64.dmg` - Apple Silicon DMG 镜像
- `FlowZ-{version}-mac-x64.zip` - Intel 芯片便携版
- `FlowZ-{version}-mac-arm64.zip` - Apple Silicon 便携版

## 故障排除

### 问题：GitHub CLI 未安装

**解决方案**：
```bash
# macOS
brew install gh

# Windows
winget install --id GitHub.cli
```

### 问题：权限不足

**解决方案**：
```bash
gh auth login
```
按照提示完成认证。

### 问题：Tag 已存在

**解决方案**：
```bash
# 删除本地 tag
git tag -d v1.0.1

# 删除远程 tag
git push origin :refs/tags/v1.0.1

# 重新创建 tag
git tag -a v1.0.1 -m "Release 1.0.1"
git push origin v1.0.1
```

### 问题：打包失败

**解决方案**：
1. 确保所有依赖已安装：`npm ci`
2. 清理并重新构建：`npm run build`
3. 检查资源文件是否完整（sing-box 二进制、图标等）
4. 查看详细错误日志

## CI/CD 配置

### GitHub Actions 工作流

项目包含两个工作流：

1. **build.yml**: 每次推送到 main/develop 分支时自动构建
2. **release.yml**: 推送 tag 时自动发布

### 环境变量

GitHub Actions 使用以下环境变量：
- `GITHUB_TOKEN`: 自动提供，用于创建 Release

### 自定义配置

如需修改 CI/CD 配置，编辑 `.github/workflows/` 目录下的文件。

## 最佳实践

1. **测试后再发布**: 在本地充分测试后再发布
2. **更新文档**: 确保 CHANGELOG 和 README 是最新的
3. **语义化版本**: 严格遵循语义化版本规范
4. **发布说明**: 在 Release Notes 中清晰描述更新内容
5. **备份**: 发布前备份重要数据
6. **回滚计划**: 准备好回滚方案以应对问题

## 参考资料

- [Tauri 文档](https://tauri.app/)
- [GitHub CLI 文档](https://cli.github.com/manual/)
- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [语义化版本规范](https://semver.org/lang/zh-CN/)
