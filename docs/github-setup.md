# GitHub OAuth App 与登录

客户端提供浏览器设备授权和个人访问令牌两种登录方式。本文说明源码构建时的 OAuth App 配置、授权权限与常见问题。

## 发布者只需配置一次

普通用户只需点击“登录 GitHub”，在浏览器输入客户端显示的验证码并授权。OAuth App 由客户端发布者注册，公开的 Client ID 会在构建时写入主进程；无需让每位用户注册 App。

1. 在 GitHub 的 **Settings → Developer settings → OAuth Apps → New OAuth App** 注册 OAuth App。
2. 填写可辨认的应用名称，例如 `Daily CF Desktop`；Homepage URL 使用你实际维护的客户端项目地址。
3. GitHub 表单要求填写 Authorization callback URL。可填写 `http://127.0.0.1/callback`；本客户端使用 Device Flow，不会启动该回调地址的服务，也不依赖此地址接收令牌。
4. 创建后，在 App 设置中勾选 **Enable Device Flow** 并保存。
5. 复制 **Client ID** 到本地 `.env` 的 `GITHUB_CLIENT_ID`。不需要生成、分发或配置 Client Secret。
6. 重新执行 `npm run dev` 或构建安装包。GitHub Actions 构建使用该代码仓库的 **Settings → Secrets and variables → Actions → Variables** 中的 `GITHUB_CLIENT_ID`。

Client ID 是公共标识，可以作为仓库变量或编译常量。访问令牌属于用户凭据，只交给客户端登录界面；不要把它放进 Client ID 字段、截图、Issue 或日志。

实现遵循 GitHub 的 [OAuth Device Flow 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)：客户端请求设备代码，用户在 `github.com/login/device` 授权，客户端按 GitHub 返回的轮询间隔等待结果。设备授权不需要 Client Secret。

## 在客户端修改 Client ID

普通用户通常无需修改此项。“设置 → 高级设置 · GitHub OAuth”中，“谨慎修改”靠左紧邻折叠标题；展开后，字段旁持续显示对授权登录的影响。该提示不是登录失败后才出现的临时通知。

Client ID 与上次保存值不同时，点击“保存设置”或“保存并离开”会先要求确认，并同时展示当前值和新值。选择“取消”或关闭确认框，不会保存本次设置，表单中的修改仍保留；普通保存选择“确认更改并保存”，保存并离开选择“确认更改并保存离开”，之后才继续校验和保存。仅修改其他设置，或将 ID 改回原值，不会出现这项确认。

### 恢复安装包内置的 ID

Client ID 输入框下提供“恢复默认”。默认值来自当前安装包构建时的 `GITHUB_CLIENT_ID`，由主进程作为独立的只读信息提供，与用户保存的 `settings.clientId` 分开。保存自定义 ID 不会覆盖内置默认值；按钮也不是恢复最近一次保存的自定义 ID。

点击按钮只将内置默认值填回当前表单，保留其他尚未保存的设置，不立即写入本地设置或发起授权。如果恢复后的 ID 与已保存值不同，仍需保存并通过现有的新旧值确认；取消确认后，表单继续保留恢复后的值。若恢复操作只是撤回对已保存默认 ID 的临时编辑，则不会产生新的 Client ID 变化，也无需为这一项再次确认。

输入框已经等于内置默认值时，按钮禁用。构建未内置默认 ID 时，按钮也禁用，并说明可手动填写或使用个人访问令牌。浏览器开发预览没有可恢复的内置 ID。清空设置后下次启动补回构建默认值的既有行为保持不变，详见下方说明。

### 不同改动的影响

- **错误 ID**：不合法的字符格式会被拒绝保存；符合格式但不存在或不可用的 ID，可能保存成功，到请求设备验证码时才由 GitHub 返回错误。保存操作不验证 OAuth App 的归属、可用性或 Device Flow 配置。
- **清空 ID**：保存后，本次运行不再提供浏览器设备授权登录，个人访问令牌登录仍可用。如果安装包构建时内置了默认 Client ID，下次启动时会将空值补为该默认 ID；未内置默认 ID 的构建仍保持未配置。
- **其他有效 App 的 ID**：后续设备授权对应的应用会改变，该应用仍须启用 Device Flow。请在 GitHub 授权页面核对应用名称和请求权限，只授权自己信任的应用。填写 ID 本身不会替用户完成授权。

