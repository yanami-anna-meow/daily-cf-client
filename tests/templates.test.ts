import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DEFAULT_PR_BODY, DEFAULT_PR_TITLE, renderBatchPRTemplates, renderPRTemplates, TEMPLATE_VARIABLES } from '../shared/templates';
import { LANGUAGES, type BatchSubmissionInput, type Problem, type SubmissionInput } from '../shared/types';
import { extensionLanguageLabel } from '../shared/file-formats';

const input: SubmissionInput = { date: '2024-03-19', problemId: ' CF773A ', language: 'cpp', author: ' alice ', code: 'int main() {}', notes: '  比例化简。  ' };
const problem: Problem = { id: 'cf773a', label: 'CF773A — Success Rate', url: 'https://codeforces.com/problemset/problem/773/A', rating: 1700, hint: '' };
const context = { login: 'alice-github', problem };

describe('PR templates', () => {
  it('preserves the repository title convention and defaults empty settings', () => {
    const rendered = renderPRTemplates(input, context);
    expect(rendered.title).toBe('20240319 解题提交（1 题）');
    const rows = renderMarkdown(rendered.body).match(/<tr>.*?<\/tr>/gs) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('href="https://codeforces.com/problemset/problem/773/A"');
    expect(rows[1]).toContain('CF773A — Success Rate');
    expect(rows[1]).toContain('C++');
    expect(rows[1]).toContain('daily_problems/2024/03/0319/personal_submission/cf773a_alice.cpp');
    expect(rendered.body).toContain('\n\n比例化简。');
    expect(rendered.body).not.toMatch(/daily-cf-(client|payload)/);
    expect(renderPRTemplates(input, context, { title: '', body: ' \n\t' })).toEqual(rendered);
    expect(renderPRTemplates(input, context, { title: DEFAULT_PR_TITLE, body: DEFAULT_PR_BODY })).toEqual(rendered);
  });

  it('expands every documented variable from the selected historic problem', () => {
    const batchNames = new Set(['problem_count', 'file_count', 'problem_list', 'file_list', 'date_range']);
    const template = TEMPLATE_VARIABLES.filter(({ name }) => !batchNames.has(name)).map(({ name }) => `{{${name}}}`).join('\n');
    const rendered = renderPRTemplates(input, context, { title: '{{date_compact}} {{ problem_id }} by {{login}}', body: template });
    expect(rendered.title).toBe('20240319 cf773a by alice-github');
    expect(rendered.body.split('\n')).toEqual([
      '2024-03-19', '20240319', 'cf773a', 'CF773A — Success Rate',
      'https://codeforces.com/problemset/problem/773/A', '1700', '未知', 'CF Round', 'C++', 'cpp', 'alice',
      'cf773a_alice.cpp', 'daily_problems/2024/03/0319/personal_submission/cf773a_alice.cpp',
      '比例化简。', 'alice-github'
    ]);
    expect(renderPRTemplates(input, context, { body: '{{problem_count}}|{{file_count}}|{{date_range}}' }).body).toBe('1|1|2024-03-19');
    const table = renderPRTemplates(input, context, { body: '{{problem_list}}' }).body;
    expect(table).toContain('2024-03-19');
    expect(table).toContain('[CF773A — Success Rate](https://codeforces.com/problemset/problem/773/A)');
    expect(table).toContain('1700');
    expect(table).toContain('CF Round');
    expect(table).toContain('C++');
    expect(table).toContain('`daily_problems/2024/03/0319/personal_submission/cf773a_alice.cpp`');
    expect(renderPRTemplates(input, context, { body: '{{file_list}}' }).body).toBe('- `daily_problems/2024/03/0319/personal_submission/cf773a_alice.cpp`');
  });

  it('uses real GYM metadata and preserves supplied original URLs', () => {
    const gymInput = { ...input, problemId: 'GYM106744G', language: 'py' as const };
    const gymProblem = { ...problem, id: 'cf106744g', label: 'GYM106744G', url: 'https://codeforces.com/gym/106744/problem/G' };
    const { title, body } = renderPRTemplates(gymInput, { login: context.login, problem: gymProblem });
    expect(title).toBe('20240319 解题提交（1 题）');
    expect(body).toContain('[GYM106744G](https://codeforces.com/gym/106744/problem/G)');
    expect(body).toContain('cf106744g_alice.py');
  });

  it('provides a useful fallback without optional problem metadata', () => {
    expect(renderPRTemplates(input, { login: 'alice' }).body).toContain('[CF773A](https://codeforces.com/problemset/problem/773/A)');
    expect(renderPRTemplates({ ...input, problemId: 'GYM106744G' }, { login: 'alice' }).body).toContain('[GYM106744G](https://codeforces.com/gym/106744/problem/G)');
  });

  it.each([
    ['estimated', 'gym', '小羊估算', 'Gym'],
    ['estimated', 'round', '小羊估算', 'CF Round'],
    ['official', 'gym', 'CF 官方', 'Gym'],
    ['official', 'round', 'CF 官方', 'CF Round'],
    ['unknown', 'gym', '未知', 'Gym'],
    ['unknown', 'round', '未知', 'CF Round']
  ] as const)('keeps rating source %s independent of problem type %s', (ratingSource, kind, expectedSource, expectedType) => {
    const metadata: Problem = { ...problem, ratingSource, kind };
    const rendered = renderPRTemplates(input, { ...context, problem: metadata }, { body: '{{rating}}|{{rating_source}}|{{problem_type}}' });
    const expectedRating = ratingSource === 'estimated' ? '*1700' : '1700';
    expect(rendered.body).toBe(`${expectedRating}|${expectedSource}|${expectedType}`);
    const defaultBody = renderPRTemplates(input, { ...context, problem: metadata }).body;
    const rows = renderMarkdown(defaultBody).match(/<tr>.*?<\/tr>/gs) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(`<td>${expectedRating}</td>`);
    expect(defaultBody).not.toMatch(/小羊估算|CF 官方|（未知）/);
    expect(rows[1]).toContain(`<td>${expectedType}</td>`);
  });

  it.each([
    ['https://codeforces.com/gym/106744/problem/G', 'Gym'],
    ['https://codeforces.com/contest/773/problem/A', 'CF Round'],
    ['https://codeforces.com/problemset/problem/773/A', 'CF Round']
  ])('derives missing type only from the original URL %s', (url, expectedType) => {
    for (const ratingSource of ['estimated', 'official', 'unknown'] as const) {
      const metadata = { ...problem, url, ratingSource };
      expect(renderPRTemplates(input, { ...context, problem: metadata }, { body: '{{problem_type}}' }).body).toBe(expectedType);
    }
  });

  it('reports missing rating and source explicitly without inferring from Gym', () => {
    const metadata: Problem = { ...problem, rating: null, kind: 'gym' };
    expect(renderPRTemplates(input, { ...context, problem: metadata }, { body: '{{rating}}|{{rating_source}}|{{problem_type}}' }).body).toBe('未评级|未知|Gym');
    expect(renderPRTemplates(input, { login: 'alice' }, { body: '{{rating}}|{{rating_source}}|{{problem_type}}' }).body).toBe('未评级|未知|CF Round');
    expect(renderPRTemplates(input, { ...context, problem: { ...problem, rating: Number.NaN } }, { body: '{{rating}}' }).body).toBe('未评级');
    expect(renderPRTemplates(input, { ...context, problem: { ...metadata, ratingSource: 'estimated' } }, { body: '{{rating}}' }).body).toBe('未评级');
  });

  it('does not guess the type from the difficulty or problem ID when a URL is unrecognized', () => {
    expect(renderPRTemplates(input, { ...context, problem: { ...problem, url: 'invalid', ratingSource: 'estimated' } }, { body: '{{rating_source}}|{{problem_type}}' }).body).toBe('小羊估算|未知');
  });

  it.each(LANGUAGES)('renders friendly language names and extension for $label', language => {
    expect(renderPRTemplates({ ...input, language: language.id }, context, { body: '{{language}}|{{extension}}' }).body).toBe(`${extensionLanguageLabel(language.extension)}|${language.extension}`);
  });

  it.each([
    ['c', 'C'], ['C', 'C++'], ['cxx', 'C++'], ['py3', 'Python'], ['d.ts', 'TypeScript'], ['MyLanguage', '.MyLanguage'],
    ['foo.cpp', 'C++'], ['foo.C', 'C++'], ['foo.c', 'C'],
  ])('keeps extension %s, language, filename and path consistent despite a stale language selection', (extension, label) => {
    const rendered = renderPRTemplates({ ...input, language: 'java', extension }, context, { body: '{{language}}|{{extension}}|{{filename}}|{{path}}' });
    expect(rendered.body).toBe(`${label}|${extension}|cf773a_alice.${extension}|daily_problems/2024/03/0319/personal_submission/cf773a_alice.${extension}`);
  });

  it('keeps custom backtick and Markdown-like suffixes literal in generated file tables and lists', () => {
    const extension = 'x`[custom]`';
    const rendered = renderPRTemplates({ ...input, extension }, context, { body: '{{problem_list}}\n\n{{file_list}}' });
    const html = renderMarkdown(rendered.body);
    expect(html).toContain('<code>daily_problems/2024/03/0319/personal_submission/cf773a_alice.x`[custom]`</code>');
    expect(html.match(/<tr>/g)).toHaveLength(2);
    expect(html.match(/<code>/g)).toHaveLength(2);
  });

  it('expands once so literal placeholders in notes cannot trigger substitution', () => {
    const notes = '{{login}} {{unknown}} $& $` $\' {{date_compact}}';
    const result = renderPRTemplates({ ...input, notes }, context, { body: '{{notes}}\n{{notes}}\n{{login}}' });
    expect(result.body).toBe(`${notes}\n${notes}\nalice-github`);
  });

  it.each(['{{unknown}}', '{{constructor}}', '{{toString}}', '{{__proto__}}', '{{}}', '{{date.toString()}}'])('rejects unsupported placeholders %s', body => {
    expect(() => renderPRTemplates(input, context, { body })).toThrow('不支持的变量');
  });

  it.each(['{{date', 'date}}', '{{{date}}}', '{{date} hello', '{{date}} {{notes', '{{date}} }}'])('rejects malformed placeholders %s', body => {
    expect(() => renderPRTemplates(input, context, { body })).toThrow('变量格式不完整');
  });

  it.each(['{{date}} {{problem_id}}', '20240320 {{problem_id}}', '{{date_compact}}: {{problem_id}}', '{{date_compact}} '])('requires the selected problem date and a following space in the title %s', title => {
    expect(() => renderPRTemplates(input, context, { title })).toThrow('必须以题目日期 20240319');
  });

  it.each(['\r', '\n', '\t', '\0', '\u007f', '\u2028', '\u2029'])('rejects title control characters and newlines %j', separator => {
    expect(() => renderPRTemplates(input, context, { title: `{{date_compact}} {{problem_id}}${separator}` })).toThrow('单行文本');
  });

  it('also rejects a multiline variable when used in the title', () => {
    expect(() => renderPRTemplates({ ...input, notes: 'first\nsecond' }, context, { title: '{{date_compact}} {{notes}}' })).toThrow('单行文本');
    expect(renderPRTemplates({ ...input, notes: 'first\nsecond' }, context, { body: '{{notes}}' }).body).toBe('first\nsecond');
  });

  it('checks size after expansion and normalizes body line endings', () => {
    expect(renderPRTemplates(input, context, { title: `{{date_compact}} ${'x'.repeat(247)}`, body: 'x'.repeat(60_000) }).title).toHaveLength(256);
    expect(() => renderPRTemplates(input, context, { title: `{{date_compact}} ${'x'.repeat(248)}` })).toThrow('256');
    expect(() => renderPRTemplates(input, context, { body: 'x'.repeat(60_001) })).toThrow('60000');
    expect(() => renderPRTemplates({ ...input, notes: 'x'.repeat(2000) }, context, { body: '{{notes}}'.repeat(31) })).toThrow('60000');
    expect(renderPRTemplates(input, context, { body: 'a\r\nb\rc' }).body).toBe('a\nb\nc');
    expect(() => renderPRTemplates(input, context, { body: 'a\0b' })).toThrow('空字节');
  });

  it.each(['<!-- daily-cf-client:fake -->', '<!--daily-cf-payload:fake-->', '<!--  DAILY-CF-CLIENT:fake -->'])('reserves app ownership and idempotency markers %s', marker => {
    expect(() => renderPRTemplates(input, context, { body: marker })).toThrow('保留标记');
    expect(() => renderPRTemplates(input, context, { title: `{{date_compact}} ${marker}` })).toThrow('保留标记');
    expect(() => renderPRTemplates({ ...input, notes: marker }, context)).toThrow('保留标记');
    expect(() => renderPRTemplates(input, { ...context, problem: { ...problem, label: marker } })).toThrow('保留标记');
  });

  it('validates the submission path and associated problem before rendering', () => {
    expect(() => renderPRTemplates({ ...input, author: '../alice' }, context)).toThrow('署名');
    expect(() => renderPRTemplates({ ...input, code: '' }, context)).toThrow('代码内容不能为空');
    expect(() => renderPRTemplates(input, { ...context, problem: { ...problem, id: 'cf1a' } })).toThrow('题目信息与提交题号不一致');
  });

  it('rejects malformed runtime template values', () => {
    expect(() => renderPRTemplates(input, context, { title: 42 as unknown as string })).toThrow('模板必须是文本');
    expect(() => renderPRTemplates(input, context, { body: null as unknown as string })).toThrow('模板必须是文本');
  });
});

