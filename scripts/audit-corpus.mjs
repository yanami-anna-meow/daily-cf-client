import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkout = path.resolve(workspace, process.argv[2] ?? '.cache/upstream');
const relativePath = (filename) => path.relative(checkout, filename).split(path.sep).join('/');
const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const remote = execFileSync('git', ['-C', checkout, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
if (!/^https:\/\/github\.com\/Yawn-Sean\/Daily_CF_Problems(?:\.git)?\/?$/i.test(remote)) {
  throw new Error(`审计目录必须来自官方上游仓库，当前 origin 为 ${remote}`);
}
const bundled = await build({
  entryPoints: [path.join(workspace, 'shared/domain.ts')], bundle: true, format: 'esm',
  platform: 'browser', write: false,
});
const { PARSER_VERSION, parseProblems } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const changedSources = execFileSync('git', ['-C', checkout, 'diff', '--name-only', 'HEAD', '--', 'daily_problems'], { encoding: 'utf8' }).trim();
if (changedSources) throw new Error(`语料工作区已修改，不能将结果归属于固定上游提交：\n${changedSources}`);

async function listSheets(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listSheets(filename));
    else if (entry.isFile() && entry.name === 'problems.md') files.push(filename);
  }
  return files;
}

const failures = [];
const warnings = [];
const customGymMappings = [];
const fail = (file, line, message, data) => failures.push({ file, ...(line ? { line } : {}), message, ...(data ? { data } : {}) });
const counts = { days: 0, rows: 0, parsed: 0, rated: 0, unrated: 0 };
const matrix = { official: { gym: 0, round: 0 }, estimated: { gym: 0, round: 0 }, unknown: { gym: 0, round: 0 } };
const examples = {};
const dates = [];

// Independent source interpretation: this code never calls any domain helpers
// to derive expected dates, URLs, IDs, rating sources or contest kinds.
function sourceDate(file) {
  const match = /^daily_problems\/(\d{4})\/(\d{2})\/(\d{2})(\d{2})\/problems\.md$/.exec(file);
  if (!match || match[2] !== match[3]) return null;
  const date = `${match[1]}-${match[2]}-${match[4]}`;
  const value = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(value.getTime()) && value.toISOString().slice(0, 10) === date ? date : null;
}

function sourceProblem(line, lineNumber, file) {
  if (!/^\s*\|/.test(line)) return null;
  const links = [...line.matchAll(/\[([^\]]+)\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)];
  const firstCell = line.trim().split('|')[1]?.trim() ?? '';
  if (!links.length) {
    if (/^\*?\d+$/.test(firstCell)) fail(file, lineNumber, '数字难度行没有可识别的题目链接', { line });
    return null;
  }
  let selected;
  for (const link of links) {
    try {
      const url = new URL(link[2]);
      if (!['codeforces.com', 'www.codeforces.com'].includes(url.hostname.toLowerCase())) continue;
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) continue;
      const parts = url.pathname.split('/').filter(Boolean);
      let contestId, index, kind;
      if (parts.length === 4 && parts[0].toLowerCase() === 'problemset' && parts[1].toLowerCase() === 'problem') {
        [, , contestId, index] = parts; kind = 'round';
      } else if (parts.length === 4 && ['contest', 'gym'].includes(parts[0].toLowerCase()) && parts[2].toLowerCase() === 'problem') {
        [, contestId, , index] = parts; kind = parts[0].toLowerCase() === 'gym' ? 'gym' : 'round';
      } else continue;
      if (!/^[1-9]\d*$/.test(contestId)) continue;
      const labelMatch = /^(?:CF|GYM)([1-9]\d*)([a-z]\d*)$/i.exec(link[1].trim());
      const normalIndex = /^[a-z]\d*$/i.test(index);
      if (!normalIndex) {
        if (kind !== 'gym' || !/^\d+(?:\.[a-z]\d*)?$/i.test(index) || !labelMatch || labelMatch[1] !== contestId) continue;
        customGymMappings.push({ file, line: lineNumber, label: link[1], urlIndex: index, id: `cf${contestId}${labelMatch[2].toLowerCase()}` });
      }
      const id = `cf${contestId}${normalIndex ? index.toLowerCase() : labelMatch[2].toLowerCase()}`;
      const labelMismatch = normalIndex && labelMatch && `cf${labelMatch[1]}${labelMatch[2].toLowerCase()}` !== id;
      if (labelMismatch) warnings.push({ file, line: lineNumber, type: 'label-url-mismatch', label: link[1], canonicalId: id, url: url.toString(), message: '原仓库显示题号与题目 URL 不一致；保留 URL 题号并向用户展示来源警告。' });
      selected = { label: link[1], id, url: link[2], kind, labelMismatch: Boolean(labelMismatch) };
      break;
    } catch { /* Non-URL links are not problem links. */ }
  }
  if (!selected) {
    fail(file, lineNumber, '题单数据行未能独立识别 Codeforces 题目链接', { line });
    return null;
  }
  const numeric = /^\*?\d+$/.test(firstCell);
  return { ...selected, rating: numeric ? Number(firstCell.replace('*', '')) : null,
    ratingSource: numeric ? firstCell.startsWith('*') ? 'estimated' : 'official' : 'unknown', line: lineNumber, difficultyCell: firstCell };
}

