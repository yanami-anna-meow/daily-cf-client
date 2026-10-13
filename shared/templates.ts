import { t, getLocale } from './i18n';
import { normalizeProblemId, submissionExtension, submissionPath, validateSubmission } from './domain';
import { extensionLanguageLabel } from './file-formats';
import type { BatchSubmissionInput, Problem, SubmissionInput } from './types';

export const DEFAULT_PR_TITLE = '{{date_compact}} 解题提交（{{problem_count}} 题）';
export const DEFAULT_PR_BODY = `## 解题提交

- 日期：{{date_range}}
- 题目：{{problem_count}} 题，共 {{file_count}} 个文件
- 作者：{{author}}

{{problem_list}}

## 说明

{{notes}}`;

/** Resolve product defaults at use time; saved user template strings remain unchanged. */
export function getDefaultPRTitleTemplate(): string { return t(DEFAULT_PR_TITLE); }
export function getDefaultPRBodyTemplate(): string { return t(DEFAULT_PR_BODY); }

/** Names are used as {{name}} in templates. Values are plain text, never evaluated as code. */
export const TEMPLATE_VARIABLES = [
  { name: 'date', label: '题目日期（多题取最早日期）', example: '2026-10-07' },
  { name: 'date_compact', label: '题目日期（标题前缀）', example: '20261007' },
  { name: 'problem_id', label: '仓库题号', example: 'cf1234a、cf773a' },
  { name: 'problem_label', label: '题目名称', example: 'CF1234A、CF773A' },
  { name: 'problem_url', label: '原题链接', example: 'https://codeforces.com/problemset/problem/1234/A' },
  { name: 'rating', label: '题目难度', example: '*1000、1700' },
  { name: 'rating_source', label: '难度来源', example: '小羊估算 / CF 官方 / 未知' },
  { name: 'problem_type', label: '题目类型', example: 'Gym、CF Round' },
  { name: 'language', label: '编程语言', example: 'C++、Python' },
  { name: 'extension', label: '文件扩展名', example: 'cpp、py' },
  { name: 'author', label: '提交署名', example: 'alice' },
  { name: 'filename', label: '提交文件名', example: 'cf1234a_alice.cpp' },
  { name: 'path', label: '仓库内文件路径', example: 'daily_problems/2026/10/1007/personal_submission/cf1234a_alice.cpp' },
  { name: 'notes', label: '本次提交说明', example: '使用前缀和，时间复杂度 O(n)。' },
  { name: 'login', label: 'GitHub 用户名', example: 'alice-github' },
  { name: 'problem_count', label: '题目数量', example: '2' },
  { name: 'file_count', label: '文件数量', example: '3' },
  { name: 'problem_list', label: '题目及文件明细表', example: '包含所有题目的日期、链接、难度、类型、语言及文件' },
  { name: 'file_list', label: '提交文件列表', example: '- `daily_problems/2026/10/1007/personal_submission/cf1234a_alice.cpp`' },
  { name: 'date_range', label: '题目日期范围', example: '2026-10-01 ～ 2026-10-07' }
] as const;

type TemplateVariable = typeof TEMPLATE_VARIABLES[number]['name'];
type TemplateValues = Partial<Record<TemplateVariable, string>>;
type SingleValues = Omit<Record<TemplateVariable, string>, 'problem_count' | 'file_count' | 'problem_list' | 'file_list' | 'date_range'>;
const RESERVED_MARKER = /<!--\s*daily-cf-/i;

function expand(template: string, values: TemplateValues, field: string): string {
  if (typeof template !== 'string') throw new Error(t('{{field}}模板必须是文本。', { field }));
  if (RESERVED_MARKER.test(template)) throw new Error(t('{{field}}模板包含客户端保留标记，请删除 daily-cf- 注释。', { field }));

  // Validate the source before substitution: notes and labels may themselves contain {{...}}.
  const pattern = /(?<!\{)\{\{([^{}]*)\}\}(?!\})/g;
  if (/\{\{|\}\}/.test(template.replace(pattern, ''))) {
    throw new Error(t('{{field}}模板的变量格式不完整，请使用 {{变量名}}。', { field }));
  }
  return template.replace(pattern, (_match, rawName: string) => {
    const name = rawName.trim();
    if (!Object.hasOwn(values, name)) throw new Error(t('{{field}}模板包含不支持的变量「{{name}}」，请从变量列表中选择。', { field, name: name || t('空变量') }));
    return values[name as TemplateVariable]!;
  });
}

