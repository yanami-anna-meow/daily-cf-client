# 构建与发布

[English](../releasing.md) · 简体中文

## 发布目标

发布工作流分别构建各个平台和架构：

| 目标 | 构建环境 | 产物 |
| --- | --- | --- |
| Windows x86_64 | Windows x86_64 | NSIS 安装包、免安装 `.exe` |
| Windows arm64 | Windows x86_64，交叉构建 | NSIS 安装包、免安装 `.exe` |
| macOS x86_64 | Intel macOS | `.dmg`、`.zip` |
| macOS arm64 | Intel macOS，交叉构建 | `.dmg`、`.zip` |
| Linux x86_64 | Ubuntu x86_64 | `.AppImage`、`.deb` |
| Linux arm64 | Ubuntu arm64 | `.AppImage`、`.deb` |

安装包文件名统一为 `Daily-CF-<版本>-<系统>-<架构>`，后接包类型和扩展名。系统名称使用 `windows`、`macos`、`linux`，架构名称使用 `x86_64`、`arm64`。Electron 和 electron-builder 的构建参数仍使用 `x64`，DEB 包内部的架构字段仍为 `amd64`。

架构检查会读取打包后程序的可执行文件。交叉构建不等于在目标设备上运行过程序，发布说明应分别记录自动检查、安装测试及尚未测试的范围。

## 本地构建

使用 Node.js 24。按 [GitHub 登录配置](github-setup.md)设置发布者的公开 OAuth Client ID，并核对正式题库：

```dotenv
GITHUB_CLIENT_ID=your-public-client-id
DAILY_CF_REPOSITORY=Yawn-Sean/Daily_CF_Problems
```

从干净依赖安装开始：

```sh
npm ci
npm audit --audit-level=moderate
npm test
npm run build
npm run test:e2e
```

在对应操作系统上运行打包命令。构建 Arm 包时，将 `--x64` 换成 `--arm64`：

```sh
# Windows
npm run dist -- --win --x64 --publish never

# macOS
npm run dist -- --mac --x64 --publish never

# Linux
npm run dist -- --linux --x64 --publish never
```

产物位于 `release/`。`npm run pack` 生成本机平台的解包应用。如果指定 `--config.electronDist`，其中的 Electron 可执行文件必须与目标架构一致，不能把 x86_64 运行时用于 arm64 包。

`.env` 是构建输入，不会打进安装包。在已安装程序旁放置 `.env`，不会改变它的题库目标或内置 Client ID。程序没有自动升级功能，用户通过下载新版本升级。

## GitHub Actions

[ci.yml](../../.github/workflows/ci.yml) 在 Windows、macOS 和 Ubuntu 上安装依赖、审计、测试并构建。这些检查不需要个人 GitHub 登录，也不向题库写入数据。

[release.yml](../../.github/workflows/release.yml) 从 Actions 页面手动运行。运行前在 **Settings → Secrets and variables → Actions → Variables** 中设置公开仓库变量 `DAILY_CF_GITHUB_CLIENT_ID`，工作流会将其传入构建环境变量 `GITHUB_CLIENT_ID`。这里填写 Client ID，不是 Client Secret 或访问令牌；本地 `.env` 仍使用 `GITHUB_CLIENT_ID`。

发布步骤：

1. 同步更新 `package.json`、锁文件和浏览器预览版本。
2. 准备英文发布说明，附上中文说明，列出计划提供的安装包。
3. 检查已提交源码，在 Actions 页面选择对应分支，手动运行 **Build desktop installers**，填写匹配的 `release_tag`，如 `0.3.24` 对应 `v0.3.24`。
4. 等待全部六个构建任务完成。它们会测试源码、打包，并检查目标架构、应用归档和预期文件。
5. 核对草稿中的产物、SHA-256 校验和、发布说明和测试结果，再正式发布。

工作流将题库固定为 `Yawn-Sean/Daily_CF_Problems`，要求提供发布者 Client ID，并拒绝与 `package.json` 不一致的 `release_tag`。工作流会保存构建产物，全部目标成功后才创建发布草稿，由维护者手动发布。草稿对应本次运行选定的确切提交，并使用 `docs/releases/` 中对应版本的说明。创建版本标签或发布草稿不会再次触发构建。

Windows x86_64、macOS x86_64 和 Linux x86_64/arm64 任务还会启动实际打包程序，检查启动和预加载接口。Windows arm64 与 macOS arm64 使用交叉构建，执行架构及归档检查。这些检查不覆盖安装向导或已登录的 GitHub 会话。

构建任务只有仓库只读权限，汇总草稿的任务才有写入发布文件的权限。打包使用 `--publish never`，发布文件是独立步骤。工作流不会替换已公开版本的安装包。

## 测试仓库与资料目录

测试需要写入 GitHub 时，使用自己控制的公开仓库：

```dotenv
DAILY_CF_REPOSITORY=your-account/daily-cf-test
```

更改目标后重新构建。每次提交前核对目标仓库、来源 Fork、文件路径和 PR 预览，不向正式题库发送测试代码。

应用按目标 `owner/repo` 分开保存设置、加密会话和公开题库 Git 数据。可使用 `--user-data-dir=<绝对路径>` 指定临时资料根目录。它只改变本地存储位置，不改变题库目标。清理前核对解析后的路径，只删除自己为本次测试创建的目录。

制作正式安装包前恢复官方题库，并在实际打包程序中核对。提交列表仅存在于内存中，投稿历史从 GitHub 获取。

## 检查实际安装包

`npm run test:e2e` 检查构建后程序的启动和预加载接口，不覆盖安装器、GitHub 登录或真实投稿。

Windows 可使用现有脚本检查 `release/win-unpacked/`：

```sh
node docs/assets/verify-windows-package.cjs --bootstrap-only
```

脚本使用临时资料目录，检查打包资源、版本、题库目标、启动和关闭。运行完整的题库同步和修复检查前，请先阅读脚本选项。生成的报告和个人测试数据不提交到源码仓库。

根据改动选择额外检查：安装升级、本地存储、题库同步、登录、Fork 选择、提交预览或界面行为。发布记录应说明哪些检查针对实际安装包运行，哪些使用了模拟数据。

## 签名、图标与许可

Windows 安装包未签名。macOS 构建使用 ad-hoc 签名，不含 Apple Developer ID 身份，也没有经过公证。发布说明应明确这些限制。如需加入发布者签名或公证，将证书、口令和 Apple 凭据保存在构建服务的密钥存储中。

图标源文件为 [icon.svg](../assets/icon.svg)，PNG、ICO 和 ICNS 已包含在源码中。修改后运行以下命令重新生成：

```sh
npx electron docs/assets/create-icons.cjs
```

发布时保留 MIT 许可证和依赖要求的许可说明。安装包及校验和发布到[客户端 Releases](https://github.com/yanami-anna-meow/daily-cf-client/releases)。
