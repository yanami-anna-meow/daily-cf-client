# Problem-list parser audit

[简体中文](zh-CN/corpus-audit.md)

This records the `npm run test:corpus` run on **October 7, 2026**. The audit passed for the upstream revision below; it is not a report on the current upstream contents.

- Repository: [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems).
- Commit: [`f8122f4ae8e41e8cefde01c903947844fae72aec`](https://github.com/Yawn-Sean/Daily_CF_Problems/commit/f8122f4ae8e41e8cefde01c903947844fae72aec).
- Run time (UTC): `2026-10-07T08:18:03.755Z`.
- Coverage: all **816 problem lists**, containing **1,631 valid rows**. The parser returned **1,631 problems**. A separate check of the Git tree confirmed the 816-file total.
- Problem dates: February 26, 2024–October 7, 2026.
- Parse errors: **0**. Warnings about inconsistencies in the source: **5**.

## Difficulty and problem type

`*1000` is Yawn-Sean's estimated rating; `1000` is an official Codeforces rating. A missing number has an unknown rating source. Problem type is determined independently from the URL's `/gym/`, `/contest/`, or `/problemset/` path.

| Rating source | Gym | Regular contest |
| --- | ---: | ---: |
| Official (number without an asterisk) | 0 | 962 |
| Estimated (number with an asterisk) | 660 | 9 |
| Unknown / unrated | 0 | 0 |

Examples from the audited revision:

- **Official, regular contest:** February 26, 2024; rating `1500`; problem `cf1547e`. [Source row](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2024/02/0226/problems.md#L3) · [Problem](https://codeforces.com/problemset/problem/1547/E).
- **Estimated, regular contest:** March 2, 2024; rating `*2400`; problem `cf1936c`. [Source row](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2024/03/0302/problems.md#L4) · [Problem](https://codeforces.com/problemset/problem/1936/C).
- **Estimated, Gym:** September 9, 2025; rating `*1700`; problem `cf103114g`. [Source row](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2025/09/0909/problems.md#L3) · [Problem](https://codeforces.com/gym/103114/problem/G).

There were no officially rated Gym problems in this revision. The parser does not rule out that combination. Unit tests cover all four combinations of known rating source and problem type, plus missing ratings.

## Gym URL indices

Some imported Gym problems use numeric or dotted URL indices that do not match the repository's filenames. For these five rows, the parser used the source label from the same contest to resolve the `cf` problem ID. The audit separately confirmed that each ID had a maintainer solution file in the Git tree.

| Source row | URL index | Source label | Resolved ID |
| --- | --- | --- | --- |
| [2025/10/1017, line 3](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2025/10/1017/problems.md#L3) | `4` | `GYM104852D` | `cf104852d` |
| [2025/10/1028, line 3](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2025/10/1028/problems.md#L3) | `911.E` | `GYM104535E` | `cf104535e` |
| [2025/11/1108, line 3](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2025/11/1108/problems.md#L3) | `3` | `GYM106174C` | `cf106174c` |
| [2026/02/0220, line 3](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2026/02/0220/problems.md#L3) | `2` | `GYM106247B` | `cf106247b` |
| [2026/02/0220, line 4](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2026/02/0220/problems.md#L4) | `4` | `GYM106247D` | `cf106247d` |

## Labels that disagree with their links

The following rows contain a label and URL that refer to different problems. In each case, the audit found a maintainer solution for the URL's ID. The client uses that ID and shows a source warning without changing the original text.

| Source row | Source label | URL's problem ID |
| --- | --- | --- |
| [2024/07/0712, line 3](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2024/07/0712/problems.md#L3) | `CF922B` | `cf992b` |
| [2024/09/0924, line 3](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2024/09/0924/problems.md#L3) | `CF436E` | `cf436c` |
| [2025/06/0621, line 4](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2025/06/0621/problems.md#L4) | `CF790A3` | `cf690a3` |
| [2025/10/1031, line 4](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2025/10/1031/problems.md#L4) | `GYM104873I` | `cf104871i` |
| [2026/07/0731, line 4](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2026/07/0731/problems.md#L4) | `GYM106631F` | `cf106631a` |

## Method and rerunning the audit

The script extracts dates, rows, URLs, problem IDs, numeric ratings, and asterisks directly from the Markdown, then compares them with the production parser's output row by row. It checks for missing or extra problems and verifies the repository's `cf` filename prefix for both Gym and regular contest problems. Expected values do not use the production parser's date, ID, or URL helpers. A separate `git ls-tree` check verifies the complete problem-list inventory, including files that a sparse checkout might omit.

From the project root:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/Yawn-Sean/Daily_CF_Problems.git .cache/upstream
git -C .cache/upstream sparse-checkout set --no-cone '/README.md' '/daily_problems/**/problems.md'
npm run test:corpus
```

These commands audit the revision available when you clone. The results above apply only to the recorded commit and do not establish support for every possible future Markdown format. Update the local clone and rerun the script to check newer lists.

The script writes a new `docs/corpus-audit.md` and a machine-readable `docs/corpus-audit.json` containing the full results and failure details. The JSON file is local output and is not distributed with the source.