Client ID 是公开标识；修改它不会自动把现有登录令牌改成另一应用的令牌，也不会自动退出已有账号。客户端继续使用原凭据，直到凭据失效、被撤销或用户退出登录。修改 ID 会取消尚未完成的设备授权，之后须重新开始登录。因此，“当前账号还能使用”不能证明新 ID 配置正确。配置可以再次修改，填错时恢复原值并保存即可；修改 Client ID 也不等同于撤销旧 App 的 GitHub 授权。

## 用户授权与权限

登录时请求 `public_repo` 权限，用于你主动创建 Fork、在明确绑定的来源仓库中提交，以及向目标公开仓库创建 PR。登录本身不会自动选择或创建 Fork。这项 GitHub OAuth 权限可以操作该账号有权访问的公开仓库，并非只能访问每日一题仓库；客户端的界面与主进程实现将操作限制在已配置题库的提交流程。权限范围以 GitHub 授权页为准，详见 [GitHub OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)。

GitHub 密码和二次验证只在 GitHub 页面输入。客户端收到设备授权的访问令牌后，读取 GitHub 当前用户信息并确认登录身份。若 GitHub 返回凭据失效，客户端会要求重新登录。

退出登录会清除本机保存的会话，但不会撤销 GitHub 服务器上的授权。需要彻底撤销时，在 [GitHub Applications](https://github.com/settings/applications) 的 Authorized OAuth Apps 中找到对应 App 并撤销访问权限。

## 个人令牌备用登录

登录窗口提供“使用个人访问令牌”，无需配置 OAuth Client ID。用于完整 Fork/PR 流程时，选择 GitHub classic personal access token 的 `public_repo` 权限；不需要授予私有仓库、组织管理或工作流权限。不要假设 fine-grained token 对跨仓库 Fork 操作有相同支持。

令牌粘贴到应用后，由主进程验证账号并存入系统加密存储；系统缺少可用安全存储时仅保存在内存。详情见 [安全说明](security.md)。使用后可在 [GitHub Token 设置](https://github.com/settings/tokens) 撤销测试令牌。

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| 提示没有配置 GitHub Client ID | 使用配置了发布者 App 的安装包，或在设置里填入自己信任的 App 的 Client ID，确认更改并保存；也可使用个人访问令牌。源码构建修改 `.env` 后须重新构建 |
| 保存 ID 后，下次浏览器授权提示 Client ID 无效 | 保存只检查格式，不代表 GitHub 已验证该应用；恢复正确的 Client ID 并保存后重新登录 |
| 改过 ID 后当前账号仍可使用 | 已有登录凭据不会因 ID 修改而自动清除；后续设备授权才使用新 ID |
| `device_flow_disabled` | OAuth App 的设置里开启 Device Flow |
| 验证码过期或已取消 | 关闭登录对话框后重新开始，使用新显示的验证码 |
| 已在浏览器登录，但客户端仍是访客 | 浏览器登录仅表示 GitHub 网页有会话，仍需完成当前设备验证码授权 |
| GitHub 返回 401 | 令牌可能失效或被撤销，重新登录 |
| GitHub 返回 403 / 请求额度用尽 | 确认权限与组织策略；限流时按提示等待，避免连续刷新 |
| Fork 同名冲突或被重命名 | 在设置中查询已有 Fork，或手动填写正确的 `owner/repository` 校验并绑定。客户端会拒绝其他账号、组织或不属于题库来源的仓库 |
| 授权完成后重开应用还需登录 | Linux 安全存储不可用、被锁定或后端为 `basic_text` 时不会保存明文令牌；请配置系统密钥环 |
| 公网无法访问 GitHub | 检查系统网络、代理及 `api.github.com`、`raw.githubusercontent.com` 的可达性；浏览器能登录不一定意味着客户端的请求也可达 |


