# Dependency audit record

[简体中文](zh-CN/dependency-audit.md)

This records dependency checks performed on **October 7, 2026**, covering the npm packages in `package.json` and `package-lock.json`, including development and packaging tools. It is a historical record, not a current audit result.

Before the fixes, `npm audit` reported **11 affected dependency nodes: 2 critical and 9 moderate**. That count included parent packages affected through their dependencies; it did not represent 11 separate vulnerabilities. After the fixes, the full audit reported **0 known vulnerabilities** against the npm advisory database and lockfile at that time.

Adding Markdown math support later brought in older KaTeX copies through `rehype-katex` and `micromark-extension-math`, producing 4 low-severity affected nodes. An override aligned those copies with the root KaTeX dependency, `0.19.0`, and the audit returned to 0.

## Findings and fixes

| Dependency | Conditions and impact | Change |
| --- | --- | --- |
| `tinypool`, through the former Vitest version | With prototype pollution already present, `run()` or Worker options could load attacker-controlled code in a worker. This affected development and test environments. | Updated `vitest` from `^3.2.4` to exact version `4.1.11`, removing the old `tinypool` dependency chain. |
| `@vitest/mocker` / `vitest` | An attacker with access to the development server's WebSocket could register a redirect mock outside the allowed directory and read arbitrary files. | Updated to fixed version `4.1.11`. |
| `sprintf-js`, through `roarr` → `global-agent` → `@electron/get` | An attacker-controlled format string with excessive precision could trigger an uncaught exception in tooling that calls the formatter. | Pinned `global-agent` to `4.1.3` within `@electron/get`, removing the old `roarr` / `sprintf-js` chain. |
| `katex`, through `rehype-katex` and `micromark-extension-math` | With prototype pollution already present, the renderer could read inherited options such as `trust` and bypass restrictions on untrusted formulas. | Used the `katex: "$katex"` override to align both plugins with root dependency `0.19.0`. |

Advisories reviewed:

- [GHSA-85c8-ppgw-ccpr: Tinypool `run` options prototype-pollution gadget](https://github.com/advisories/GHSA-85c8-ppgw-ccpr). Fixed in `2.1.2`.
- [GHSA-5gmw-xhrv-c9v3: Tinypool Worker options prototype-pollution gadget](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3). Fixed in `2.1.1`.
- [GHSA-82fw-gwwq-j7x9: Vitest / mocker path traversal and arbitrary file reads](https://github.com/advisories/GHSA-82fw-gwwq-j7x9). Fixed in stable version `4.1.11`.
- [GHSA-hp3w-g68c-fv3c: sprintf-js denial of service through precision values](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). No fixed version was listed when checked.
- [GHSA-238p-pmpm-9mq7: KaTeX trust restriction bypass with existing prototype pollution](https://github.com/advisories/GHSA-238p-pmpm-9mq7). Fixed in `0.18.2`.

The first four advisories affected test, Electron download, and packaging dependencies. KaTeX is also used at runtime to render editorials. Browsing problems or submitting solutions does not start the Vitest development server, but development and release environments still need the tooling fixes.

## Version pins and overrides

`electron-builder` remained pinned to `26.15.3`. The download dependency fix changed `global-agent` within `@electron/get`, without replacing or downgrading the rest of the packaging toolchain:

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

The nested override limits the proxy change to Electron's download path. Checks covered the `global-agent.bootstrap()` export, the proxy environment configuration in use, and the existing `@electron/get.initializeProxy()` call. Because the override crosses a `global-agent` major version, recheck these calls when updating `@electron/get` or the Electron packaging tools. Remove the override when the upstream dependency range can select a suitable fixed version directly.

The KaTeX override refers to the root dependency so that the styles and Markdown plugins use the same renderer version. Checks covered inline and display math and confirmed that `trust: false` did not emit `javascript:` links. They did not cover every TeX macro. Reassess the override when the plugins update their dependency ranges.

Commit `package-lock.json` with dependency changes and install with `npm ci`. At the time of this audit, the project declared Node.js `^22.12.0 || >=24.0.0` and recommended Node.js 24 LTS. The fixes did not use `npm audit fix --force`; forced dependency changes can alter packaging behavior and still require compatibility checks.

## Checks performed

- Full `npm audit` after installation: 0 known vulnerabilities.
- Vitest tests passed after the upgrade.
- `global-agent.bootstrap()` and the existing `@electron/get.initializeProxy()` call passed their checks.
- React Markdown, remark-math, and rehype-katex rendered inline and display formulas using the deduplicated KaTeX version and rejected untrusted JavaScript links.

The proxy checks did not cover every enterprise proxy, authentication method, or operating system. Dependency audit results also do not replace application builds or login and submission tests. See the [release guide](releasing.md) for packaging checks.

To check the current lockfile:

```sh
npm ci
npm audit
npm test
npm run build
```

If warnings return, check the dependency path, advisory prerequisites, fixed versions, and whether the affected package ships in the application before choosing an upgrade. Record the new date, versions, and test results in a separate update.