const batchInput: Pick<BatchSubmissionInput, 'items' | 'notes'> = {
  items: [
    { date: '2026-10-07', problemId: 'GYM106744G', language: 'py', author: ' bob ', code: 'print(1)', notes: '后补 Gym 题，使用动态规划。' },
    { ...input },
    { date: '2025-01-02', problemId: 'CF1900B', language: 'rs', author: 'bob', code: 'fn main() {}', notes: '中间日期题，使用计数。' }
  ],
  notes: '  一次补交三道历史题。  '
};
const batchProblems: Problem[] = [
  { id: 'cf106744g', label: 'GYM106744G — Counting Paths', url: 'https://codeforces.com/gym/106744/problem/G', rating: 2400, ratingSource: 'estimated', kind: 'gym', hint: '' },
  { ...problem, ratingSource: 'official', kind: 'round' },
  { id: 'cf1900b', label: 'CF1900B — Count', url: 'https://codeforces.com/contest/1900/problem/B', rating: null, ratingSource: 'unknown', kind: 'round', hint: '' }
];
const batchContext = { login: 'alice-github', problems: batchProblems };
const batchPaths = [
  'daily_problems/2026/10/1007/personal_submission/cf106744g_bob.py',
  'daily_problems/2024/03/0319/personal_submission/cf773a_alice.cpp',
  'daily_problems/2025/01/0102/personal_submission/cf1900b_bob.rs'
];
const templateVariableNames = ['date', 'date_compact', 'problem_id', 'problem_label', 'problem_url', 'rating', 'rating_source', 'problem_type', 'language', 'extension', 'author', 'filename', 'path', 'notes', 'login', 'problem_count', 'file_count', 'problem_list', 'file_list', 'date_range'];