const sheets = (await listSheets(path.join(checkout, 'daily_problems'))).sort();
if (!sheets.length) throw new Error('没有发现 problems.md；请先配置 sparse-checkout 下载全部题单。');
// A Git index inventory independently verifies that sparse checkout did not omit
// any tracked problems.md; merely checking the working tree would miss that.
const trackedPaths = execFileSync('git', ['-C', checkout, 'ls-tree', '-r', '--name-only', 'HEAD', 'daily_problems'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  .split(/\r?\n/).filter(Boolean);
const tracked = trackedPaths.filter((name) => name.endsWith('/problems.md'));
const trackedPathSet = new Set(trackedPaths);
const actual = new Set(sheets.map(relativePath));
for (const name of tracked) if (!actual.has(name)) fail(name, null, 'Git 提交中存在该题单，但稀疏工作区未检出');

for (const filename of sheets) {
  const file = relativePath(filename);
  const date = sourceDate(file);
  if (!date) { fail(file, null, '日期目录结构不合法'); continue; }
  dates.push(date);
  counts.days++;
  const markdown = await fs.readFile(filename, 'utf8');
  const expected = markdown.split(/\r?\n/).map((line, i) => sourceProblem(line, i + 1, file)).filter(Boolean);
  counts.rows += expected.length;
  let parsed;
  try { parsed = parseProblems(markdown, date); }
  catch (error) { fail(file, null, '解析器抛出异常', { error: String(error) }); continue; }
  counts.parsed += parsed.length;
  if (parsed.length !== expected.length) fail(file, null, '原始有效题目行数与解析结果数量不一致（漏题或多出题目）', { expected: expected.length, parsed: parsed.length });
  for (const [i, source] of expected.entries()) {
    matrix[source.ratingSource][source.kind]++;
    counts[source.rating === null ? 'unrated' : 'rated']++;
    examples[`${source.ratingSource}:${source.kind}`] ??= { file, date, line: source.line, id: source.id, label: source.label, rating: source.rating, difficultyCell: source.difficultyCell, url: source.url };
    const problem = parsed[i];
    if (!problem) continue;
    for (const field of ['id', 'label', 'url', 'rating', 'ratingSource', 'kind']) {
      if (problem[field] !== source[field]) fail(file, source.line, `${field} 不符合原始题单`, { expected: source[field], parsed: problem[field], id: source.id });
    }
    if (source.labelMismatch && !problem.sourceWarning) fail(file, source.line, '原仓库题号不一致但解析器没有提供来源警告', { id: source.id });
  }
}

for (const mapping of customGymMappings) {
  const solutionPath = mapping.file.replace(/problems\.md$/, `solution/${mapping.id}.md`);
  mapping.solutionPath = solutionPath;
  mapping.solutionExists = trackedPathSet.has(solutionPath);
  if (!mapping.solutionExists) fail(mapping.file, mapping.line, '特殊 Gym 题号映射缺少对应的原仓库官方题解文件佐证', { id: mapping.id, solutionPath });
}
for (const warning of warnings) {
  warning.solutionPath = warning.file.replace(/problems\.md$/, `solution/${warning.canonicalId}.md`);
  warning.solutionExists = trackedPathSet.has(warning.solutionPath);
}

const report = {
  auditedAt: new Date().toISOString(), repository: 'Yawn-Sean/Daily_CF_Problems', remote, commit, parserVersion: PARSER_VERSION,
  checkout: '.cache/upstream', scope: '全部 Git HEAD 已跟踪的 daily_problems/**/problems.md；浅克隆稀疏检出，无个人代码文件',
  trackedSheets: tracked.length, dateRange: { first: dates.sort()[0], last: dates.at(-1) },
  counts, matrix, examples, customGymMappings, warnings, passed: failures.length === 0, failures,
};
await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
await fs.writeFile(path.join(workspace, 'docs/corpus-audit.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const rows = ['official', 'estimated', 'unknown'].map((source) => `| ${{ official: 'CF 官方（无星号数字）', estimated: '小羊估算（星号数字）', unknown: '未知 / 未评级' }[source]} | ${matrix[source].gym} | ${matrix[source].round} |`).join('\n');
const samples = Object.entries(examples).map(([combination, sample]) => `- **${combination}**：${sample.date}，原始难度 \`${sample.difficultyCell}\`，题号 \`${sample.id}\`。[原始题单](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/${commit}/${sample.file}#L${sample.line})， [题目](${sample.url})。`).join('\n');
const missing = ['official:gym', 'official:round', 'estimated:gym', 'estimated:round'].filter((key) => !examples[key]);
const mappingNotes = customGymMappings.map((mapping) => `- [${mapping.file}:${mapping.line}](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/${commit}/${mapping.file}#L${mapping.line})：URL 索引 \`${mapping.urlIndex}\`，原始标签 \`${mapping.label}\` → \`${mapping.id}\`；${mapping.solutionExists ? '对应官方题解文件已核实存在' : '缺少对应题解文件'}。`).join('\n');
const warningNotes = warnings.map((warning) => `- [${warning.file}:${warning.line}](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/${commit}/${warning.file}#L${warning.line})：标签 \`${warning.label}\`，URL 标识 \`${warning.canonicalId}\`；${warning.solutionExists ? 'URL 标识对应的官方题解文件存在' : 'URL 标识未发现对应题解文件'}。客户端保留 URL 题号，并展示来源警告。`).join('\n');
const summary = `# 真实仓库题单解析审计\n\n本报告由 \`npm run test:corpus\` 自动生成。审计结果：**${report.passed ? '通过' : '未通过'}**。\n\n- 上游：[Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems)。\n- 提交：[\`${commit}\`](https://github.com/Yawn-Sean/Daily_CF_Problems/commit/${commit})。\n- 审计时间（UTC）：${report.auditedAt}。\n- 覆盖范围：${counts.days} 份真实题单，${counts.rows} 行有效题目，解析器输出 ${counts.parsed} 道题；Git 提交清单确认题单总数 ${tracked.length}，没有仅抽样检查。\n- 日期范围：${report.dateRange.first} 至 ${report.dateRange.last}。\n- 解析错误数：${failures.length}；原仓库来源警告数：${warnings.length}。\n\n## 难度来源与题目类型独立统计\n\n\`*1000\` 代表小羊估算难度，\`1000\` 代表 CF 官方难度；没有数字时来源为未知。题目类型只依据链接中的 \`/gym/\`、\`/contest/\` 或 \`/problemset/\` 路径识别，两者互不推导。\n\n| 难度来源 | Gym | 常规比赛 |\n| --- | ---: | ---: |\n${rows}\n\n${samples}\n\n${missing.length ? `本次真实语料未出现以下组合：${missing.join('、')}。缺失只是语料现状，不代表逻辑上不可能；单元测试另外覆盖四种已知来源与类型组合及缺失难度。` : '本次语料包含四种已知来源与类型组合；单元测试也独立覆盖四种组合及缺失难度。'}\n\n## 特殊 Gym 路径映射\n\n部分 Gym 导入题目使用数字或带点的原始 URL 索引，不能直接当作仓库文件名。以下 ${customGymMappings.length} 行通过同比赛的原仓库标签识别 canonical cf 题号，并独立核验 Git 提交内对应官方题解文件存在。\n\n${mappingNotes || '没有特殊映射。'}\n\n## 原仓库标签与链接不一致\n\n这些是原始资料问题，作为警告单独记录，不伪装成解析失败或悄悄更改原文。\n\n${warningNotes || '没有来源警告。'}\n\n## 检查方式与复现\n\n审计脚本从原始 Markdown 独立提取日期、题目行、URL、题号、数字与星号标记，再与生产解析器逐行比较；验证没有漏题或凭空多题，Gym 与常规比赛都保持仓库要求的 \`cf\` 文件名前缀。程序不使用生产解析器的日期、题号或 URL 辅助函数生成预期值。另以 \`git ls-tree\` 核对所有应检出的题单，避免稀疏检出漏文件造成虚假的全量通过。\n\n\`\`\`powershell\ngit clone --depth 1 --filter=blob:none --sparse https://github.com/Yawn-Sean/Daily_CF_Problems.git .cache/upstream\ngit -C .cache/upstream sparse-checkout set --no-cone '/README.md' '/daily_problems/**/problems.md'\nnpm run test:corpus\n\`\`\`\n\n这次测试固定在以上提交，不能证明未来所有可能的 Markdown 格式都受支持；更新本地克隆后再次执行即可审计新题单。完整机器可读结果与失败详情见 [corpus-audit.json](./corpus-audit.json)。\n${failures.length ? `\n## 失败记录\n\n\`\`\`json\n${JSON.stringify(failures, null, 2)}\n\`\`\`\n` : ''}`;
await fs.writeFile(path.join(workspace, 'docs/corpus-audit.md'), summary, 'utf8');
console.log(JSON.stringify({ commit, ...counts, matrix, customGymMappings: customGymMappings.length, warnings: warnings.length, failures: failures.length, reports: ['docs/corpus-audit.json', 'docs/corpus-audit.md'] }, null, 2));
if (failures.length) { console.error(JSON.stringify(failures.slice(0, 20), null, 2)); process.exitCode = 1; }
