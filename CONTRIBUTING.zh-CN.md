# 参与开发

[English](CONTRIBUTING.md) · 简体中文

客户端问题和功能建议请提交到[本仓库 Issues](https://github.com/yanami-anna-meow/daily-cf-client/issues)。题库资料问题和解答投稿请前往 [Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems)。

反馈问题时，请提供客户端版本、操作系统、复现步骤和预期结果。截图和日志中不要包含访问令牌、设备授权码、会话文件或不准备公开的代码。

## 开发环境

使用 Node.js 24 和 npm。克隆自己的客户端 Fork 后运行：

```sh
npm ci
npm run dev
```

GitHub 浏览器授权需要公开的 OAuth Client ID，配置方法见 [GitHub 登录配置](docs/zh-CN/github-setup.md)。界面开发可使用 `npm run dev:web`，但浏览器预览不具备桌面程序的 GitHub 写入和本地文件访问能力。

## 检查与测试

以下检查不需要登录 GitHub，也不会创建 Fork 或 PR：

```sh
npm run typecheck
npm test
npm run build
```

修改桌面接口或启动代码后，完成构建再运行：

```sh
npm run test:e2e
```

脚本使用临时资料目录启动 Electron，检查启动和预加载接口。运行环境需要图形界面；无桌面的 Linux 运行器可以使用 Xvfb。

界面测试使用模拟数据，不向 GitHub 写入内容：

```sh
npm run test:ui
```

脚本自动启动本地服务和一个无头浏览器页面。Windows 默认使用已安装的 Microsoft Edge；其他平台使用 Playwright Chromium，可运行 `npx playwright install chromium` 安装。设置 `UI_BROWSER_CHANNEL` 可以使用其他受支持且已安装的浏览器。不要将包含个人信息的测试报告和截图提交到仓库。

题单解析改动还可以对上游克隆运行语料审计：

```sh
npm run test:corpus -- /path/to/Daily_CF_Problems
```

该审计需要 Git，准备方法与范围见[语料审计](docs/zh-CN/corpus-audit.md)。结果只适用于当次测试的仓库版本。

## 测试 GitHub 投稿

使用自己控制的公开测试仓库作为目标，并重新构建。每次测试前核对提交预览中的目标。不要向正式题库发送测试解答，也不要复用他人的账号或已保存会话。详见[测试仓库与资料目录](docs/zh-CN/releasing.md#测试仓库与资料目录)。

## 提交 Pull Request

- 每个 PR 处理一个明确的问题，说明原问题、修改后的行为和实际完成的检查。
- 同步更新中英文文案；界面变更附上不含个人信息的截图。
- 输入、路径、同步和投稿逻辑的修改应覆盖相关失败情况，同时保留合法用法，避免额外限制。
- 使用 `npm ci` 复现依赖。修改依赖时一并提交锁文件，并检查 `npm audit` 结果。
- 不提交 `.env`、访问令牌、会话文件、个人设置、安装包或 `node_modules`。

项目采用 [MIT License](LICENSE)。提交第三方代码或素材时，请保留必要的来源和许可信息。