function fallbackProblem(input: SubmissionInput): Pick<Problem, 'label' | 'url'> {
  const match = /^cf(\d+)([a-z]\d*)$/.exec(input.problemId)!;
  const [, contest, index] = match;
  const gym = Number(contest) >= 100_000;
  return {
    label: `${gym ? 'GYM' : 'CF'}${contest}${index.toUpperCase()}`,
    url: gym
      ? `https://codeforces.com/gym/${contest}/problem/${index.toUpperCase()}`
      : `https://codeforces.com/problemset/problem/${contest}/${index.toUpperCase()}`
  };
}

function problemType(problem: Pick<Problem, 'url' | 'kind'>): string {
  if (problem.kind === 'gym') return 'Gym';
  if (problem.kind === 'round') return 'CF Round';
  try {
    const url = new URL(problem.url);
    if (/^\/gym\//i.test(url.pathname)) return 'Gym';
    if (/^\/(?:contest|problemset)\//i.test(url.pathname)) return 'CF Round';
  } catch { /* Missing legacy metadata is not a reason to guess from its difficulty. */ }
  return t('未知');
}

function singleValues(
  input: SubmissionInput,
  context: { login: string; problem?: Problem }
): SingleValues {
  const normalized = validateSubmission(input);
  const path = submissionPath(normalized);
  const extension = submissionExtension(normalized);
  if (context.problem && normalizeProblemId(context.problem.id) !== normalized.problemId) {
    throw new Error(t('题目信息与提交题号不一致，请重新选择题目。'));
  }
  const problem = context.problem ?? fallbackProblem(normalized);
  const values: SingleValues = {
    date: normalized.date,
    date_compact: normalized.date.replaceAll('-', ''),
    problem_id: normalized.problemId,
    problem_label: problem.label,
    problem_url: problem.url,
    rating: typeof context.problem?.rating === 'number' && Number.isFinite(context.problem.rating)
      ? `${context.problem.ratingSource === 'estimated' ? '*' : ''}${context.problem.rating}` : t('未评级'),
    rating_source: context.problem?.ratingSource === 'estimated' ? t('小羊估算') : context.problem?.ratingSource === 'official' ? t('CF 官方') : t('未知'),
    problem_type: problemType(problem),
    language: extensionLanguageLabel(extension),
    extension,
    author: normalized.author,
    filename: path.slice(path.lastIndexOf('/') + 1),
    path,
    notes: normalized.notes,
    login: context.login
  };
  if (RESERVED_MARKER.test(normalized.notes)) throw new Error(t('提交说明包含客户端保留标记，请删除 daily-cf- 注释。'));
  if (Object.values(values).some(value => RESERVED_MARKER.test(value))) throw new Error(t('提交内容包含客户端保留标记，请删除 daily-cf- 注释。'));
  return values;
}

function tableText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\\`*_[\]{}<>|]/g, '\\$&');
}

function tableProblemLink(row: SingleValues): string {
  if (/[\u0000-\u0020\u007f]/.test(row.problem_url)) return tableText(row.problem_label);
  let url: URL;
  try { url = new URL(row.problem_url); }
  catch { return tableText(row.problem_label); }
  if (!['https:', 'http:'].includes(url.protocol) || !['codeforces.com', 'www.codeforces.com'].includes(url.hostname) || url.username || url.password || url.port) {
    return tableText(row.problem_label);
  }
  const target = row.problem_url.replace(/[()|\\<>"`]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/&/g, '&amp;');
  return `[${tableText(row.problem_label)}](${target})`;
}

function codeSpan(value: string): string {
  const longestRun = Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const content = value.startsWith('`') || value.endsWith('`') ? ` ${value} ` : value;
  return `${fence}${content}${fence}`;
}

function aggregateValues(rows: SingleValues[]): TemplateValues {
  const dates = rows.map(row => row.date).sort();
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const header = t('| 日期 | 题目 | 难度 | 类型 | 语言 | 文件 | 说明 |') + '\n| --- | --- | --- | --- | --- | --- | --- |';
  const details = rows.map(row => `| ${row.date} | ${tableProblemLink(row)} | ${tableText(row.rating)} | ${row.problem_type} | ${tableText(row.language)} | ${codeSpan(row.path)} | ${tableText(row.notes) || '—'} |`).join('\n');
  const joined = (name: keyof SingleValues): string => [...new Set(rows.map(row => row[name]))].join(getLocale() === 'en' ? ', ' : '、');
  return {
    date: firstDate,
    date_compact: firstDate.replaceAll('-', ''),
    date_range: firstDate === lastDate ? firstDate : t('{{first}} ～ {{last}}', { first: firstDate, last: lastDate }),
    problem_count: String(new Set(rows.map(row => `${row.date}/${row.problem_id}`)).size),
    file_count: String(rows.length),
    problem_list: `${header}\n${details}`,
    file_list: rows.map(row => `- ${codeSpan(row.path)}`).join('\n'),
    author: joined('author'),
    problem_id: joined('problem_id'),
    problem_label: joined('problem_label'),
    problem_url: joined('problem_url'),
    rating: joined('rating'),
    rating_source: joined('rating_source'),
    problem_type: joined('problem_type'),
    language: joined('language'),
    extension: joined('extension'),
    filename: joined('filename'),
    path: joined('path')
  };
}

