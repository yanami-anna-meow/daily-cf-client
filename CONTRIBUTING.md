# 参与开发

欢迎改进客户端。客户端问题和功能建议请提交到[本仓库 Issues](https://github.com/yanami-anna-meow/daily-cf-client/issues)；题库资料和解答投稿请前往 [Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems)。

反馈问题时，请说明客户端版本、操作系统、复现步骤、预期和实际结果。截图或日志中不要包含访问令牌、设备密钥、会话文件及不准备公开的代码。

## 开发环境

推荐 Node.js 24 与 npm。克隆自己的客户端 Fork 后运行：

```sh
npm ci
npm run dev
```

GitHub 设备授权需要公开 OAuth Client ID，配置方法见 [GitHub 登录](docs/github-setup.md)。界面开发可运行 `npm run dev:web`；它不具备桌面主进程提供的真实投稿能力。

## 检查与测试

基础检查不需要登录 GitHub，也不会创建 Fork 或 PR：

```sh
npm run typecheck
npm test
npm run build
```

修改桌面接口或启动逻辑后，完成构建再运行：

```sh
npm run test:e2e
```

此脚本启动使用临时资料目录的 Electron 实例，检查预加载接口和启动结果。运行环境需要能够启动 Electron 窗口；无图形界面的 Linux 环境需要配置合适的显示环境。

界面测试使用明确的模拟数据，不向 GitHub 写入内容：

```sh
npm run test:ui
```

该脚本自动启动本地服务，仅使用一个无头浏览器页面。Windows 默认使用已安装的 Microsoft Edge；其他平台默认使用 Playwright Chromium，可以先运行 `npx playwright install chromium`。可通过 `UI_BROWSER_CHANNEL` 选择已安装的受支持浏览器。测试报告和截图保留在本地，不应把含个人信息的测试产物提交到仓库。

题单解析改动还可以对真实上游克隆运行语料审计：

```sh
npm run test:corpus -- /path/to/Daily_CF_Problems
```

脚本需要本机 Git；具体范围及准备方式见[语料审计说明](docs/corpus-audit.md)。生成结果描述当次仓库版本，不代表未来的所有题单格式都已验证。

## 真实投稿联调

只有在需要验证 GitHub 写入时才进行真实投稿测试。使用自己控制的公开测试仓库作为构建目标，重新构建，并在提交预览中核对目标。不要向正式题库提交测试代码，也不要复用他人的测试账号或本地会话。测试目标与资料隔离方法见[发布指南](docs/releasing.md#测试仓库与隔离资料目录)。

## 提交 Pull Request

- 将改动控制在同一个明确问题内，说明修改原因、用户可见变化及实际执行的验证。
- 修改中英文界面文案时，同时更新对应翻译；界面变化附上不包含个人信息的截图。
- 输入、路径、同步和投稿逻辑的变更需要覆盖相关失败和边界情况，避免额外阻止合法提交。
- 使用 `npm ci` 复现依赖；变更依赖时一起提交锁文件，并检查 `npm audit` 的结果。
- 不提交 `.env`、访问令牌、会话文件、个人配置、安装产物或 `node_modules`。

本项目采用 [MIT License](LICENSE)。请确认提交的代码和素材具有相应授权，并保留来源及许可要求。
