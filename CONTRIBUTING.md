# Contributing

English · [简体中文](CONTRIBUTING.zh-CN.md)

Report app bugs and suggest changes in the [client issue tracker](https://github.com/yanami-anna-meow/daily-cf-client/issues). Problems with the learning materials and solution submissions belong in [Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems).

For a bug report, include the app version, operating system, steps to reproduce, and what you expected to happen. Remove access tokens, device codes, session files, and private code from screenshots and logs.

## Development setup

Use Node.js 24 and npm. After cloning your fork:

```sh
npm ci
npm run dev
```

Browser-based GitHub login requires a public OAuth Client ID; see [GitHub login setup](docs/github-setup.md). `npm run dev:web` is useful for interface work, but it does not provide the desktop app's GitHub writes or local file access.

## Checks

These commands do not require a GitHub login or create forks and pull requests:

```sh
npm run typecheck
npm test
npm run build
```

After changing a desktop interface or startup code, build the app and run:

```sh
npm run test:e2e
```

This starts Electron with a temporary data directory and checks startup and the preload API. It needs a graphical environment; a headless Linux runner needs a display such as Xvfb.

Interface tests use sample data and do not write to GitHub:

```sh
npm run test:ui
```

The script starts a local server and one headless browser page. On Windows it uses an installed Microsoft Edge by default. Other platforms use Playwright Chromium; install it with `npx playwright install chromium`. Set `UI_BROWSER_CHANNEL` to use another supported, installed browser. Keep test reports and screenshots containing personal data out of commits.

Changes to problem parsing can also be checked against an upstream clone:

```sh
npm run test:corpus -- /path/to/Daily_CF_Problems
```

This audit requires Git. See the [corpus audit](docs/corpus-audit.md) for setup and scope. Results apply to the repository revision tested.

## Testing GitHub submissions

Use a public test repository you control as the target, then rebuild the app. Check the target in the submission preview before every test. Do not send test solutions to the official problem repository or reuse another person's account or saved session. See [test repositories and data directories](docs/releasing.md#test-repositories-and-data-directories).

## Pull requests

- Keep each pull request focused. Explain the problem, the resulting behavior, and the checks you ran.
- Update English and Chinese text together. For interface changes, include screenshots without personal information.
- Cover relevant failure cases when changing input handling, paths, synchronization, or submissions. Preserve valid uses instead of adding unnecessary restrictions.
- Use `npm ci` to reproduce dependencies. Include lockfile changes with dependency updates and review `npm audit` results.
- Do not commit `.env`, tokens, session files, personal settings, packages, or `node_modules`.

The project uses the [MIT License](LICENSE). Include required attribution and licenses for any code or assets you contribute.
