# Building and releasing

English · [简体中文](zh-CN/releasing.md)

## Release targets

The release workflow builds each platform and architecture separately:

| Target | Build host | Packages |
| --- | --- | --- |
| Windows x64 | Windows x64 | NSIS installer, portable `.exe` |
| Windows arm64 | Windows x64, cross-compiled | NSIS installer, portable `.exe` |
| macOS x64 | Intel macOS | `.dmg`, `.zip` |
| macOS arm64 | Intel macOS, cross-compiled | `.dmg`, `.zip` |
| Linux x64 | Ubuntu x64 | `.AppImage`, `.deb` |
| Linux arm64 | Ubuntu arm64 | `.AppImage`, `.deb` |

Architecture checks inspect the packaged executable. Cross-compilation does not test the app on that target hardware. Record automated checks, installation tests, and any untested areas in the release notes.

## Local builds

Use Node.js 24. Configure the publisher's public OAuth Client ID as described in [GitHub login setup](github-setup.md), and confirm the production repository:

```dotenv
GITHUB_CLIENT_ID=your-public-client-id
DAILY_CF_REPOSITORY=Yawn-Sean/Daily_CF_Problems
```

Start with a clean dependency install:

```sh
npm ci
npm audit --audit-level=moderate
npm test
npm run build
npm run test:e2e
```

Run the appropriate packaging command on the corresponding operating system. Replace `--x64` with `--arm64` for an Arm package:

```sh
# Windows
npm run dist -- --win --x64 --publish never

# macOS
npm run dist -- --mac --x64 --publish never

# Linux
npm run dist -- --linux --x64 --publish never
```

Output goes to `release/`. `npm run pack` creates an unpacked app for the host platform. If supplying `--config.electronDist`, its Electron executable must match the target architecture; do not reuse an x64 runtime for an arm64 build.

`.env` is a build input and is not included in packages. Putting an `.env` beside an installed app does not change its repository or bundled Client ID. The app has no automatic updater; users upgrade by downloading a new package.

## GitHub Actions

[ci.yml](../.github/workflows/ci.yml) runs dependency installation, auditing, tests, and builds on Windows, macOS, and Ubuntu. These checks do not need a personal GitHub login or write to the problem repository.

[release.yml](../.github/workflows/release.yml) runs manually or when a `v*` tag is pushed. Before running it, set the public Actions repository variable `DAILY_CF_GITHUB_CLIENT_ID` under **Settings → Secrets and variables → Actions → Variables**. The workflow passes it to the build as `GITHUB_CLIENT_ID`. It is a Client ID, not a Client Secret or access token; local `.env` files still use `GITHUB_CLIENT_ID`.

For a release:

1. Update `package.json`, the lockfile, and the browser preview version together.
2. Prepare the English release notes with a Chinese section and list the intended packages.
3. Check the committed source, then run the workflow with a matching `release_tag`, such as `v0.3.24` for version `0.3.24`. Pushing that tag also triggers the workflow.
4. Wait for all six build jobs. They test the source, package it, and check the output architecture, app archive, and expected files.
5. Review the draft's assets, SHA-256 checksums, release notes, and test results, then publish it.

The workflow fixes the problem repository to `Yawn-Sean/Daily_CF_Problems`, requires the publisher Client ID, and rejects a tag that does not match `package.json`. Manual runs require `release_tag`. Both triggers store build artifacts and assemble a release draft only after all targets succeed; neither publishes it automatically. The draft uses the version's notes from `docs/releases/`.

Windows x64, macOS x64, and Linux x64/arm64 jobs also launch the packaged app to check startup and its preload API. Windows arm64 and macOS arm64 are cross-built and receive architecture and archive checks. These checks do not cover installation wizards or an authenticated GitHub session.

Build jobs have read-only repository access. The draft assembly job alone can write release assets. Packaging uses `--publish never`; publishing an installer is a separate step. The workflow refuses to replace assets of an already published release.

## Test repositories and data directories

For tests that write to GitHub, build against a public repository you control:

```dotenv
DAILY_CF_REPOSITORY=your-account/daily-cf-test
```

Rebuild after changing the target. Before each submission, check the destination repository, source fork, paths, and PR preview. Keep test code out of the official problem repository.

The app stores preferences, encrypted sessions, and the public Git library separately for each target `owner/repo`. Use `--user-data-dir=<absolute-path>` to run with a temporary data root. This changes local storage only; it does not change the target repository. Delete only directories you created for the test, after checking the resolved path.

Before making a production build, restore the official repository and check it in the packaged app. The app's submission list exists only in memory, and contribution history comes from GitHub.

## Checking a packaged app

`npm run test:e2e` checks the built app's startup and preload API. It does not test an installer, GitHub login, or a real contribution.

On Windows, the existing package verifier can check `release/win-unpacked/`:

```sh
node docs/assets/verify-windows-package.cjs --bootstrap-only
```

It uses a temporary data directory to check packaged resources, version, repository, startup, and shutdown. Read its options before running the longer library synchronization and repair checks. Keep generated reports and personal test data out of the source repository.

Choose further checks based on the change: installation and upgrades, local storage, library synchronization, login, fork selection, submission previews, or interface behavior. Record what ran against the actual release package, separately from tests that use sample data.

## Signing, icons, and licenses

Windows packages are unsigned. The macOS build uses an ad-hoc signature, which provides no Apple Developer ID identity and is not notarization. State these limits in release notes. If publisher signing or notarization is added, keep certificates, passwords, and Apple credentials in the build service's secret storage.

The icon source is [icon.svg](assets/icon.svg); PNG, ICO, and ICNS assets are checked in. Regenerate them after changing the source:

```sh
npx electron docs/assets/create-icons.cjs
```

Include the MIT license and required dependency notices. Publish packages and checksums on the [client's Releases page](https://github.com/yanami-anna-meow/daily-cf-client/releases).
