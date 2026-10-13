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
  throw new Error(`The audit checkout must use the official upstream repository; current origin: ${remote}`);
}
const bundled = await build({
  entryPoints: [path.join(workspace, 'shared/domain.ts')], bundle: true, format: 'esm',
  platform: 'browser', write: false,
});
const { PARSER_VERSION, parseProblems } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const changedSources = execFileSync('git', ['-C', checkout, 'diff', '--name-only', 'HEAD', '--', 'daily_problems'], { encoding: 'utf8' }).trim();
if (changedSources) throw new Error(`The corpus has local changes, so results cannot be attributed to a fixed upstream commit:\n${changedSources}`);

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
    if (/^\*?\d+$/.test(firstCell)) fail(file, lineNumber, 'A row with a numeric rating has no recognizable problem link.', { line });
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
      if (labelMismatch) warnings.push({ file, line: lineNumber, type: 'label-url-mismatch', label: link[1], canonicalId: id, url: url.toString(), message: 'The upstream label and problem URL disagree; retain the ID from the URL and show a source warning.' });
      selected = { label: link[1], id, url: link[2], kind, labelMismatch: Boolean(labelMismatch) };
      break;
    } catch { /* Non-URL links are not problem links. */ }
  }
  if (!selected) {
    fail(file, lineNumber, 'Independent source inspection could not identify a Codeforces problem link in this row.', { line });
    return null;
  }
  const numeric = /^\*?\d+$/.test(firstCell);
  return { ...selected, rating: numeric ? Number(firstCell.replace('*', '')) : null,
    ratingSource: numeric ? firstCell.startsWith('*') ? 'estimated' : 'official' : 'unknown', line: lineNumber, difficultyCell: firstCell };
}

