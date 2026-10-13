import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipboardText } from '../shared/clipboard';
import { readProblemDay } from '../shared/day-service';
import { parseDifficultyRange } from '../shared/difficulty';
import { buildSubmissionPreview, parseProblems, validateDate, validateSubmission } from '../shared/domain';
import { validateForkName } from '../shared/fork';
import { setLocale, t } from '../shared/i18n';
import { en as sharedEnglish } from '../shared/locales/shared';
import { en as retainedEnglish } from '../shared/locales/library-retained';
import { DEFAULT_PR_BODY, DEFAULT_PR_TITLE, getDefaultPRBodyTemplate, getDefaultPRTitleTemplate, renderBatchPRTemplates, renderPRTemplates, TEMPLATE_VARIABLES } from '../shared/templates';
import type { ClientAPI, ContributionPage, Problem, SubmissionInput } from '../shared/types';
vi.mock('../src/bridge', () => ({ api: {} }));
import { LibraryController } from '../src/useLibrary';
import { ContributionsController } from '../src/useContributions';

const input: SubmissionInput = {
  date: '2128-02-29', problemId: 'cf1a', language: 'cpp', author: 'alice',
  code: '// 用户代码保持原文\nint main() {}\n', notes: '用户说明 {{author}}',
};
const problem: Problem = {
  id: 'cf1a', label: '用户原题名称', url: 'https://codeforces.com/problemset/problem/1/A',
  rating: 800, ratingSource: 'official', kind: 'round', hint: '原题提示保持中文',
};
const context = { login: 'alice', problem };
const en: Record<string, string> = { ...sharedEnglish, ...retainedEnglish };
afterEach(() => { setLocale('zh-CN'); });

