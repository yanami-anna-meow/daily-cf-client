# Security and privacy

English | [简体中文](zh-CN/security.md)

This page describes what Daily CF stores, what it sends to GitHub, and the checks applied before a submission. For everyday use, see the [user guide](user-guide.md); for source builds, see [Contributing](../CONTRIBUTING.md).

## GitHub credentials

Browser sign-in uses GitHub's Device Flow. The main process requests a device code and polls for authorization while you approve it on `https://github.com/login/device`. The app does not receive your GitHub password and does not need an OAuth Client Secret. The Client ID is public.

For Device Flow, access tokens and device secrets stay in the main process. The renderer receives the user-facing code, verification URL, expiry time and account information. With manual token sign-in, the token necessarily passes through the input field and a dedicated IPC call before the main process verifies and stores it. There is no renderer API for reading a saved token back.

Device Flow requests `public_repo`. That scope grants access to public repositories the account can operate on, not just this problem library. The app's own checks restrict its submission flow to the configured upstream and a verified source repository; they do not narrow the token's GitHub scope. See [GitHub's scope definitions](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

Changing the Client ID requires confirmation and cancels an unfinished device authorization. It changes the app used for future authorizations, not an existing token. An invalid ID can prevent the next sign-in; **Restore default** restores the build's ID to the form, which must then be saved. See [GitHub setup](github-setup.md).

Signing out clears the current credentials and saved session, but does not revoke GitHub's server-side authorization. Revoke an OAuth app under [GitHub Applications](https://github.com/settings/applications), or remove a manually supplied token under [Personal access tokens](https://github.com/settings/tokens).

## Local data

The desktop data root is `Daily CF` inside Electron's `appData` directory, with separate directories for each upstream repository. **Settings → Local files** shows the actual paths. The `--user-data-dir=<absolute path>` launch argument selects a separate local data root for testing; it does not change the remote upstream.

| Item | Contents |
| --- | --- |
| `session.enc` | Verified GitHub token, encrypted with Electron `safeStorage` when secure storage is available |
| `data.json` | Plain-text settings, source repository binding and PR templates |
| `library.git/` | Public upstream Git objects, repository identity and the active revision pointer |
| `updates/` | App-update packages downloaded at your request |
| `data-legacy-<digest>.json` | Original settings/data retained during migration |
| `data-corrupt-<timestamp>.json` | Backup of an unreadable settings/data file |

The submission list, selected code, per-file author names and notes exist only in memory. Closing its dialog or changing pages keeps them. Normal window close and reload actions ask before discarding them; a crash or forced exit can lose them. Original solution files are never edited or executed by the app. PR records are read from GitHub rather than persisted as a local ledger.

Older versions may have stored drafts, history or an author preference. Migration restores only supported settings. Before replacing a nonempty legacy drafts/history file, it preserves a content-addressed backup; a backup failure stops that save. Old files and backups can still contain that data. Removing a feature does not securely erase its old files.

Settings and sessions are written to an exclusively created temporary file and then renamed, reducing partial writes. The storage layer requests private file/directory permissions where supported. Their effect depends on the OS and filesystem.

`safeStorage` depends on the OS account and key store. On Linux, an unavailable keyring or the `basic_text` backend means the app keeps the token only in memory and asks you to sign in again after exit. It does not fall back to saving a plain-text token. A session that cannot be decrypted requires another sign-in. See [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

The public library, settings and migration backups are not encrypted. Software running with access to your OS account may be able to read or alter app data; secure storage is not protection against an already compromised account. Uninstalling the app should not be assumed to remove its data. Quit before manually editing, backing up or cleaning the data directory.

## Local library and integrity checks

The desktop app uses bundled `isomorphic-git` to read the public upstream. It needs no system Git. An initial shallow download includes the current file tree; later fetches update it incrementally. The branch name and revision come from the remote rather than a hard-coded `main` or `master`.

The library is a bare object store without a checked-out working tree. It does not execute upstream code, hooks or submodules, and it is not used to push solutions or maintain your fork. Submission uses a separate GitHub API flow.

Each store has a repository identity marker. The active pointer names a restricted `objects-<UUID>.git` generation, revision and branch. Synchronization checks directory boundaries, file types and repository identity. Unexpected identities, unsafe root paths and nonempty unrecognized directories stop the operation. Checked object paths reject symbolic and hard links; ordinary Windows short-path aliases are accepted after validating the directory structure. The app does not take over a user repository by replacing its identity marker.

Synchronization verifies actual Git object data, pack/index relationships, object IDs and content reachable from the selected snapshot. When corruption is detected, it can build a new store from the public remote, verify it, and atomically publish the new active pointer. There is at most one rebuild attempt per synchronization. Network failures, lack of space and permission errors are reported rather than treated as a reason to repeatedly download.

Legacy stores are migrated without changing the old copy. Old generations, unsuccessful repair stores and unknown files are not recursively removed, so disk use can grow. An unsafe directory identity is not repaired automatically. A damaged snapshot may be unreadable even while an earlier result remains visible in memory.

Library transport is limited to the configured repository's Git read endpoints on `https://github.com`. It sends no account token or cookies and rejects HTTP redirects. Git's read protocol uses POST requests as part of downloading; these requests do not publish commits or branches.

Current resource limits are:

| Operation | Limit |
| --- | --- |
| One Git download | 256 MiB transferred |
| Synchronization, including a repair retry | 180 seconds, with a separate 210-second worker guard |
| One expanded Git object | 128 MiB |
| Expanded data or physical object files checked in one verification | 512 MiB each |
| One problem list, editorial or reference text file | 1 MiB |

These bound particular operations, not total process memory or accumulated disk usage. Exceeding a limit reports a failure. These checks also do not guarantee resistance to arbitrary changes by another process with the same OS-account privileges.

### Previous content during updates

Local reading uses the published snapshot and does not itself contact the network, create directories or repair data. It does not expose an unpublished replacement store. Startup, page changes and refresh still check the remote.

The app keeps bounded parsed results in memory. After a successful synchronization, it can reuse a complete archive if the revision and directory information match. Otherwise it reads the new snapshot before replacing the complete old view. Failed or interrupted updates keep the old consistent view with an update notice; first loads may show the part read so far.

A confirmed deletion or a successful empty result clears the corresponding visible content. A network error may retain old content but is never reported as a successful refresh. In-memory reuse cannot authorize a submission or skip the final checks against GitHub.

The browser development preview uses GitHub's API and public raw-file endpoints instead of a local Git store. It can retain page results during its current session, but cannot restore a desktop library from disk.

## Renderer, links and files

- Electron enables context isolation, sandboxing and web security, with renderer Node.js integration disabled.
- The preload exposes specific app operations, not arbitrary IPC or filesystem access. The main process checks the sender and validates inputs.
- The window blocks self-navigation, new windows and permission requests. The main process checks external links before opening the system browser.
- Allowed hosts are `github.com`, `codeforces.com`, `www.codeforces.com`, `espresso.codeforces.com`, `yawn-sean.github.io` and `docs.github.com`. Codeforces links may use HTTP or HTTPS; the other hosts require HTTPS. Credentials in URLs and unapproved ports are rejected. Valid links keep their original query strings and fragments.
- The content security policy restricts scripts to app resources and disables plugin objects. Markdown is rendered with restricted React components rather than inserted as raw HTML.

Problem statements open in the system browser. The app does not fetch statement HTML, read that browser's cookies, or pass GitHub tokens to it.

Reference code and imported solutions are read-only text. Highlighting generates text and styles, not executable HTML. The app does not edit, compile or run code. The file picker accepts UTF-8 text within the import size limit and rejects invalid encoding and NUL bytes.

Clipboard writes happen when you request a copy. The dedicated interface checks input and limits it to 1 MiB of UTF-8 text. The app exposes no clipboard-reading or monitoring interface and does not read back the clipboard to verify a write. If copying fails, the text remains available for manual selection.

## App updates

**Settings → App updates** checks the latest published release of `yanami-anna-meow/daily-cf-client`. It does not use the configured problem upstream, submission fork or OAuth Client ID to choose an update source. Release checks and downloads use public GitHub endpoints without the submission account's token or browser cookies.

Checking, downloading and opening an installer are separate user actions. The app does not silently install updates, replace its running executable or force a restart. Opening an installer requires confirmation and warns about unsaved settings or submission content. Portable and AppImage updates are downloaded for you to replace after quitting; the updater does not run those files.

The package must match the running app's system, process architecture and recognized package type. The main process controls the release lookup and selected asset; the renderer cannot supply an arbitrary executable URL or file path. Development builds and unknown package types offer the release page instead.

The downloaded package must match its declared byte length and the SHA-256 recorded in the release's `SHA256SUMS.txt`. The updater checks it again before opening it with the OS or showing it in the file manager. Partial, malformed or altered downloads are not treated as ready. Cancellation stops the download; retrying does not bypass verification.

The checksum detects a damaged download or a file that differs from the published checksum. It is not an independent signature: someone able to replace both a release package and its checksum could change both. HTTPS certificate verification remains enabled. Windows packages are unsigned, and macOS packages use an ad-hoc signature without Developer ID or notarization. The updater does not bypass the operating system's security checks.

Downloaded installers remain local files. Software with the same OS-account privileges can still modify local files or interfere with the OS after a check; these checks are not a boundary against an already compromised account. See the [user guide](user-guide.md#update-the-app) for the steps to finish an update.

## Network requests

There is no app account server, usage analytics or crash telemetry. The app uses:

| Service | Purpose |
| --- | --- |
| `github.com` | Public Git downloads, device authorization and release downloads |
| `api.github.com` | Account information, forks, PR queries, submissions and public release checks |
| GitHub release asset hosts | Installer and checksum downloads |
| `raw.githubusercontent.com` | Public files in the browser preview |
| `avatars.githubusercontent.com` | Profile images |
| Your default browser | Links you choose to open, including Codeforces problems |

Account and submission API requests carry the access token only to GitHub. Public Git downloads, raw-file reads and app-update requests do not. Authentication and repository requests reject redirects; release downloads accept only the GitHub download redirects allowed by the updater. Errors returned to the renderer are sanitized rather than exposing raw authentication responses.

## Fork and submission boundaries

The upstream provides the library and receives PRs. The source repository stores the submission branch. Published builds use `Yawn-Sean/Daily_CF_Problems` as upstream unless built with explicit alternate configuration. Changing the source binding does not change the upstream.

Binding requires an explicit selection and GitHub verification. The source must belong to the signed-in user, be writable and have the configured upstream as its fork parent or source. If the user owns the upstream, it can be explicitly bound for submissions on independent branches. Read-only candidate discovery never chooses or creates a fork. Invalid or missing bindings stop the flow rather than falling back to another repository.

PR preview reads remote state without publishing code. After confirmation, the app checks the account, source, upstream, problem dates, problem IDs and generated paths again. Fork synchronization uses a non-force fast-forward only when the default branch is strictly behind. Independent commits are preserved; divergence stops submission. New PR branches start from the checked upstream version, so unrelated fork commits are not included.

A submission accepts 1–50 files, at most 256 KiB per file and 5 MiB of normalized code overall. Every path must be unique. Extensions preserve case and may be custom, but cannot contain separators, controls, forbidden filename characters or trailing dots/spaces. Generated filenames are limited to 255 UTF-8 bytes. Imported text must be valid UTF-8 without NUL bytes; submission normalizes the BOM and line endings without editing the original file.

An overwrite requires explicit confirmation for the target path and the old file's Git blob SHA. The backend rereads the remote state before synchronizing the fork or publishing. Missing confirmation or a changed SHA requires a new preview. Queue-item replacement is a separate local decision and does not authorize a remote overwrite. Unchanged files are excluded from the actual PR changes; an entirely unchanged submission cannot create an empty PR.

Publishing prepares Git objects, a tree and a commit before creating a new branch reference and PR. These API calls are not one transaction: a fork fast-forward or branch creation can succeed before a later failure. The app does not automatically delete those results. Retries verify account, repository, parent commit, file content and PR files before returning or continuing the same operation. A matching title, path or client marker alone is not enough. Retries do not edit an already-created PR's title, body, files or branch.

PR templates perform one text substitution pass, without code execution or recursive evaluation. Unknown variables, malformed templates and reserved `daily-cf-` markers are rejected. The final title is limited to 256 characters, and the body to 60,000. Client metadata in the PR and commit helps verify retries; it is public metadata, not an authorization credential.

PR records are queried for the signed-in author and configured upstream, then checked again. Problem associations come from actual changed paths. GitHub limits search to 1,000 PRs and a PR's file list to 3,000 files; the app retains readable results and marks possible incompleteness. Account changes discard the old account's results. Existing PRs remain read-only in the app.

## Reporting a problem

Include the app version, OS, steps to reproduce and a redacted error message. Do not post access tokens, device secrets or session files in public issues. For a vulnerability, use a private contact channel provided by the maintainer. Review the [dependency audit](dependency-audit.md) and [release guide](releasing.md) for the checks run by the project; passing those checks does not establish that the app has no vulnerabilities.
