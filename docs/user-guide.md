# User guide

English | [简体中文](zh-CN/user-guide.md)

Daily CF browses [Yawn-Sean's daily problems](https://github.com/Yawn-Sean/Daily_CF_Problems) and helps you submit solutions through GitHub. Read hints, editorials and reference code in the app; open the original problem in your browser. See the [README](../README.md) for downloads and build instructions.

## Browse the library

**Latest problems** shows the newest problem set found in the repository. It does not assume that the newest set is dated today. The archive includes every valid date found in the repository, including future dates, and supports any number of problems per day.

**Problem archive** is one list grouped by month and day, newest first. Search by problem ID, title, hint or date. Difficulty and problem-type filters apply to the whole archive. The month sidebar scrolls to that month's first matching result; it does not narrow the search. Date navigation keeps the full list and current filters. Returning from a problem restores your previous position.

Difficulty bounds are inclusive. Leave either end blank for an open range, or both blank to include every difficulty. Problems without a rating remain visible only when neither bound is set. Invalid ranges are reported rather than silently changed.

Ratings retain the repository's notation: `1700` stays `1700`, and `*1700` keeps its star. Colors follow Codeforces rating bands. Gym and CF Round are determined from the original problem link, independently of the star.

The original problem button opens the exact repository link in your default browser, including its query string and fragment. Codeforces login and verification happen there. The app does not fetch or embed problem statements. If a title and link disagree, a source warning lets you check them.

## Updates and offline reading

The desktop app keeps a local copy of the public problem repository. It checks for updates at startup, when you change pages, and when you click **Refresh**. The first download takes longer; later Git updates transfer only the data needed for the new version. You do not need Git installed.

Previous content remains visible during an update. A complete new archive replaces the old archive as a whole. If the repository has not changed, the app can reuse the current complete result after checking the remote version. The first load shows progress and lets you search the portion already read.

A failed update keeps readable previous content and shows the failure. A successful update removes files that no longer exist upstream from the current view. It does not delete your local solution files or items already in the submission list.

Synchronization checks local Git data for damage. When possible, the app downloads and verifies a replacement before using it. Repair needs a working network connection and enough disk space. Unsafe paths or an unexpected repository identity stop synchronization instead of taking over the directory. See [Security and privacy](security.md#local-library-and-integrity-checks).

Settings and encrypted login sessions are separate from the library. PRs and account information still use the GitHub API and its rate limits. An up-to-date library does not mean that PR data has refreshed successfully.

The browser development preview does not keep a local Git repository. It uses GitHub's API and public file endpoints, so library browsing in that preview also uses API requests.

## Editorials and reference code

Editorials support Markdown, formulas and code blocks. Reference solutions include all matching authors, with a language filter and a file selector. Code uses the bundled JetBrains Mono font and can be copied without formatting.

Recognized formats include C, C++, Python, Java, Rust, Go, C#, JavaScript, TypeScript, Kotlin, Ruby, Swift, Scala, PHP, Pascal, D, Haskell, OCaml, F#, Perl and R. Unknown extensions remain readable as plain text. In particular, `.c` is C, `.C` is C++, and `.h` is shown as C / C++.

Highlighting falls back to plain text for large or unsupported input; it does not change or truncate the source. Reference files may be up to 1 MiB. Highlighting is not compilation or a correctness check.

## Sign in and choose a fork

Click **Sign in with GitHub**, enter the displayed code on GitHub, and approve the request. A personal access token is another option. The [GitHub setup guide](github-setup.md) explains permissions and the advanced OAuth setting.

Before creating a PR, choose a source repository in the submission dialog or **Settings → Fork repository**. The source receives your submission branch; the upstream receives the PR. Both are shown in preview.

- Select an existing fork and confirm it, even if there is only one candidate.
- Enter `owner/repository` to bind a renamed fork or one not shown in the list.
- Choose **Create fork**, check the full name, then confirm creation. Save the selection or confirm **Use this fork** to bind it.

The source must belong to your GitHub account and the configured upstream's fork network. The app does not silently choose, create or replace it. If you own the configured upstream, you can explicitly use it as the source; submissions still use separate branches and PRs.

The create option remains available when candidates are listed, but GitHub may return an existing fork or reject a name. The app reports that outcome rather than treating it as a newly created and bound repository. Changing the fork does not change the upstream or move existing PRs.

### Synchronization before submission

Previewing only reads the fork state. Once you confirm submission, the default branch is handled as follows:

| Fork state | Action |
| --- | --- |
| Same as upstream | No change |
| Behind, with no independent commits | Fast-forward without force and verify the result |
| Contains upstream plus your own commits | Preserve those commits; create the submission branch from the checked upstream version |
| Diverged from upstream | Stop and ask you to resolve the divergence on GitHub |

The app never force-resets the default branch. Synchronization and PR creation are separate GitHub operations: one may succeed before a later step fails. Follow the error message and preview again before retrying. A deleted or renamed fork requires you to update its binding; the app does not replace it automatically.

## Submit solutions

Write and test code in your own editor. The app imports files, previews them and creates a new PR from the submission list.

1. On a card or detail page, choose **Add to submission list**.
2. Select a UTF-8 source file and enter an author name for that file. Check the extension, generated filename and code preview. The author field starts blank and has no saved default.
3. Add the file, then keep browsing or add more from the list. You can prepare the list before signing in.
4. When ready, sign in, confirm your fork and choose **Preview PR**. Check repositories, paths, changes and PR text. Confirm each overwrite if needed.
5. Choose **Submit PR**. Changed files go into one new PR, and the list clears after success.

The app does not modify existing PRs. Use GitHub to edit a PR that has already been created.

### Files and extensions

Language presets fill in an extension, but you can edit it or enter your own. Importing keeps the actual extension and its case: `.cc` is not renamed to `.cpp`. Compound extensions such as `d.ts` are accepted. A file without an extension needs one before it can be added. Invalid filename characters and paths produce a field-specific error.

A list can contain 1–50 files, up to 256 KiB each and 5 MiB of normalized UTF-8 code in total. Files must be valid UTF-8 without NUL bytes. Each file's note and the shared PR note can contain up to 2,000 characters.

You can include a problem more than once if the generated paths differ, for example by author or extension. If a path is already in the list, the app compares the files and asks before replacing that item. This does not grant permission to overwrite an upstream file.

A file's original problem date determines its directory. It is never changed to today's date.

### Existing files and overwrites

Adding a file checks whether its destination exists upstream. An existing file or a failed check produces a warning; you can still add the item. The final preview checks again.

If an existing file has different content, preview shows its path, old code and differences. Confirm each overwrite separately. Confirmation applies to the version you previewed; if that version changes before submission, the app asks for another preview. The change is proposed on a new branch, not written directly to upstream's default branch.

Files identical to upstream are marked unchanged and omitted from the final PR's changed-file list. If every file is unchanged, no empty PR is created. Submitted text is normalized by removing a UTF-8 BOM, using LF line endings and ensuring a final newline. Your original file is not changed.

### What the list remembers

Files, author names and notes stay in memory while the app runs. Closing the list dialog or changing pages keeps them; quitting, refreshing the whole app or a crash loses them. Normal close and refresh actions warn about unsubmitted content. There is no saved draft after exit.

You can retry a failed request. The app checks whether the same submission already created a branch or PR before continuing. It does not turn a changed request into an edit of an existing PR. Success means the PR exists; it does not mean Codeforces accepted the solution or the maintainer merged it.

## PR status and history

History reads PRs authored by the signed-in account and addressed to the configured upstream, including PRs made through GitHub or other tools. A PR containing several problems still counts as one PR.

Problem associations come from changed file paths, not titles, descriptions or names in filenames. Related PRs appear in one list, newest creation time first, across all problem dates. Open, merged and closed PRs are all shown.

| Card background | Meaning |
| --- | --- |
| Pale purple | At least one related PR has been merged |
| Pale green | No merged PR, but at least one is open |
| Neutral | Only closed PRs, or no confirmed association |

The list and counts explain the color. Loading, failed or incomplete queries have separate notices; a missing result is not proof that a problem has never been submitted. Related PRs are reminders and do not prevent another submission.

GitHub search returns at most 1,000 PRs, and a PR's files endpoint returns at most 3,000 changed files. The app shows what it can read and warns when results may be incomplete. Deleted files and unrelated changes remain visible in PR details but do not count as submitted solutions. PR data is not saved as a local contribution ledger.

## PR templates

**Settings → Pull request templates** contains one title and one Markdown body template for both single- and multiple-problem submissions. Put the cursor in a field and select a variable to insert it. Settings use sample data for preview; submission preview uses actual files.

| Variable | Value |
| --- | --- |
| `{{date}}` | Earliest date, such as `2026-10-07` |
| `{{date_compact}}` | The same date as `20261007` |
| `{{date_range}}` | Earliest to latest date, or one date if equal |
| `{{problem_id}}` | Repository problem ID, such as `cf1234a` |
| `{{problem_label}}` | Problem name from upstream |
| `{{problem_url}}` | Original problem link |
| `{{rating}}` | Rating with its star, or an unrated label |
| `{{rating_source}}` | Yawn-Sean estimate, Codeforces rating or unknown |
| `{{problem_type}}` | Gym, CF Round or unknown |
| `{{language}}` | Language name |
| `{{extension}}` | Actual extension, without a leading dot, preserving case |
| `{{author}}` | Author name entered for each file |
| `{{filename}}` | Generated filename |
| `{{path}}` | Full repository path |
| `{{notes}}` | Shared PR note |
| `{{login}}` | Signed-in GitHub username |
| `{{problem_count}}` | Number of distinct date/problem pairs |
| `{{file_count}}` | Number of changed files |
| `{{problem_list}}` | Markdown table of problems, files and per-file notes |
| `{{file_list}}` | Markdown list of repository paths |

For multiple files, individual fields are deduplicated and joined in input order. Use `{{problem_list}}` to retain the relationship between a problem, its rating and its files. When there are changes, the final template includes only changed items.

The expanded title must be one line, begin with the earliest date as `YYYYMMDD` and a space, and contain at most 256 characters. The body limit is 60,000 characters. Unknown variables, incomplete braces and reserved `daily-cf-` markers are rejected. Variables substitute text only; they do not run code.

## Settings

Settings are saved explicitly. Leaving with unsaved changes offers **Save and leave**, **Discard changes** or **Keep editing**. A failed save leaves the form intact. Saving settings does not save the submission list.

### Language

Choose system language, Simplified Chinese or English. System language uses Chinese for a preferred language starting with `zh`, and English otherwise. Interface text, dates, errors and native menus use your choice. Repository content, code and custom PR templates keep their original text.

### Appearance

The initial palettes are green, pink, blue and monochrome; green is selected by default. Each has a name and light/dark variants. Add a palette to copy the selected one, then rename and edit it. Built-in and added palettes use the same controls.

Each variant has five colors: button, accent, page background, card background and body text. Use the picker or enter `#RGB` or `#RRGGBB`. Accent colors apply to links and actions independently of the button color. The editor warns about low text contrast. Light, dark and system appearance can be selected independently of the palette.

**Restore default palettes** asks for confirmation, replaces the list with the original four and selects green. It affects only the form until saved; discarding the form keeps your previous palettes. Language, light/dark mode and other settings are not reset.

### Local files

**Settings → Local files** shows the actual config and data paths. Open the config location to find `data.json`, or open the directory containing settings, the encrypted session and the local library. If no config exists yet, its parent directory opens instead. Opening these locations does not save or discard form changes.

Quit before editing these files manually. See [Security and privacy](security.md#local-data) for what is stored and how credentials are protected.
