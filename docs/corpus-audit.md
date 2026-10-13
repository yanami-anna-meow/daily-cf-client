# 真实仓库题单解析审计

本报告由 `npm run test:corpus` 自动生成。审计结果：**通过**。

- 上游：[Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems)。
- 提交：[`f8122f4ae8e41e8cefde01c903947844fae72aec`](https://github.com/Yawn-Sean/Daily_CF_Problems/commit/f8122f4ae8e41e8cefde01c903947844fae72aec)。
- 审计时间（UTC）：2026-10-07T08:18:03.755Z。
- 覆盖范围：816 份真实题单，1631 行有效题目，解析器输出 1631 道题；Git 提交清单确认题单总数 816，没有仅抽样检查。
- 日期范围：2024-02-26 至 2026-10-07。
- 解析错误数：0；原仓库来源警告数：5。

## 难度来源与题目类型独立统计

`*1000` 代表小羊估算难度，`1000` 代表 CF 官方难度；没有数字时来源为未知。题目类型只依据链接中的 `/gym/`、`/contest/` 或 `/problemset/` 路径识别，两者互不推导。

| 难度来源 | Gym | 常规比赛 |
| --- | ---: | ---: |
| CF 官方（无星号数字） | 0 | 962 |
| 小羊估算（星号数字） | 660 | 9 |
| 未知 / 未评级 | 0 | 0 |

- **official:round**：2024-02-26，原始难度 `1500`，题号 `cf1547e`。[原始题单](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2024/02/0226/problems.md#L3)， [题目](https://codeforces.com/problemset/problem/1547/E)。
- **estimated:round**：2024-03-02，原始难度 `*2400`，题号 `cf1936c`。[原始题单](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2024/03/0302/problems.md#L4)， [题目](https://codeforces.com/problemset/problem/1936/C)。
- **estimated:gym**：2025-09-09，原始难度 `*1700`，题号 `cf103114g`。[原始题单](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2025/09/0909/problems.md#L3)， [题目](https://codeforces.com/gym/103114/problem/G)。

本次真实语料未出现以下组合：official:gym。缺失只是语料现状，不代表逻辑上不可能；单元测试另外覆盖四种已知来源与类型组合及缺失难度。

## 特殊 Gym 路径映射

部分 Gym 导入题目使用数字或带点的原始 URL 索引，不能直接当作仓库文件名。以下 5 行通过同比赛的原仓库标签识别 canonical cf 题号，并独立核验 Git 提交内对应官方题解文件存在。

- [daily_problems/2025/10/1017/problems.md:3](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2025/10/1017/problems.md#L3)：URL 索引 `4`，原始标签 `GYM104852D` → `cf104852d`；对应官方题解文件已核实存在。
- [daily_problems/2025/10/1028/problems.md:3](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2025/10/1028/problems.md#L3)：URL 索引 `911.E`，原始标签 `GYM104535E` → `cf104535e`；对应官方题解文件已核实存在。
- [daily_problems/2025/11/1108/problems.md:3](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2025/11/1108/problems.md#L3)：URL 索引 `3`，原始标签 `GYM106174C` → `cf106174c`；对应官方题解文件已核实存在。
- [daily_problems/2026/02/0220/problems.md:3](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2026/02/0220/problems.md#L3)：URL 索引 `2`，原始标签 `GYM106247B` → `cf106247b`；对应官方题解文件已核实存在。
- [daily_problems/2026/02/0220/problems.md:4](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2026/02/0220/problems.md#L4)：URL 索引 `4`，原始标签 `GYM106247D` → `cf106247d`；对应官方题解文件已核实存在。

## 原仓库标签与链接不一致

这些是原始资料问题，作为警告单独记录，不伪装成解析失败或悄悄更改原文。

- [daily_problems/2024/07/0712/problems.md:3](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2024/07/0712/problems.md#L3)：标签 `CF922B`，URL 标识 `cf992b`；URL 标识对应的官方题解文件存在。客户端保留 URL 题号，并展示来源警告。
- [daily_problems/2024/09/0924/problems.md:3](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2024/09/0924/problems.md#L3)：标签 `CF436E`，URL 标识 `cf436c`；URL 标识对应的官方题解文件存在。客户端保留 URL 题号，并展示来源警告。
- [daily_problems/2025/06/0621/problems.md:4](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2025/06/0621/problems.md#L4)：标签 `CF790A3`，URL 标识 `cf690a3`；URL 标识对应的官方题解文件存在。客户端保留 URL 题号，并展示来源警告。
- [daily_problems/2025/10/1031/problems.md:4](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2025/10/1031/problems.md#L4)：标签 `GYM104873I`，URL 标识 `cf104871i`；URL 标识对应的官方题解文件存在。客户端保留 URL 题号，并展示来源警告。
- [daily_problems/2026/07/0731/problems.md:4](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/f8122f4ae8e41e8cefde01c903947844fae72aec/daily_problems/2026/07/0731/problems.md#L4)：标签 `GYM106631F`，URL 标识 `cf106631a`；URL 标识对应的官方题解文件存在。客户端保留 URL 题号，并展示来源警告。

## 检查方式与复现

审计脚本从原始 Markdown 独立提取日期、题目行、URL、题号、数字与星号标记，再与生产解析器逐行比较；验证没有漏题或凭空多题，Gym 与常规比赛都保持仓库要求的 `cf` 文件名前缀。程序不使用生产解析器的日期、题号或 URL 辅助函数生成预期值。另以 `git ls-tree` 核对所有应检出的题单，避免稀疏检出漏文件造成虚假的全量通过。

```powershell
git clone --depth 1 --filter=blob:none --sparse https://github.com/Yawn-Sean/Daily_CF_Problems.git .cache/upstream
git -C .cache/upstream sparse-checkout set --no-cone '/README.md' '/daily_problems/**/problems.md'
npm run test:corpus
```

这次测试固定在以上提交，不能证明未来所有可能的 Markdown 格式都受支持；更新本地克隆后再次执行即可审计新题单。重新运行脚本会在本机生成 `docs/corpus-audit.json`，包含完整机器可读结果与失败详情；该文件不随源码仓库分发。