function render(
  values: TemplateValues,
  templates?: { title?: string; body?: string }
): { title: string; body: string } {
  const select = (value: string | undefined, fallback: string, field: string): string => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string') throw new Error(t('{{field}}模板必须是文本。', { field }));
    return value.trim() ? value : fallback;
  };
  const titleText = expand(select(templates?.title, getDefaultPRTitleTemplate(), t('PR 标题')), values, t('PR 标题'));
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(titleText)) throw new Error(t('PR 标题必须是单行文本，不能包含换行或控制字符。'));
  const title = titleText.trim();
  const body = expand(select(templates?.body, getDefaultPRBodyTemplate(), t('PR 正文')), values, t('PR 正文')).replace(/\r\n?/g, '\n');
  if (!title.startsWith(`${values.date_compact} `)) throw new Error(t('PR 标题必须以题目日期 {{date}} 和一个空格开头；建议使用 {{date_compact}}。', { date: String(values.date_compact) }));
  if (title.length > 256) throw new Error(t('展开后的 PR 标题不能超过 256 个字符，请缩短模板或提交说明。'));
  if (body.length > 60_000) throw new Error(t('展开后的 PR 正文不能超过 60000 个字符，请缩短模板或提交说明。'));
  if (body.includes('\0')) throw new Error(t('PR 正文不能包含空字节。'));
  if (RESERVED_MARKER.test(title) || RESERVED_MARKER.test(body)) throw new Error(t('PR 内容包含客户端保留标记，请删除 daily-cf- 注释。'));
  return { title, body };
}

/** Render editable PR content. Internal ownership/retry markers are added only by the backend. */
export function renderPRTemplates(
  input: SubmissionInput,
  context: { login: string; problem?: Problem },
  templates?: { title?: string; body?: string }
): { title: string; body: string } {
  const values = singleValues(input, context);
  return render({ ...values, ...aggregateValues([values]) }, templates);
}

/** One template works for every file count. Repeated field values are joined after deduplication. */
export function renderBatchPRTemplates(
  input: Pick<BatchSubmissionInput, 'items' | 'notes'>,
  context: { login: string; problems: Problem[] },
  templates?: { title?: string; body?: string }
): { title: string; body: string } {
  if (!input || !Array.isArray(input.items) || !input.items.length) throw new Error(t('请至少选择一个待提交的题目。'));
  if (input.items.length > 50) throw new Error(t('一次提交最多包含 50 个代码文件。'));
  if (!Array.isArray(context.problems) || context.problems.length !== input.items.length) throw new Error(t('题目列表与提交文件数量不一致，请重新加载题目。'));
  if (typeof input.notes !== 'string') throw new Error(t('提交说明必须是文本。'));
  const notes = input.notes.trim();
  if (notes.length > 2000) throw new Error(t('提交说明不能超过 2000 个字符。'));
  if (RESERVED_MARKER.test(notes)) throw new Error(t('提交说明包含客户端保留标记，请删除 daily-cf- 注释。'));
  const rows = input.items.map((item, index) => {
    if (!context.problems[index]) throw new Error(t('题目列表包含缺失的题目信息，请重新加载题目。'));
    return singleValues(item, { login: context.login, problem: context.problems[index] });
  });
  const encoder = new TextEncoder();
  const totalBytes = input.items.reduce((total, item) => total + encoder.encode(validateSubmission(item).code).byteLength, 0);
  if (totalBytes > 5 * 1024 * 1024) throw new Error(t('一次提交的代码总大小不能超过 5 MiB。'));
  const paths = new Set<string>();
  for (const row of rows) {
    if (paths.has(row.path)) throw new Error(t('提交中存在重复文件「{{path}}」，请只保留一份。', { path: row.path }));
    paths.add(row.path);
  }
  const values = { ...aggregateValues(rows), login: context.login, notes };
  return render(values, templates);
}