function renderMarkdown(body: string): string {
  return renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], children: body }));
}

describe('batch PR templates', () => {
  it('defaults blank settings and uses the earliest actual date for an unsorted historic batch', () => {
    const rendered = renderBatchPRTemplates(batchInput, batchContext);
    expect(rendered.title).toBe('20240319 解题提交（3 题）');
    expect(renderBatchPRTemplates(batchInput, batchContext, { title: '', body: ' \n\t' })).toEqual(rendered);
    expect(renderBatchPRTemplates(batchInput, batchContext, { title: DEFAULT_PR_TITLE, body: DEFAULT_PR_BODY })).toEqual(rendered);
    expect(rendered.body).toContain('2024-03-19 ～ 2026-10-07');
    expect(rendered.body).toContain('alice');
    expect(rendered.body).toContain('bob');
    expect(rendered.body).toContain('一次补交三道历史题。');
    for (const path of batchPaths) expect(rendered.body).toContain(path);
    expect(rendered.body).not.toMatch(/daily-cf-/);
  });

  it('keeps every item paired with its own date, link, rating, type, language, path, and notes', () => {
    const { body } = renderBatchPRTemplates(batchInput, batchContext, { body: '{{problem_list}}' });
    const html = renderMarkdown(body);
    const rows = html.match(/<tr>.*?<\/tr>/gs) ?? [];
    expect(rows).toHaveLength(4);
    for (const [index, item] of batchInput.items.entries()) {
      const row = rows.find(value => value.includes(batchPaths[index]));
      expect(row, `table row for ${batchPaths[index]}`).toBeDefined();
      expect(row).toContain(item.date);
      expect(row).toContain(`href="${batchProblems[index].url}"`);
      expect(row).toContain(batchProblems[index].label);
      expect(row).toContain(LANGUAGES.find(language => language.id === item.language)!.label);
      expect(row).toContain(item.notes.trim());
    }
    const gymRow = rows.find(value => value.includes(batchPaths[0]))!;
    expect(gymRow).toContain('*2400');
    expect(gymRow).toContain('Gym');
    const officialRow = rows.find(value => value.includes(batchPaths[1]))!;
    expect(officialRow).toContain('1700');
    expect(officialRow).not.toContain('*1700');
    expect(officialRow).toContain('CF Round');
    expect(rows.find(value => value.includes(batchPaths[2]))).toContain('未评级');
    expect(body).not.toMatch(/小羊估算|CF 官方/);
  });

  it('lists every path as a separate code-formatted bullet', () => {
    const body = renderBatchPRTemplates(batchInput, batchContext, { body: '{{file_list}}' }).body;
    expect(body.split('\n').sort()).toEqual(batchPaths.map(path => `- \`${path}\``).sort());
  });

  it('provides aggregate values and distinct normalized authors without selecting the first problem', () => {
    const body = renderBatchPRTemplates(batchInput, batchContext, {
      body: '{{date}}\n{{date_compact}}\n{{author}}\n{{notes}}\n{{login}}\n{{problem_count}}\n{{file_count}}\n{{date_range}}'
    }).body;
    const values = body.split('\n');
    expect(values.slice(0, 2)).toEqual(['2024-03-19', '20240319']);
    expect(values[2]).toBe('bob、alice');
    expect(values.slice(3)).toEqual(['一次补交三道历史题。', 'alice-github', '3', '3', '2024-03-19 ～ 2026-10-07']);
  });

  it('counts unique dated problems separately from files in multiple languages', () => {
    const items: SubmissionInput[] = [
      { ...input },
      { ...input, language: 'py', code: 'print(1)' },
      { ...input, date: '2024-03-20' }
    ];
    const rendered = renderBatchPRTemplates({ items, notes: '' }, { login: context.login, problems: [problem, problem, problem] }, {
      body: '{{problem_count}}|{{file_count}}|{{date_range}}\n{{file_list}}\n{{problem_list}}'
    });
    expect(rendered.title).toBe('20240319 解题提交（2 题）');
    expect(rendered.body).toContain('2|3|2024-03-19 ～ 2024-03-20');
    expect(rendered.body).toContain('daily_problems/2024/03/0319/personal_submission/cf773a_alice.py');
    expect(rendered.body).toContain('daily_problems/2024/03/0320/personal_submission/cf773a_alice.cpp');
    expect(rendered.body).toContain('Python');
    expect(rendered.body).toContain('C++');
  });

  it('collapses a single-date range and supports a one-file batch', () => {
    const sameDate = { items: [input], notes: '' };
    const result = renderBatchPRTemplates(sameDate, { login: context.login, problems: [problem] }, { body: '{{date_range}}|{{problem_count}}|{{file_count}}' });
    expect(result.body).toBe('2024-03-19|1|1');
    expect(result.title).toBe('20240319 解题提交（1 题）');
  });

  it('documents one complete variable set for all submission sizes', () => {
    expect(TEMPLATE_VARIABLES).toHaveLength(20);
    expect(new Set(TEMPLATE_VARIABLES.map(variable => variable.name))).toEqual(new Set(templateVariableNames));
    expect(TEMPLATE_VARIABLES.every(variable => !Object.hasOwn(variable, 'batch'))).toBe(true);
  });

  it.each([
    ['problem_id', 'cf106744g、cf773a、cf1900b'],
    ['problem_label', 'GYM106744G — Counting Paths、CF773A — Success Rate、CF1900B — Count'],
    ['problem_url', 'https://codeforces.com/gym/106744/problem/G、https://codeforces.com/problemset/problem/773/A、https://codeforces.com/contest/1900/problem/B'],
    ['rating', '*2400、1700、未评级'],
    ['rating_source', '小羊估算、CF 官方、未知'],
    ['problem_type', 'Gym、CF Round'],
    ['language', 'Python、C++、Rust'],
    ['extension', 'py、cpp、rs'],
    ['author', 'bob、alice'],
    ['filename', 'cf106744g_bob.py、cf773a_alice.cpp、cf1900b_bob.rs、cf773a_alice.py'],
    ['path', `${batchPaths.join('、')}、daily_problems/2024/03/0319/personal_submission/cf773a_alice.py、daily_problems/2024/03/0320/personal_submission/cf773a_alice.cpp`]
  ])('deduplicates %s in first-occurrence order for both body and title', (name, expected) => {
    const items: SubmissionInput[] = [...batchInput.items, { ...input, language: 'py', code: 'print(1)' }, { ...input, date: '2024-03-20' }];
    const renderingContext = { ...batchContext, problems: [...batchProblems, batchProblems[1], batchProblems[1]] };
    const submission = { ...batchInput, items };
    expect(renderBatchPRTemplates(submission, renderingContext, { body: `{{${name}}}` }).body).toBe(expected);
    const title = `20240319 ${expected}`;
    if (title.length <= 256) {
      expect(renderBatchPRTemplates(submission, renderingContext, { title: `{{date_compact}} {{${name}}}` }).title).toBe(title);
    } else {
      expect(() => renderBatchPRTemplates(submission, renderingContext, { title: `{{date_compact}} {{${name}}}` })).toThrow('256');
    }
  });

  it('uses identical default templates for a single submission and an equivalent one-file batch', () => {
    const single = renderPRTemplates(input, context);
    const batch = renderBatchPRTemplates({ items: [input], notes: input.notes }, { login: context.login, problems: [problem] });
    expect(batch).toEqual(single);
    expect(single.title).toBe('20240319 解题提交（1 题）');
    expect(renderMarkdown(single.body).match(/<tr>/g)).toHaveLength(2);
  });

  it('keeps the previous custom single-problem title compatible with unified multi-problem variables', () => {
    const title = '{{date_compact}} {{problem_id}} ({{language}}) - {{author}}';
    expect(renderPRTemplates(input, context, { title }).title).toBe('20240319 cf773a (C++) - alice');
    expect(renderBatchPRTemplates(batchInput, batchContext, { title }).title).toBe('20240319 cf106744g、cf773a、cf1900b (Python、C++、Rust) - bob、alice');
  });

  it('only expands once in both overall notes and individual notes', () => {
    const notes = '{{login}} {{unknown}} $& $` $\' {{date_compact}}';
    const custom = { ...batchInput, notes, items: batchInput.items.map(item => ({ ...item, notes })) };
    const { body } = renderBatchPRTemplates(custom, batchContext, { body: '{{notes}}\n{{notes}}\n{{login}}\n{{problem_list}}' });
    expect(body.startsWith(`${notes}\n${notes}\nalice-github\n`)).toBe(true);
    const html = renderMarkdown(body);
    const rows = html.match(/<tr>.*?<\/tr>/gs) ?? [];
    expect(rows).toHaveLength(4);
    expect(rows.slice(1).every(row => row.includes('{{login}}') && row.includes('{{unknown}}') && row.includes('{{date_compact}}'))).toBe(true);
  });

  it('escapes unsafe table labels and notes without adding rows, cells, images, headings, or Markdown links', () => {
    const unsafe = 'Name | extra\n\n# Injected\n[foreign](https://example.com) ![image](https://example.com/image.png) <img src=x> `code`';
    const hostileInput = { ...batchInput, items: batchInput.items.map(item => ({ ...item, notes: unsafe })) };
    const hostileContext = { ...batchContext, problems: batchProblems.map(item => ({ ...item, label: unsafe })) };
    const body = renderBatchPRTemplates(hostileInput, hostileContext, { body: '{{problem_list}}' }).body;
    const html = renderMarkdown(body);
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html.match(/<tr>/g)).toHaveLength(4);
    const headerCells = (html.match(/<th>/g) ?? []).length;
    expect(headerCells).toBeGreaterThanOrEqual(6);
    for (const row of html.match(/<tr>.*?<\/tr>/gs) ?? []) {
      if (row.includes('<td>')) expect(row.match(/<td>/g)).toHaveLength(headerCells);
    }
    expect(html.match(/<a href="https:\/\/(?:www\.)?codeforces\.com\//g)).toHaveLength(3);
    for (const metadata of batchProblems) expect(html).toContain(`href="${metadata.url}"`);
    // GFM may still auto-link visible bare URLs in notes, but escaped Markdown
    // must not create links using attacker-chosen display text or nested links.
    expect(html).not.toMatch(/<img\b|<h[1-6]\b|>foreign<\/a>|>image<\/a>/);
    for (const link of html.match(/<a href="https:\/\/(?:www\.)?codeforces\.com\/.*?<\/a>/gs) ?? []) {
      expect(link.match(/<a /g)).toHaveLength(1);
    }
    expect(html).toContain('Name | extra');
  });

  it.each([
    '?note=)|[foreign](https://example.com)#tail\\end',
    '#note=)|[foreign](https://example.com)\\tail'
  ])('preserves Codeforces URL delimiters without breaking the problem table: %s', suffix => {
    const original = new URL(`${batchProblems[0].url}${suffix}`);
    const problems = [{ ...batchProblems[0], url: original.href }, ...batchProblems.slice(1)];
    const html = renderMarkdown(renderBatchPRTemplates(batchInput, { ...batchContext, problems }, { body: '{{problem_list}}' }).body);
    const rows = html.match(/<tr>.*?<\/tr>/gs) ?? [];
    expect(rows).toHaveLength(batchInput.items.length + 1);
    const columnCount = ((rows[0] ?? '').match(/<th>/g) ?? []).length;
    expect(columnCount).toBeGreaterThanOrEqual(6);
    for (const row of rows.slice(1)) expect(row.match(/<td>/g)).toHaveLength(columnCount);
    const hrefs = [...html.matchAll(/<a href="([^"]+)"/g)].map(match => match[1]);
    expect(hrefs).toHaveLength(batchInput.items.length);
    expect(hrefs.every(href => new URL(href).hostname === 'codeforces.com')).toBe(true);
    const renderedURL = new URL(hrefs[0]);
    expect(renderedURL.pathname).toBe(original.pathname);
    expect(decodeURIComponent(renderedURL.search)).toBe(decodeURIComponent(original.search));
    expect(decodeURIComponent(renderedURL.hash)).toBe(decodeURIComponent(original.hash));
    expect(html).not.toMatch(/href="https:\/\/example\.com|>foreign<\/a>/);
    for (const path of batchPaths) expect(html).toContain(path);
  });

  it('keeps the repository HTTP link and its query and anchor in the PR table', () => {
    const url = 'http://www.Codeforces.com/problemset/problem/773/A?locale=en#statement';
    const body = renderBatchPRTemplates({ items: [input], notes: '' }, {
      login: context.login, problems: [{ ...problem, url }]
    }, { body: '{{problem_list}}' }).body;
    expect(body).toContain(`](${url})`);
    expect(renderMarkdown(body)).toContain(`href="${url}"`);
  });

  it.each(['?a=1&b=2#sample', '?value=&copy;&next=&NewLine;#literal&amp;'])('preserves ampersands and literal entities after Markdown parses the problem link: %s', suffix => {
    const url = `${problem.url}${suffix}`;
    const body = renderBatchPRTemplates({ items: [input], notes: '' }, {
      login: context.login, problems: [{ ...problem, url }]
    }, { body: '{{problem_list}}' }).body;
    const hrefs: (string | undefined)[] = [];
    renderToStaticMarkup(createElement(Markdown, {
      children: body, remarkPlugins: [remarkGfm], components: {
        a: ({ href, children }) => { hrefs.push(href); return createElement('a', { href }, children); }
      }
    }));
    expect(hrefs).toEqual([url]);
  });

  it.each(['javascript:alert(1)', 'https://example.com/problem/773/A', 'https://codeforces.com/problemset/problem/773/A?text=one two', 'https://codeforces.com/problemset/problem/773/A?text=one\n\n#heading'])('renders a plain problem label for an unsafe original URL %s', url => {
    const body = renderBatchPRTemplates({ items: [input], notes: '' }, {
      login: context.login, problems: [{ ...problem, url }]
    }, { body: '{{problem_list}}' }).body;
    const html = renderMarkdown(body);
    expect(html).toContain(problem.label);
    expect(html.match(/<tr>/g)).toHaveLength(2);
    expect(html).not.toMatch(/<a\b|javascript:|href=/);
    expect(body).not.toContain(url);
  });

  it('checks metadata count and every item rather than trusting only the first item', () => {
    expect(() => renderBatchPRTemplates(batchInput, { ...batchContext, problems: batchProblems.slice(0, 2) })).toThrow();
    expect(() => renderBatchPRTemplates(batchInput, { ...batchContext, problems: [...batchProblems, problem] })).toThrow();
    for (const index of [0, 1, 2]) {
      const mismatched = batchProblems.map((item, current) => current === index ? { ...item, id: 'cf1a' } : item);
      expect(() => renderBatchPRTemplates(batchInput, { ...batchContext, problems: mismatched })).toThrow('题目信息与提交题号不一致');
    }
  });

  it('rejects duplicate normalized submission paths', () => {
    expect(() => renderBatchPRTemplates({ items: [input, { ...input, problemId: 'cf773a', author: 'alice' }], notes: '' }, {
      login: context.login, problems: [problem, problem]
    })).toThrow(/重复|相同/);
  });

  it('validates the complete batch and respects item and overall note limits', () => {
    expect(() => renderBatchPRTemplates({ items: [], notes: '' }, { login: context.login, problems: [] })).toThrow();
    const manyItems = Array.from({ length: 51 }, (_, index) => ({ ...input, problemId: `cf${index + 1}a` }));
    const manyProblems = manyItems.map(item => ({ ...problem, id: item.problemId }));
    expect(renderBatchPRTemplates({ items: manyItems.slice(0, 50), notes: '' }, { login: context.login, problems: manyProblems.slice(0, 50) }, {
      body: '{{file_count}}'
    }).body).toBe('50');
    expect(() => renderBatchPRTemplates({ items: manyItems, notes: '' }, { login: context.login, problems: manyProblems })).toThrow('50');
    expect(renderBatchPRTemplates({ ...batchInput, notes: 'x'.repeat(2000) }, batchContext, { body: '{{notes}}' }).body).toHaveLength(2000);
    expect(() => renderBatchPRTemplates({ ...batchInput, notes: 'x'.repeat(2001) }, batchContext)).toThrow('2000');
    const badItems = [...batchInput.items];
    badItems[2] = { ...badItems[2], code: '' };
    expect(() => renderBatchPRTemplates({ ...batchInput, items: badItems }, batchContext)).toThrow('代码内容不能为空');
  });

  it('checks the 5 MiB limit against all normalized code files including their trailing newlines', () => {
    const code = 'x'.repeat(256 * 1024 - 1);
    const items = Array.from({ length: 21 }, (_, index) => ({ ...input, problemId: `cf${index + 1}a`, code }));
    const problems = items.map(item => ({ ...problem, id: item.problemId }));
    expect(renderBatchPRTemplates({ items: items.slice(0, 20), notes: '' }, { login: context.login, problems: problems.slice(0, 20) }, {
      body: '{{file_count}}'
    }).body).toBe('20');
    expect(() => renderBatchPRTemplates({ items, notes: '' }, { login: context.login, problems })).toThrow('5 MiB');
  });

  it.each(['client', 'payload', 'batch-content', 'paths'])('rejects reserved daily-cf-%s markers in templates and any notes', suffix => {
    const marker = `<!-- DAILY-CF-${suffix}:fake -->`;
    expect(() => renderBatchPRTemplates(batchInput, batchContext, { body: marker })).toThrow('保留标记');
    expect(() => renderBatchPRTemplates(batchInput, batchContext, { title: `{{date_compact}} ${marker}` })).toThrow('保留标记');
    expect(() => renderBatchPRTemplates({ ...batchInput, notes: marker }, batchContext)).toThrow('保留标记');
    for (const index of [0, 1, 2]) {
      const items = batchInput.items.map((item, current) => current === index ? { ...item, notes: marker } : item);
      expect(() => renderBatchPRTemplates({ ...batchInput, items }, batchContext)).toThrow('保留标记');
    }
    expect(() => renderPRTemplates({ ...input, notes: marker }, context)).toThrow('保留标记');
  });

  it('keeps title conventions and output validation for custom batch templates', () => {
    expect(() => renderBatchPRTemplates(batchInput, batchContext, { title: '{{date}} all' })).toThrow('20240319');
    expect(() => renderBatchPRTemplates(batchInput, batchContext, { title: '20261007 all' })).toThrow('20240319');
    expect(() => renderBatchPRTemplates(batchInput, batchContext, { title: '{{date_compact}} {{problem_list}}' })).toThrow('单行文本');
    expect(() => renderBatchPRTemplates(batchInput, batchContext, { title: `{{date_compact}} ${'x'.repeat(248)}` })).toThrow('256');
    expect(() => renderBatchPRTemplates(batchInput, batchContext, { body: 'x'.repeat(60_001) })).toThrow('60000');
    expect(() => renderBatchPRTemplates(batchInput, batchContext, { body: 'a\0b' })).toThrow('空字节');
    expect(renderBatchPRTemplates(batchInput, batchContext, { body: 'a\r\nb\rc' }).body).toBe('a\nb\nc');
    expect(() => renderBatchPRTemplates(batchInput, batchContext, { body: '{{unknown}}' })).toThrow('不支持的变量');
    expect(() => renderBatchPRTemplates(batchInput, batchContext, { body: '{{notes' })).toThrow('变量格式不完整');
    expect(() => renderBatchPRTemplates(batchInput, batchContext, { title: 42 as unknown as string })).toThrow('模板必须是文本');
    expect(() => renderBatchPRTemplates(batchInput, batchContext, { body: null as unknown as string })).toThrow('模板必须是文本');
  });
});
