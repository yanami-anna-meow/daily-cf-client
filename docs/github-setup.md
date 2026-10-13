# GitHub sign-in and OAuth setup

English · [简体中文](zh-CN/github-setup.md)

The desktop app supports GitHub device authorization and personal access tokens. Published packages include an OAuth Client ID, so users do not need to register an OAuth App.

## Sign in

Choose **Sign in with GitHub**, copy the code shown in the app, and enter it on the GitHub page opened by the sign-in button. Enter your GitHub password and any verification codes only on GitHub. Being signed in to GitHub in a browser does not complete the app's device authorization.

The app requests `public_repo` permission to create forks, commit files to a fork you have selected, and open pull requests. This scope covers public repositories the account can access; it is not limited to the daily problem repository. Signing in does not select or create a fork. See [GitHub's OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) for the permission details.

Signing out removes the locally saved session. To revoke the app's authorization on GitHub as well, use **Authorized OAuth Apps** in [GitHub Applications](https://github.com/settings/applications).

## Configure an OAuth App for your own build

1. Register an app under [GitHub OAuth Apps](https://github.com/settings/developers). Use a recognizable name and your project's URL.
2. GitHub requires an authorization callback URL. `http://127.0.0.1/callback` can be used here: this client uses Device Flow and does not start a callback server or receive tokens at that address.
3. Enable **Device Flow** in the app's settings.
4. Put the app's **Client ID** in `GITHUB_CLIENT_ID` in your local `.env` file. Do not use a Client Secret or an access token.
5. Restart `npm run dev` or rebuild the installer. For GitHub Actions builds, set the repository variable `DAILY_CF_GITHUB_CLIENT_ID` under **Settings → Secrets and variables → Actions → Variables**. The workflow passes it to the build as `GITHUB_CLIENT_ID`; the local `.env` key remains `GITHUB_CLIENT_ID`.

The Client ID is a public identifier and is included in the build. Device Flow does not need a Client Secret. Access tokens are user credentials and must not go in configuration examples, screenshots, issues, or logs. The authorization process follows [GitHub's Device Flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).

## Change or restore the Client ID

**Settings → Advanced settings · GitHub OAuth** lets you use a different OAuth App. Most users can leave this setting alone. Saving a changed ID requires confirmation; canceling leaves the saved settings unchanged.

- An incorrect ID can prevent browser sign-in. Saving checks its format, not whether the app exists or has Device Flow enabled.
- Another app's valid ID changes which app receives your next authorization. Check the app name and permissions on GitHub before approving it.
- An empty ID disables device sign-in for the current session. If the build includes a default ID, the app restores that default at the next startup. Otherwise, use a personal access token or supply an ID.

Changing the ID cancels any device authorization in progress. It does not sign out the current account, change its existing token, or revoke an earlier authorization. A working current session therefore does not verify the new ID.

**Restore default** fills in the ID bundled with the installed build. It preserves the other settings and does not save immediately; save and confirm the change to apply it. A custom ID does not replace this bundled default. The button is disabled when the field already contains the default, or when the build has no default ID.

## Use a personal access token

Choose **Use a personal access token** in the sign-in dialog. This option does not need an OAuth Client ID. For the full fork and pull-request workflow, use a [classic personal access token](https://github.com/settings/tokens) with `public_repo`. Private repository, organization administration, and workflow permissions are not required. Fine-grained tokens do not necessarily support the same cross-repository fork operations.

The main process verifies the account and stores its token using the operating system's encryption support. If secure storage is unavailable, the token stays in memory for that session. See [Security](security.md) for details.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| No OAuth Client ID is configured | Use a build with a configured ID, restore the default if available, or use a personal access token. Rebuild after changing `.env`. |
| GitHub rejects the Client ID | Restore a valid ID and save. Passing the settings validation does not mean GitHub has verified the app. |
| `device_flow_disabled` | Enable Device Flow in the OAuth App's GitHub settings. |
| The code expired or authorization was canceled | Close the sign-in dialog and start again with a new code. |
| GitHub returns 401 | Sign in again; the token may have expired or been revoked. |
| GitHub returns 403 or a rate-limit error | Check the token's permissions and any organization policy. For rate limits, wait until the time shown in the app. |
| A fork was renamed or its name conflicts | Select an existing fork in settings, or enter and validate the correct `owner/repository`. The fork must belong to the signed-in account and the configured problem repository's fork network. |
| Sign-in does not survive a restart on Linux | Configure or unlock the system keyring. The app does not save a plaintext token when secure storage is unavailable or Electron uses `basic_text`. |
| GitHub works in the browser but not in the app | Check system networking, proxy settings, and access to GitHub and its API. Browser and app connections can use different network settings. |