const sheets = (await listSheets(path.join(checkout, 'daily_problems'))).sort();
if (!sheets.length) throw new Error('No problems.md files found. Configure sparse checkout to include all problem sheets first.');
// A Git index inventory independently verifies that sparse checkout did not omit
// any tracked problems.md; merely checking the working tree would miss that.
const trackedPaths = execFileSync('git', ['-C', checkout, 'ls-tree', '-r', '--name-only', 'HEAD', 'daily_problems'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  .split(/\r?\n/).filter(Boolean);
const tracked = trackedPaths.filter((name) => name.endsWith('/problems.md'));
const trackedPathSet = new Set(trackedPaths);
const actual = new Set(sheets.map(relativePath));
for (const name of tracked) if (!actual.has(name)) fail(name, null, 'This problem sheet is tracked in the Git commit but missing from the sparse checkout.');

for (const filename of sheets) {
  const file = relativePath(filename);
  const date = sourceDate(file);
  if (!date) { fail(file, null, 'The date directory structure is invalid.'); continue; }
  dates.push(date);
  counts.days++;
  const markdown = await fs.readFile(filename, 'utf8');
  const expected = markdown.split(/\r?\n/).map((line, i) => sourceProblem(line, i + 1, file)).filter(Boolean);
  counts.rows += expected.length;
  let parsed;
  try { parsed = parseProblems(markdown, date); }
  catch (error) { fail(file, null, 'The parser threw an exception.', { error: String(error) }); continue; }
  counts.parsed += parsed.length;
  if (parsed.length !== expected.length) fail(file, null, 'The parsed problem count differs from the valid source-row count (missing or extra problems).', { expected: expected.length, parsed: parsed.length });
  for (const [i, source] of expected.entries()) {
    matrix[source.ratingSource][source.kind]++;
    counts[source.rating === null ? 'unrated' : 'rated']++;
    examples[`${source.ratingSource}:${source.kind}`] ??= { file, date, line: source.line, id: source.id, label: source.label, rating: source.rating, difficultyCell: source.difficultyCell, url: source.url };
    const problem = parsed[i];
    if (!problem) continue;
    for (const field of ['id', 'label', 'url', 'rating', 'ratingSource', 'kind']) {
      if (problem[field] !== source[field]) fail(file, source.line, `${field} does not match the source problem sheet.`, { expected: source[field], parsed: problem[field], id: source.id });
    }
    if (source.labelMismatch && !problem.sourceWarning) fail(file, source.line, 'The upstream problem IDs disagree, but the parser did not provide a source warning.', { id: source.id });
  }
}

for (const mapping of customGymMappings) {
  const solutionPath = mapping.file.replace(/problems\.md$/, `solution/${mapping.id}.md`);
  mapping.solutionPath = solutionPath;
  mapping.solutionExists = trackedPathSet.has(solutionPath);
  if (!mapping.solutionExists) fail(mapping.file, mapping.line, 'The custom Gym ID mapping has no corresponding upstream editorial file to verify it.', { id: mapping.id, solutionPath });
}
for (const warning of warnings) {
  warning.solutionPath = warning.file.replace(/problems\.md$/, `solution/${warning.canonicalId}.md`);
  warning.solutionExists = trackedPathSet.has(warning.solutionPath);
}

const report = {
  auditedAt: new Date().toISOString(), repository: 'Yawn-Sean/Daily_CF_Problems', remote, commit, parserVersion: PARSER_VERSION,
  checkout: '.cache/upstream', scope: 'All daily_problems/**/problems.md files tracked at Git HEAD; shallow sparse checkout without personal submission files.',
  trackedSheets: tracked.length, dateRange: { first: dates.sort()[0], last: dates.at(-1) },
  counts, matrix, examples, customGymMappings, warnings, passed: failures.length === 0, failures,
};
await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
await fs.writeFile(path.join(workspace, 'docs/corpus-audit.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const rows = ['official', 'estimated', 'unknown'].map((source) => `| ${{ official: 'Codeforces rating (unstarred)', estimated: 'Estimated by Yawn Sean (starred)', unknown: 'Unknown / unrated' }[source]} | ${matrix[source].gym} | ${matrix[source].round} |`).join('\n');
const samples = Object.entries(examples).map(([combination, sample]) => `- **${combination}**: ${sample.date}, source difficulty \`${sample.difficultyCell}\`, problem ID \`${sample.id}\`. [Source sheet](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/${commit}/${sample.file}#L${sample.line}), [problem](${sample.url}).`).join('\n');
const missing = ['official:gym', 'official:round', 'estimated:gym', 'estimated:round'].filter((key) => !examples[key]);
const mappingNotes = customGymMappings.map((mapping) => `- [${mapping.file}:${mapping.line}](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/${commit}/${mapping.file}#L${mapping.line}): URL index \`${mapping.urlIndex}\`, source label \`${mapping.label}\` → \`${mapping.id}\`; ${mapping.solutionExists ? 'the corresponding upstream editorial file exists' : 'the corresponding editorial file is missing'}.`).join('\n');
const warningNotes = warnings.map((warning) => `- [${warning.file}:${warning.line}](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/${commit}/${warning.file}#L${warning.line}): label \`${warning.label}\`, URL ID \`${warning.canonicalId}\`; ${warning.solutionExists ? 'an upstream editorial exists for the URL ID' : 'no editorial was found for the URL ID'}. The client retains the ID from the URL and shows a source warning.`).join('\n');
const summary = `# Upstream problem-sheet parser audit

English · [简体中文](zh-CN/corpus-audit.md)

Generated by \`npm run test:corpus\`. Audit result: **${report.passed ? 'Passed' : 'Failed'}**.

- Upstream: [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems).
- Commit: [\`${commit}\`](https://github.com/Yawn-Sean/Daily_CF_Problems/commit/${commit}).
- Audited at (UTC): ${report.auditedAt}.
- Coverage: ${counts.days} upstream problem sheets, ${counts.rows} valid source rows, and ${counts.parsed} parsed problems. The Git tree lists ${tracked.length} sheets; the audit checks the full set rather than a sample.
- Date range: ${report.dateRange.first} to ${report.dateRange.last}.
- Parser failures: ${failures.length}; upstream source warnings: ${warnings.length}.

## Rating source and contest type

\`*1000\` denotes Yawn Sean's estimated difficulty; \`1000\` denotes a Codeforces rating. A missing numeric rating has an unknown source. Contest type is identified only from the link's \`/gym/\`, \`/contest/\`, or \`/problemset/\` path. Neither property is inferred from the other.

| Rating source | Gym | CF Round |
| --- | ---: | ---: |
${rows}

${samples}

${missing.length ? `The corpus contains no examples of these combinations: ${missing.join(', ')}. Their absence does not make them invalid; separate unit tests cover all four known rating-source/type combinations and missing ratings.` : 'The corpus contains all four known rating-source/type combinations. Separate unit tests also cover all four combinations and missing ratings.'}

## Custom Gym URL mappings

Some imported Gym problems use numeric or dotted URL indices that cannot serve directly as repository filenames. For the following ${customGymMappings.length} rows, the canonical \`cf\` ID comes from the upstream label for the same contest. The audit independently checks for the corresponding upstream editorial file in the Git commit.

${mappingNotes || 'No custom mappings.'}

## Upstream label and URL mismatches

These source inconsistencies are recorded as warnings. They are not treated as parser failures, and the source text is not silently rewritten.

${warningNotes || 'No source warnings.'}

## Method and reproduction

The script independently extracts dates, problem rows, URLs, IDs, numeric ratings, and star markers from the source Markdown, then compares each row with the production parser. It checks for missing or extra problems and verifies that both Gym and CF Round problems retain the repository's \`cf\` filename prefix. Expected values do not use the production parser's date, ID, or URL helpers. A separate \`git ls-tree\` inventory checks for sheets omitted by sparse checkout, so an incomplete checkout cannot produce a misleading full-corpus pass.

\`\`\`sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/Yawn-Sean/Daily_CF_Problems.git .cache/upstream
git -C .cache/upstream sparse-checkout set --no-cone '/README.md' '/daily_problems/**/problems.md'
npm run test:corpus
\`\`\`

This result applies to the commit listed above and does not establish support for every future Markdown format. Update the local checkout and rerun the audit to check newer sheets. Machine-readable results and failure details are available in [corpus-audit.json](./corpus-audit.json).
${failures.length ? `
## Failures

\`\`\`json
${JSON.stringify(failures, null, 2)}
\`\`\`
` : ''}`;
await fs.writeFile(path.join(workspace, 'docs/corpus-audit.md'), summary, 'utf8');
console.log(JSON.stringify({ commit, ...counts, matrix, customGymMappings: customGymMappings.length, warnings: warnings.length, failures: failures.length, reports: ['docs/corpus-audit.json', 'docs/corpus-audit.md'] }, null, 2));
if (failures.length) { console.error(JSON.stringify(failures.slice(0, 20), null, 2)); process.exitCode = 1; }