describe('shared application localization', () => {
  it('translates every static shared message and template-help key', () => {
    for (const file of ['shared/clipboard.ts', 'shared/day-service.ts', 'shared/difficulty.ts', 'shared/domain.ts',
      'shared/fork.ts', 'shared/templates.ts', 'src/useLibrary.ts', 'src/useContributions.ts']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const match of source.matchAll(/\bt\('([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g)) {
        expect(en, `${file}: ${match[1]}`).toHaveProperty(match[1]);
        expect(en[match[1]]).not.toMatch(/[\u4e00-\u9fff]/);
      }
    }
    setLocale('en');
    for (const variable of TEMPLATE_VARIABLES) {
      expect(t(variable.label)).not.toMatch(/[\u4e00-\u9fff]/);
      expect(t(variable.example)).not.toMatch(/[\u4e00-\u9fff]/);
    }
    expect(en[DEFAULT_PR_TITLE]).toBeTruthy();
    expect(en[DEFAULT_PR_BODY]).toBeTruthy();
  });

  it('localizes validation errors without changing the accepted values', async () => {
    setLocale('en');
    expect(() => clipboardText(null)).toThrow('Only text can be copied.');
    expect(() => validateDate('2128-02-30')).toThrow('Choose a valid Gregorian date');
    expect(() => validateSubmission({ ...input, code: '' })).toThrow('Code cannot be empty.');
    expect(() => validateForkName('alice/repo')).toThrow('Use only ASCII letters');
    expect(parseDifficultyRange('-1', '').error).toBe('Enter a non-negative integer for the minimum rating, or leave it blank for no limit.');
    expect(parseDifficultyRange('', 'x').error).toContain('maximum rating');
    expect(parseDifficultyRange('2000', '1000').error).toBe('The minimum rating cannot exceed the maximum rating.');
    await expect(readProblemDay(async () => ({}) as never)).rejects.toThrow('The remote problem list is incomplete');
    expect(validateDate(input.date)).toBe(input.date);
    expect(validateSubmission(input).code).toBe(input.code);
    expect(clipboardText(problem.hint)).toBe(problem.hint);
  });

  it('resolves default templates at render time and keeps user values literal', () => {
    setLocale('zh-CN');
    const before = buildSubmissionPreview(input, 'alice');
    expect(getDefaultPRTitleTemplate()).toBe(DEFAULT_PR_TITLE);
    expect(getDefaultPRBodyTemplate()).toBe(DEFAULT_PR_BODY);
    expect(renderPRTemplates(input, context).title).toBe('21280229 解题提交（1 题）');
    setLocale('en');
    expect(getDefaultPRTitleTemplate()).toBe('{{date_compact}} Solutions ({{problem_count}} problems)');
    expect(getDefaultPRBodyTemplate()).toContain('## Notes');
    const result = renderPRTemplates(input, context);
    expect(result.title).toBe('21280229 Solutions (1 problems)');
    expect(result.body).toContain('| Date | Problem | Rating | Type | Language | File | Notes |');
    expect(result.body).toContain('[用户原题名称](https://codeforces.com/problemset/problem/1/A)');
    expect(result.body).toContain('\n\n用户说明 {{author}}');
    expect(result.body).toContain('daily_problems/2128/02/0229/personal_submission/cf1a_alice.cpp');
    expect(buildSubmissionPreview(input, 'alice')).toEqual(before);
    setLocale('zh-CN');
    expect(getDefaultPRTitleTemplate()).toBe(DEFAULT_PR_TITLE);
  });

  it('never translates saved custom templates, even if they equal an old default', () => {
    setLocale('en');
    const saved = { title: '{{date_compact}} 我保存的模板', body: '固定中文\n{{problem_label}}\n{{notes}}' };
    expect(renderPRTemplates(input, context, saved)).toEqual({
      title: '21280229 我保存的模板', body: '固定中文\n用户原题名称\n用户说明 {{author}}',
    });
    expect(renderPRTemplates(input, context, { title: DEFAULT_PR_TITLE }).title).toBe('21280229 解题提交（1 题）');
    expect(saved.body).toBe('固定中文\n{{problem_label}}\n{{notes}}');
  });

  it('localizes aggregate table headings and generated values without altering labels or paths', () => {
    setLocale('en');
    const second = { ...input, date: '9999-12-31', language: 'py' as const };
    const result = renderBatchPRTemplates({ items: [input, second], notes: '批次说明' }, {
      login: 'alice', problems: [problem, { ...problem, rating: null, ratingSource: 'unknown' }],
    }, { body: '{{date_range}}\n{{rating_source}}\n{{language}}\n{{problem_list}}\n{{notes}}' });
    expect(result.title).toBe('21280229 Solutions (2 problems)');
    expect(result.body).toContain('2128-02-29 – 9999-12-31\nOfficial CF rating, Unknown\nC++, Python');
    expect(result.body).toContain('| Unrated | CF Round | Python |');
    expect(result.body).toContain('cf1a_alice.py');
    expect(result.body).toContain('用户原题名称');
    expect(result.body).toMatch(/\n批次说明$/);
  });

  it('keeps literal template-placeholder guidance intact in translated errors', () => {
    setLocale('en');
    expect(() => renderPRTemplates(input, context, { title: 'bad title' }))
      .toThrow('The PR title must start with the problem date 21280229 followed by a space. Use {{date_compact}}.');
    expect(() => renderPRTemplates(input, context, { body: '{{broken' }))
      .toThrow('The PR body template contains an incomplete variable. Use {{variable_name}}.');
    expect(() => renderPRTemplates(input, context, { body: '{{unknown_name}}' }))
      .toThrow('The PR body template contains an unsupported variable "unknown_name".');
  });

  it('translates only a locally generated source warning and preserves upstream text', () => {
    setLocale('en');
    const [parsed] = parseProblems('| *1700 | [GYM106631F](https://codeforces.com/gym/106631/problem/A) | 源文件提示 {{id}} |', input.date);
    expect(parsed).toMatchObject({ id: 'cf106631a', label: 'GYM106631F', hint: '源文件提示 {{id}}' });
    expect(parsed.sourceWarning).toContain('The repository label GYM106631F does not match its problem link.');
    expect(parsed.sourceWarning).toContain('CF106631A');
    expect(parsed.sourceWarning).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('uses English loading progress and stop messages while keeping month identifiers unchanged', async () => {
    setLocale('en');
    let finish!: (days: []) => void;
    const pending = new Promise<[]>((resolve) => { finish = resolve; });
    const client = {
      getDay: vi.fn<ClientAPI['getDay']>(),
      getArchiveMonths: vi.fn<ClientAPI['getArchiveMonths']>().mockResolvedValue([{ month: '2128-02', days: 0 }]),
      getMonth: vi.fn<ClientAPI['getMonth']>().mockReturnValue(pending),
      getArchiveSnapshot: vi.fn<ClientAPI['getArchiveSnapshot']>().mockResolvedValue({
        branch: 'main', revision: 'a'.repeat(40), months: [{ month: '2128-02', days: 0 }],
      }),
      getMonthFromSnapshot: vi.fn<ClientAPI['getMonthFromSnapshot']>().mockReturnValue(pending),
    };
    const controller = new LibraryController(client);
    const loading = controller.setView('archive');
    expect(controller.getSnapshot().refreshProgress).toBe('Loading the month directory…');
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(controller.getSnapshot().refreshProgress).toBe('Loading 2128-02 (1/1)');
    controller.stopRefresh();
    expect(controller.getSnapshot().indexingError).toBe('Loading stopped. Only the months loaded during this visit are shown.');
    finish([]);
    await loading;
    controller.dispose();
  });

  it('localizes contribution identity errors without translating remote record titles', async () => {
    setLocale('en');
    const page: ContributionPage = {
      items: [], totalCount: 0, openCount: 0, mergedCount: 0, closedCount: 0, page: 1, pageSize: 50,
      hasMore: false, truncated: false, incomplete: false, login: 'wrong-account', repository: 'example/repo', fetchedAt: '2026-10-07',
    };
    const controller = new ContributionsController({ getContributions: vi.fn().mockResolvedValue(page) });
    await controller.enter('alice', 'example/repo', 'history');
    expect(controller.getSnapshot().error).toBe('The records returned by GitHub do not match the current account or repository. Refresh and try again.');
    controller.dispose();
  });
});
