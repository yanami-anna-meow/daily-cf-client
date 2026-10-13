# GitHub 登录与 OAuth 配置

[English](../github-setup.md) · 简体中文

客户端支持浏览器设备授权和个人访问令牌两种登录方式。正式构建内置 OAuth Client ID，普通用户无需注册 OAuth App。

## 登录

点击“登录 GitHub”，复制客户端显示的验证码，通过登录按钮打开 GitHub 页面并输入验证码。GitHub 密码和二次验证只在 GitHub 页面输入。浏览器已经登录 GitHub，也仍需完成这次设备授权。

客户端请求 `public_repo` 权限，用于创建 Fork、向你明确选定的 Fork 提交文件，以及创建 PR。这项权限涵盖账号可访问的公开仓库，并非只限于每日一题仓库。登录不会自动选择或创建 Fork。权限范围可查看 [GitHub OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)。

退出登录会清除本机保存的会话。如需同时撤销 GitHub 上的授权，请前往 [GitHub Applications](https://github.com/settings/applications) 的 **Authorized OAuth Apps**。

## 为自行构建的客户端配置 OAuth App

1. 在 [GitHub OAuth Apps](https://github.com/settings/developers) 注册应用，填写易于辨认的名称和项目地址。
2. GitHub 要求填写授权回调地址。这里可以使用 `http://127.0.0.1/callback`：本客户端使用 Device Flow，不会启动回调服务，也不会通过此地址接收令牌。
3. 在应用设置中启用 **Device Flow**。
4. 将应用的 **Client ID** 填入本地 `.env` 的 `GITHUB_CLIENT_ID`。不要填写 Client Secret 或访问令牌。
5. 重新启动 `npm run dev` 或构建安装包。GitHub Actions 构建需要在仓库 **Settings → Secrets and variables → Actions → Variables** 中设置 `DAILY_CF_GITHUB_CLIENT_ID`。工作流会将其作为 `GITHUB_CLIENT_ID` 传给构建脚本；本地 `.env` 仍使用 `GITHUB_CLIENT_ID`。

Client ID 是随构建分发的公开标识，Device Flow 不需要 Client Secret。访问令牌则属于用户凭据，不应出现在配置示例、截图、Issue 或日志中。授权流程遵循 [GitHub Device Flow 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)。

## 修改或恢复 Client ID

“设置 → 高级设置 · GitHub OAuth”允许改用其他 OAuth App。普通用户通常无需修改。保存不同的 ID 时需要确认；取消后，已保存的设置不变。

- 错误的 ID 可能导致浏览器授权登录失败。保存时只检查格式，不验证应用是否存在或是否启用了 Device Flow。
- 填写其他应用的有效 ID，会改变下一次授权的对象。请在 GitHub 页面核对应用名称和权限后再授权。
- 清空 ID 会在本次运行中停用设备授权登录。如果安装包内置了默认 ID，下次启动会补回默认值；否则需要使用个人访问令牌或手动填写 ID。

修改 ID 会取消正在进行的设备授权，但不会退出当前账号、更换已有令牌或撤销之前的授权。因此，当前账号仍能使用，并不能说明新 ID 配置正确。

“恢复默认”会将当前安装包内置的 ID 填回表单，保留其他设置，不立即保存；保存并确认后才生效。自定义 ID 不会覆盖内置默认值。输入框已经是默认值，或当前构建未内置默认 ID 时，按钮不可用。

## 使用个人访问令牌

在登录窗口选择“使用个人访问令牌”即可，无需配置 OAuth Client ID。要使用完整的 Fork 和 PR 流程，请创建带 `public_repo` 权限的 [classic personal access token](https://github.com/settings/tokens)。不需要私有仓库、组织管理或工作流权限。Fine-grained token 不一定支持同样的跨仓库 Fork 操作。

主进程会验证令牌对应的账号，并使用操作系统的加密能力保存令牌。安全存储不可用时，仅在本次运行的内存中保留。详情见[安全说明](security.md)。

## 常见问题

| 问题 | 处理方法 |
| --- | --- |
| 未配置 OAuth Client ID | 使用已配置 ID 的安装包；有内置默认值时可恢复默认，也可使用个人访问令牌。修改 `.env` 后需要重新构建。 |
| GitHub 提示 Client ID 无效 | 恢复有效的 ID 并保存。通过设置校验不代表 GitHub 已验证该应用。 |
| `device_flow_disabled` | 在 OAuth App 的 GitHub 设置中启用 Device Flow。 |
| 验证码过期或授权已取消 | 关闭登录窗口，重新开始并使用新验证码。 |
| GitHub 返回 401 | 令牌可能失效或已撤销，请重新登录。 |
| GitHub 返回 403 或额度提示 | 检查令牌权限和组织策略；遇到限流时，等到客户端提示的时间再试。 |
| Fork 被重命名或名称冲突 | 在设置中选择已有 Fork，或填写正确的 `owner/repository` 并校验。Fork 必须属于当前账号，且位于已配置题库的 Fork 网络中。 |
| Linux 上重启后需要重新登录 | 配置或解锁系统密钥环。安全存储不可用，或 Electron 使用 `basic_text` 时，客户端不会保存明文令牌。 |
| 浏览器能访问 GitHub，客户端不能 | 检查系统网络、代理以及 GitHub 和 API 的连通性。浏览器与客户端可能使用不同的网络设置。 |
