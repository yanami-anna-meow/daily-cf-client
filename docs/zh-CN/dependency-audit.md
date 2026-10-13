# 依赖审计记录

[English](../dependency-audit.md)

本报告记录 **2026 年 10 月 7 日**的检查与修复，范围为当时 `package.json` 与 `package-lock.json` 中的 npm 依赖，包括开发和打包工具。这是历史记录，不代表当前审计结果。

本轮修复前，`npm audit` 汇总为 **11 个受影响依赖节点：2 个 critical、9 个 moderate**。这些数目包含漏洞沿依赖链传播后被标记的上层包，并不表示存在 11 个互不相关的漏洞。修复后，同一项目的完整 `npm audit` 结果为 **0 个已知漏洞**。这是查询时 npm 公告库与当前锁文件的匹配结果，不是对全部源码和安装产物的安全认证。

后续接入 Markdown 数学公式时，`rehype-katex` 与 `micromark-extension-math` 引入旧版 KaTeX，出现 4 个 low 级受影响节点；统一到根依赖的 KaTeX `0.19.0` 后再次审计，结果仍为 0。

## 公告与处理

| 来源 | 原因与触发边界 | 本项目处理 |
| --- | --- | --- |
| `tinypool`，经旧版 Vitest 引入 | 原型污染条件下，`run()` 选项或 Worker 选项可能使工作线程加载攻击者控制的代码；涉及开发机和测试执行环境 | 将 `vitest` 从 `^3.2.4` 升至精确版本 `4.1.11`，由新版本移除旧 `tinypool` 依赖链 |
| `@vitest/mocker` / `vitest` | 可访问开发服务 WebSocket 的攻击者可能注册越过允许目录的 redirect mock，导致任意文件读取 | 使用已修复版本 `4.1.11` |
| `sprintf-js`，经 `roarr` → `global-agent` → `@electron/get` 引入 | 受攻击者控制的格式字符串可通过过大的精度参数触发未捕获异常；影响使用该调用的工具链路径 | 在 `@electron/get` 的依赖范围内，将 `global-agent` 固定为 `4.1.3`，移除旧版 `roarr` / `sprintf-js` 链 |
| `katex`，经 `rehype-katex` 与 `micromark-extension-math` 引入 | 已有原型污染时，渲染器可能错误地读取继承的 `trust` 等设置，绕过非可信公式限制 | 通过 `katex: "$katex"` override 统一使用根依赖的 `0.19.0`，覆盖两个渲染插件的旧副本 |

原始公告：

- [GHSA-85c8-ppgw-ccpr：Tinypool 的 run 选项原型污染利用链](https://github.com/advisories/GHSA-85c8-ppgw-ccpr)，公告修复版本为 `2.1.2`。
- [GHSA-5gmw-xhrv-c9v3：Tinypool 的 Worker 选项原型污染利用链](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3)，公告修复版本为 `2.1.1`。
- [GHSA-82fw-gwwq-j7x9：Vitest / mocker 路径遍历与任意文件读取](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)，稳定版修复版本为 `4.1.11`。
- [GHSA-hp3w-g68c-fv3c：sprintf-js 精度参数导致拒绝服务](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)，核对时公告未列出已修复版本。
- [GHSA-238p-pmpm-9mq7：KaTeX 对既有原型污染的信任限制绕过](https://github.com/advisories/GHSA-238p-pmpm-9mq7)，公告修复版本为 `0.18.2`。

前四份公告涉及测试、Electron 下载和打包依赖；KaTeX 会进入题解的运行时渲染。普通用户的题解浏览或提交不会主动调用 Vitest 测试服务；但开发和发布环境可能持有重要文件，因此也应处理工具链中的已知漏洞。

## 版本选择与 override 范围

`electron-builder` 保持精确版本 `26.15.3`。解决其下载依赖链时只覆盖已核验的 `global-agent`，不对整个打包工具链做未经验证的降级或跨主版本替换：

```json
{
  "devDependencies": {
    "electron-builder": "26.15.3",
    "vitest": "4.1.11"
  },
  "overrides": {
    "@electron/get": {
      "global-agent": "4.1.3"
    },
    "katex": "$katex"
  }
}
```

选择作用于 `@electron/get` 的嵌套 override，是为了只改变 Electron 下载路径中的旧代理实现。兼容性核对覆盖了 `global-agent` 的 `bootstrap()` 导出、所用代理环境配置，以及既有 `@electron/get` 的 `initializeProxy()` 调用。该 override 跨越 `global-agent` 的主版本，因此升级 `@electron/get` 或 Electron 打包工具时，需要重新检查其调用方式；上游依赖范围能够直接选择安全版本后，应评估移除 override。

KaTeX override 引用根依赖版本，保证字体样式与 Markdown 插件使用同一渲染版本，避免根依赖安全而嵌套副本仍旧过期。已验证行内与块级公式输出，以及 `trust: false` 下不输出 `javascript:` 超链接；该定向验证不代表覆盖了全部 TeX 宏。插件正式更新其依赖范围后，可重新评估此 override。

`package-lock.json` 应与这些修改一起提交，安装使用 `npm ci`。本项目声明 Node.js `^22.12.0 || >=24.0.0`，推荐 Node.js 24 LTS。没有使用 `npm audit fix --force`：自动强制调整上层依赖可能改变打包行为，也不能替代兼容性验证。

## 本轮验证和复查方式

本轮已完成：

- 完整依赖安装后的 `npm audit`：0 个已知漏洞。
- 升级后的 Vitest 测试运行通过。
- `global-agent.bootstrap()` 与旧 `@electron/get.initializeProxy()` 的调用验证通过。
- React Markdown、remark-math 与 rehype-katex 使用去重后的 KaTeX 渲染行内/块级公式，拒绝输出非可信 JavaScript 链接。

以上代理初始化检查没有覆盖每种企业代理、认证方式或所有操作系统的真实下载。跨平台安装包验证和发布要求见[发布指南](releasing.md)；依赖审计不能替代应用构建、登录及提交流程测试。

后续复查可以依次运行：

```sh
npm ci
npm audit
npm test
npm run build
```

如果审计重新出现告警，先识别实际依赖路径、公告前提、修复版本及是否进入安装产物，再进行定向升级。记录新的日期、版本和实际验证结果，避免只修改文档中的数字。
