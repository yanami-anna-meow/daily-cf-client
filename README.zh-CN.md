# 小羊肖恩的每日一题

[English](README.md) · 简体中文

[小羊肖恩每日一题题库](https://github.com/Yawn-Sean/Daily_CF_Problems)的桌面客户端。在程序中浏览题库、阅读提示和题解、查看参考代码，并通过 GitHub 提交自己的解答，无需手动管理 Git 分支。

[下载客户端](https://github.com/yanami-anna-meow/daily-cf-client/releases/latest) · [使用指南](docs/zh-CN/user-guide.md) · [反馈问题](https://github.com/yanami-anna-meow/daily-cf-client/issues)

![默认绿色主题下的题库，使用模拟数据](docs/screenshots/appearance-home-default-green-light-1440-0.3.16-fixture.png)

*截图使用模拟数据。程序支持简体中文和英文。*

## 下载

从[最新版本](https://github.com/yanami-anna-meow/daily-cf-client/releases/latest)选择适合自己电脑的文件。

| 系统 | 架构 | 安装包 |
| --- | --- | --- |
| Windows | x64，大多数 Intel、AMD 电脑 | NSIS 安装版或免安装 `.exe` |
| Windows | arm64，Windows on Arm 设备 | NSIS 安装版或免安装 `.exe` |
| macOS | x64，Intel 芯片 | `.dmg` 或 `.zip` |
| macOS | arm64，Apple Silicon 芯片 | `.dmg` 或 `.zip` |
| Linux | x64 | `.AppImage` 或 `.deb` |
| Linux | arm64 | `.AppImage` 或 `.deb` |

文件名中包含版本和架构，各版本的发布页面会列出实际提供的文件及校验和。客户端已包含所需的 Git 功能，使用安装包无需另装 Git 或 Node.js。

Windows 安装包未签名。macOS 应用使用 ad-hoc 签名，没有 Apple Developer ID 签名或公证，系统可能显示安全提示。各版本的实际验证范围见发布说明；构建成功不代表所有安装器都已在实体设备上测试。

## 功能

- 浏览最新题目和完整历史题库。按题号、标题、提示或日期搜索，按难度范围和题目类型筛选，通过月份目录快速跳转。
- 阅读提示、含数学公式的题解，以及所有贡献者的参考代码。Codeforces 原题链接在浏览器中打开。
- 在本地保存公开题库，启动、切换页面和刷新时增量更新；更新期间仍可阅读已有内容。
- 把多个题目的代码文件加入提交列表，统一创建一个 PR。自行选择或创建 Fork，预览变更，并确认需要覆盖的文件。
- 在题目旁查看当前 GitHub 账号的 PR，包括在客户端之外提交的记录。
- 支持中英文、浅色和深色模式，以及可编辑的配色方案。

程序中的提交是向 GitHub 题库贡献文件。客户端不向 Codeforces 评测系统交题，也不运行你的代码。

## 第一次提交

1. 打开题目，点击“加入提交列表”。
2. 选择源码文件，填写用于仓库文件名的署名，核对文件名预览。可以继续添加其他文件或题目。
3. 登录 GitHub，选择已有 Fork，或创建一个新的 Fork。
4. 打开提交列表，检查 PR 内容和文件差异，然后提交。

提交列表只保留在当前程序会话中。设置和公开题库的本地副本会保存在电脑上。具体操作见[使用指南](docs/zh-CN/user-guide.md)，登录凭据和本地文件的处理方式见[安全说明](docs/zh-CN/security.md)。

## 从源码运行

使用 Node.js 24 和 npm：

```sh
git clone https://github.com/yanami-anna-meow/daily-cf-client.git
cd daily-cf-client
npm ci
npm run dev
```

如需通过浏览器授权登录 GitHub，将 `.env.example` 复制为 `.env`，填写启用了 Device Flow 的 GitHub OAuth App 的公开 Client ID：

```dotenv
GITHUB_CLIENT_ID=your-public-client-id
DAILY_CF_REPOSITORY=Yawn-Sean/Daily_CF_Problems
```

不要在此处填写 Client Secret 或访问令牌。不配置 Client ID 仍可浏览题库，也可使用个人访问令牌登录。详见 [GitHub 登录配置](docs/zh-CN/github-setup.md)。

`npm run dev` 启动 Vite 和 Electron。修改主进程、预加载脚本或 `.env` 后需要重启。仅开发界面时可使用 `npm run dev:web`；浏览器预览不具备桌面程序的登录、文件访问和投稿功能。

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 运行自动化测试 |
| `npm run test:ui` | 使用模拟数据测试界面 |
| `npm run build` | 构建界面和 Electron 程序 |
| `npm start` | 启动构建后的程序 |
| `npm run pack` | 生成本机平台的解包应用 |
| `npm run dist -- --publish never` | 生成本机平台安装包 |

开发和测试约定见[参与开发](CONTRIBUTING.zh-CN.md)，各平台的构建方式见[发布指南](docs/zh-CN/releasing.md)。

## 项目与许可

这是独立的社区项目，并非 Codeforces 或小羊肖恩的官方客户端。

- [客户端仓库](https://github.com/yanami-anna-meow/daily-cf-client)：程序源码、问题反馈和开发 PR。
- [题库仓库](https://github.com/Yawn-Sean/Daily_CF_Problems)：题单、学习资料和解答投稿。

客户端采用 [MIT License](LICENSE)。题面、题解和参考代码保留各自作者的许可。感谢小羊肖恩及所有参与维护题库的贡献者。
