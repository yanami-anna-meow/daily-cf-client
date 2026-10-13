# 构建与发布

本项目提供 Windows、macOS、Linux 的 Electron 打包配置。配置可用不代表所有平台已经实机验证；每次发布应记录该版本实际完成的测试、签名状态和已知限制，不能用旧版本的结果代替当前构建。

## 本地构建

推荐 Node.js 24。先按 [GitHub 登录配置](github-setup.md) 配置发布者的公开 OAuth Client ID，并核对正式题库目标：

```dotenv
GITHUB_CLIENT_ID=你的OAuthAppClientID
DAILY_CF_REPOSITORY=Yawn-Sean/Daily_CF_Problems
```

从干净依赖安装开始检查：

```sh
npm ci
npm audit --audit-level=moderate
npm test
npm run build
npm run test:e2e
```

`npm run pack` 生成本机平台的解包应用。安装包默认输出到 `release/`，按对应操作系统构建：

```sh
# Windows x64：NSIS 安装包与免安装程序
npm run dist:win -- --publish never

# macOS：Intel 与 Apple Silicon 的 dmg / zip
npm run dist -- --mac --x64 --arm64 --publish never

# Linux x64：AppImage / deb
npm run dist -- --linux --x64 --publish never
```

`.env` 属于构建输入，不随安装包分发。修改已构建程序旁边的 `.env` 不会改变安装包的题库目标或内置 Client ID。客户端目前不提供自动升级服务，用户通过下载新版本升级；应验证覆盖安装和配置保留行为。

## GitHub Actions

`.github/workflows/ci.yml` 在 Windows、macOS、Ubuntu 上执行干净安装、依赖审计、自动化测试和构建。PR 检查不需要个人登录信息，也不向题库写入数据。

`.github/workflows/release.yml` 支持手动运行和 `v*` 标签触发。运行前在客户端仓库的 **Settings → Secrets and variables → Actions → Variables** 中设置公开变量 `GITHUB_CLIENT_ID`。不要将访问令牌或 Client Secret 填入该变量。

工作流会：

1. 固定目标题库为 `Yawn-Sean/Daily_CF_Problems`，缺少 Client ID 时失败。
2. 核对版本标签与 `package.json` 一致，例如 `0.3.21` 对应 `v0.3.21`。
3. 在各自系统构建 Windows x64、macOS x64／arm64、Linux x64 安装包。
4. 将安装包保存为 Actions artifacts；标签触发时汇总产物并生成 SHA-256 校验和。
5. 为标签创建 **prerelease 草稿**，等待维护者验收和手动发布。手动运行本身不创建公开 Release。

Actions 以完整提交 SHA 固定版本。构建任务只有 `contents: read`；创建草稿的独立任务才有 `contents: write`。工作流使用 `--publish never` 禁用打包器直接发布，不会替换已经公开版本的安装文件。

## 测试仓库与隔离资料目录

真实 GitHub 写入测试应使用自己控制的公开测试仓库作为目标上游，例如：

```dotenv
DAILY_CF_REPOSITORY=your-account/daily-cf-test
```

修改配置后重新构建。每次真实提交前，检查界面显示的目标仓库、来源 Fork、文件路径与 PR 内容。不要向正式上游发送测试代码。开发者应记录实际创建的测试 PR 及对应构建，测试完成后自行管理测试仓库中的 PR 和分支。

应用按目标 `owner/repo` 分目录保存偏好、加密会话与公开题库 Git 数据。测试时还可使用 `--user-data-dir=<绝对路径>` 指向自己新建的临时资料根目录，避免读取个人日常配置。该参数只更改本地资料位置，不会更改目标题库。测试目录清理前必须核对路径，只清理本次测试创建的目录。

正式构建必须恢复官方题库，并核对主进程返回的仓库、界面链接与提交预览目标一致。提交列表、现场署名和说明只存在应用会话内存中；账号 PR 记录从 GitHub 查询，不使用本地提交台账。

## 实际安装包验证

`npm run test:e2e` 验证构建后的 Electron 启动与预加载接口；它不等同于安装器、GitHub 登录或真实投稿验证。

Windows 的 `docs/assets/verify-windows-package.cjs` 可以进一步检查 `release/win-unpacked/` 中的实际程序。最小启动检查：

```sh
node docs/assets/verify-windows-package.cjs --bootstrap-only
```

脚本创建独立临时资料目录，核对打包资源、版本、题库目标、启动和关闭，并输出本机检查结果。其他模式可以验证真实题库同步、全库读取和受控损坏后的修复；运行前阅读脚本参数与检查范围。需要网络的检查应明确记录网络结果，不将模拟数据或其他版本的报告当成当前构建的实际读取结果。机器报告与本地测试资料不提交到源码仓库，发布说明可以列出相应的验证范围和结果。

发布前按变更范围完成以下检查：

| 范围 | 核对内容 |
| --- | --- |
| 安装与启动 | 支持平台的干净安装、启动、升级、卸载；免安装外层程序；版本和图标 |
| 题库 | 首次下载、增量同步、页面切换、完整历史浏览、删除内容更新、失败时保留旧内容并提示 |
| 本地存储 | 隔离资料目录、配置保存、系统安全存储不可用、题库损坏与修复、临时目录清理 |
| 学习材料 | 提示、数学公式、代码高亮、未知扩展名文本、原题和来源链接 |
| 登录与 Fork | 设备授权、取消、过期、退出；主动选择或创建 Fork；同步冲突明确停止 |
| 提交列表 | 多题多文件、扩展名、同路径替换、代码差异、覆盖确认、重复提交与重试 |
| 真实投稿 | 仅向自有测试仓库创建 PR；核对实际文件、模板内容和提交状态 |
| 界面 | 中英文、浅深色、键盘与小窗口、设置和未提交内容的离开提醒 |
| 发布身份 | 官方题库、正确 Client ID、版本匹配、worker 包含在归档、产物校验和 |

## 签名、图标与许可

现有工作流默认生成未签名预览包，没有内置发布者证书，也不代表通过 Windows 信任验证或 Apple 公证。发布者应根据分发渠道配置代码签名与 macOS 公证，并在 Release 说明中明确实际状态。证书、口令和 Apple 凭据不得提交到源码。

图标源文件为 `docs/assets/icon.svg`，PNG、ICO、ICNS 为预生成资源。修改图形后可在项目根目录运行：

```sh
npx electron docs/assets/create-icons.cjs
```

发布时保留 MIT 许可证及依赖要求的许可文件。安装包、校验和与版本说明一起发布到[客户端 Releases](https://github.com/yanami-anna-meow/daily-cf-client/releases)，不要将本地配置、会话、测试资料或未公开的个人代码打入分发文件。
