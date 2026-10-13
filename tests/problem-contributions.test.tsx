import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContributionProblem, RemotePullRequest } from '../shared/types';
import ProblemContributionStatus, { findProblemContributions, getProblemContributionSummary, type ProblemContributionStatusProps } from '../src/components/ProblemContributionStatus';
import { setLocale } from '../shared/i18n';

const date = '2026-10-07';
const problemId = 'cf1234a';

function problem(day = date, id = problemId, extension = 'cpp'): ContributionProblem {
  return { date: day, problemId: id, path: `${day}/${id}_alice.${extension}` };
}

function pullRequest(number: number, problems: ContributionProblem[] = [problem()], overrides: Partial<RemotePullRequest> = {}): RemotePullRequest {
  return {
    id: `pr-${number}`, number, title: `Contribution ${number}`, url: `https://github.com/example/problems/pull/${number}`,
    state: 'open', createdAt: '2026-10-07T01:00:00Z', updatedAt: '2026-10-07T01:00:00Z',
    problems, filesTruncated: false, ...overrides,
  };
}

function render(records: RemotePullRequest[], overrides: Partial<ProblemContributionStatusProps> = {}) {
  return renderToStaticMarkup(<ProblemContributionStatus problemId={problemId} records={records} onOpen={() => {}} {...overrides} />);
}

describe('problem contribution evidence', () => {
  it('normalizes requested and recorded IDs, including the repository GYM alias', () => {
    const record = pullRequest(1, [problem(date, 'GYM106744G')]);
    expect(findProblemContributions([record], ' 106744g ')).toEqual([{ record, dates: [date] }]);
  });

  it('does not infer a contribution from PR title or top-level summary metadata', () => {
    const record = pullRequest(1, [], { title: `${date} ${problemId}`, problemId, date, path: problem().path });
    expect(findProblemContributions([record], problemId)).toEqual([]);
  });

  it('keeps each problem tied to its own file date in a multi-problem PR', () => {
    const record = pullRequest(1, [problem('2026-09-20'), problem(date, 'cf5678b')]);
    expect(findProblemContributions([record], problemId)).toEqual([{ record, dates: ['2026-09-20'] }]);
  });

  it('replaces old file evidence with the newest complete snapshot in overlapping PR pages', () => {
    const original = pullRequest(1, [problem(), problem(date, problemId, 'py'), problem('2026-09-20')]);
    const newer = pullRequest(1, [problem('2026-09-20'), problem('2026-10-01')], { state: 'merged', updatedAt: '2026-10-07T02:00:00Z' });
    const result = findProblemContributions([original, newer, original], problemId);
    expect(result).toEqual([{ record: newer, dates: ['2026-10-01', '2026-09-20'] }]);
  });

  it('does not resurrect a removed problem when an older duplicate appears later', () => {
    const older = pullRequest(1, [problem()], { state: 'merged' });
    const newer = pullRequest(1, [problem(date, 'cf5678b')], { state: 'open', updatedAt: '2026-10-07T02:00:00Z' });
    for (const records of [[older, newer], [newer, older], [older, newer, older]]) {
      expect(findProblemContributions(records, problemId)).toEqual([]);
      expect(getProblemContributionSummary(records, problemId)).toMatchObject({ state: 'none', total: 0 });
    }
  });

  it('prefers complete evidence over partial duplicates of the same revision', () => {
    const partial = pullRequest(1, [problem()], { filesTruncated: true });
    const complete = pullRequest(1, [problem(date, 'cf5678b')]);
    for (const records of [[partial, complete], [complete, partial]]) {
      expect(getProblemContributionSummary(records, problemId)).toMatchObject({ state: 'none', total: 0, incomplete: false });
    }
  });

  it('does not invent file evidence missing from the selected partial snapshot', () => {
    const first = pullRequest(1, [problem()], { filesTruncated: true });
    const second = pullRequest(1, [problem('2026-09-20')], { filesTruncated: true });
    const summary = getProblemContributionSummary([first, second], problemId);
    expect(summary).toMatchObject({ state: 'open', open: 1, total: 1, incomplete: true });
    expect(summary.contributions).toEqual([{ record: second, dates: ['2026-09-20'] }]);
    const newer = pullRequest(1, [], { filesTruncated: true, updatedAt: '2026-10-07T02:00:00Z' });
    expect(getProblemContributionSummary([first, newer, second], problemId)).toMatchObject({ state: 'unknown', total: 0, incomplete: true });
  });

  it('skips malformed evidence IDs without discarding valid files', () => {
    const record = pullRequest(1, [problem(date, '../cf1234a'), problem(date, ' CF1234A ')]);
    expect(findProblemContributions([record], problemId)).toEqual([{ record, dates: [date] }]);
    expect(findProblemContributions([record], 'not-a-problem')).toEqual([]);
  });

  it('orders by PR creation time, independently of file dates, state, update time and input order', () => {
    const oldMerged = pullRequest(30, [problem('2030-01-01')], {
      state: 'merged', createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-12-01T10:00:00Z',
    });
    const middleOpen = pullRequest(20, [problem(date)], { createdAt: '2026-10-01T10:00:00Z' });
    const newestClosed = pullRequest(10, [problem('2024-01-01')], {
      state: 'closed', createdAt: '2026-10-02T10:00:00Z',
    });
    for (const records of [[middleOpen, oldMerged, newestClosed], [newestClosed, oldMerged, middleOpen]]) {
      expect(findProblemContributions(records, problemId).map(({ record }) => record.number)).toEqual([10, 20, 30]);
    }
  });

  it('uses the newest snapshot without moving the PR according to its update time', () => {
    const older = pullRequest(1, [problem()], { createdAt: '2026-10-01T10:00:00Z' });
    const revised = pullRequest(1, [problem(), problem('2026-09-20')], {
      state: 'merged', createdAt: older.createdAt, updatedAt: '2026-12-01T10:00:00Z',
    });
    const newer = pullRequest(2, [problem()], { createdAt: '2026-10-02T10:00:00Z' });
    expect(findProblemContributions([revised, newer, older], problemId)).toEqual([
      { record: newer, dates: [date] },
      { record: revised, dates: [date, '2026-09-20'] },
    ]);
  });

  it('breaks equal creation times by descending PR number then ID and places unknown times last', () => {
    const tiedA = pullRequest(9, [problem()], { id: 'a' });
    const tiedB = pullRequest(9, [problem()], { id: 'b', createdAt: '2026-10-07T09:00:00+08:00' });
    const smaller = pullRequest(8);
    const invalid = pullRequest(100, [problem()], { createdAt: 'invalid' });
    const empty = pullRequest(99, [problem()], { createdAt: '' });
    for (const records of [[empty, smaller, tiedB, invalid, tiedA], [tiedA, invalid, tiedB, smaller, empty]]) {
      expect(findProblemContributions(records, problemId).map(({ record }) => record.id)).toEqual(['a', 'b', 'pr-8', 'pr-100', 'pr-99']);
    }
  });
});

describe('problem contribution summary', () => {
  it('counts unique PRs across dates and languages with merged taking priority over open and closed', () => {
    const merged = pullRequest(1, [problem('2026-09-20'), problem('2026-09-20', problemId, 'py')], { state: 'merged' });
    const open = pullRequest(2, [problem(), problem('2026-09-20'), problem(date, problemId, 'py')]);
    const closed = pullRequest(3, [problem()], { state: 'closed' });
    const summary = getProblemContributionSummary([merged, open, closed, open, merged], problemId);
    expect(summary).toMatchObject({ state: 'merged', merged: 1, open: 1, closed: 1, total: 3, incomplete: false });
    expect(summary.contributions).toEqual([
      { record: closed, dates: [date] },
      { record: open, dates: [date, '2026-09-20'] },
      { record: merged, dates: ['2026-09-20'] },
    ]);
  });

  it.each([
    [[], false, 'none'],
    [[], true, 'unknown'],
    [[pullRequest(1, [problem()], { state: 'closed' })], false, 'closed'],
    [[pullRequest(1, [problem()], { state: 'closed' })], true, 'closed'],
    [[pullRequest(1, [problem()], { state: 'closed' }), pullRequest(2)], false, 'open'],
    [[pullRequest(1, [problem('2026-09-20')], { state: 'merged' })], true, 'merged'],
    [[pullRequest(1, [problem(date, 'cf5678b')], { filesTruncated: true })], false, 'unknown'],
  ] as const)('distinguishes known and incomplete evidence %#', (records, incomplete, state) => {
    expect(getProblemContributionSummary([...records], problemId, incomplete).state).toBe(state);
  });

  it('uses the newest PR state and clears obsolete truncation warnings', () => {
    const older = pullRequest(1, [problem()], { state: 'open', filesTruncated: true });
    const newer = pullRequest(1, [problem()], { state: 'merged', updatedAt: '2026-10-07T02:00:00Z' });
    expect(getProblemContributionSummary([newer, older], problemId)).toMatchObject({ state: 'merged', merged: 1, open: 0, total: 1, incomplete: false });
  });
});

describe('problem contribution status', () => {
  it.each([
    ['open', 'PR处理中'], ['merged', 'PR已合并'], ['closed', 'PR已关闭'],
  ] as const)('shows %s as the recorded PR state with its number and file date', (state, label) => {
    const markup = render([pullRequest(17, [problem()], { state })]);
    expect(markup).toContain(label);
    expect(markup).toContain('#17');
    expect(markup).toContain(`<time dateTime="${date}">${date}</time>`);
    expect(markup).toContain('aria-label="关联 PR"');
    expect(markup).not.toContain('当日关联 PR');
    expect(markup).not.toMatch(/AC|已通过|已解决/);
  });

  it('shows historical file dates in the same list without separate date groups', () => {
    const markup = render([pullRequest(7, [problem('2026-09-20')], { state: 'merged' })]);
    expect(markup).toContain('aria-label="关联 PR"');
    expect(markup).toContain('2026-09-20');
    expect(markup).toContain('PR已合并');
    expect(markup).not.toContain('当日关联 PR');
    expect(markup).not.toContain('曾在其他日期提交');
    expect(markup).not.toContain(date);
  });

  it('shows every related PR and each state count without a collapsed container', () => {
    const markup = render([
      pullRequest(17, [problem()], { state: 'closed' }),
      pullRequest(18, [problem()], { state: 'open' }),
      pullRequest(19, [problem('2026-09-20')], { state: 'merged' }),
    ]);
    expect(markup).not.toContain('<details');
    expect(markup).toContain('共 3 个关联 PR');
    for (const label of ['已合并 1 个 PR', '等待合并 1 个 PR', '已关闭 1 个 PR']) expect(markup).toContain(label);
    for (const value of ['#17', '#18', '#19', 'PR已关闭', 'PR处理中', 'PR已合并', '2026-09-20']) expect(markup).toContain(value);
    expect(markup.match(/<ul class="problem-contribution-list"/g)).toHaveLength(1);
    expect([...markup.matchAll(/<span>#(\d+)<\/span>/g)].map(match => Number(match[1]))).toEqual([19, 18, 17]);
    expect(markup).not.toContain('当日关联 PR');
    expect(markup).not.toContain('曾在其他日期提交');
  });

  it('renders one link per PR and all its matching dates once, even across multiple signatures or languages', () => {
    const record = pullRequest(17, [
      problem(), problem(date, problemId, 'py'), problem('2026-09-20'),
      { ...problem('2026-09-20'), path: '2026-09-20/cf1234a_bob.cpp' },
      problem('2025-01-01', 'cf5678b'), problem('2030-01-01'),
    ]);
    const markup = render([record, record]);
    expect(markup.match(/class="text-button problem-contribution-link"/g)).toHaveLength(1);
    expect([...markup.matchAll(/<time dateTime="([^"]+)"/g)].map(match => match[1])).toEqual(['2030-01-01', date, '2026-09-20']);
    expect(markup).toContain('等待合并 1 个 PR');
    expect(markup).not.toContain('2025-01-01');
    expect(markup).not.toContain('共 2 个关联 PR');
  });

  it('keeps all records visible when the problem has many PRs', () => {
    const records = Array.from({ length: 14 }, (_, index) => pullRequest(index + 1, [problem(index % 2 ? '2026-09-20' : date)], { state: index % 3 === 0 ? 'merged' : index % 3 === 1 ? 'open' : 'closed' }));
    const markup = render(records);
    expect(markup).not.toContain('<details');
    expect(markup.match(/class="text-button problem-contribution-link"/g)).toHaveLength(14);
    expect(markup).toContain('已合并 5 个 PR');
    expect(markup).toContain('等待合并 5 个 PR');
    expect(markup).toContain('已关闭 4 个 PR');
    expect(markup).toContain('#14');
  });

  it('localizes the combined state counts without translating PR titles', () => {
    setLocale('en');
    try {
      const markup = render([
        pullRequest(1, [problem()], { state: 'merged', title: '用户原始标题' }),
        pullRequest(2),
        pullRequest(3, [problem()], { state: 'closed' }),
      ]);
      for (const label of ['Merged PRs: 1', 'Open PRs: 1', 'Closed PRs: 1', 'Related PRs: 3', '用户原始标题']) expect(markup).toContain(label);
      expect(markup).toContain('aria-label="Related PRs"');
      expect(markup).not.toContain('Related PRs for this date');
      expect(markup).not.toContain('Submitted for other dates');
      expect(markup).not.toContain('等待合并');
    } finally { setLocale('zh-CN'); }
  });

  it('uses neutral missing evidence wording only for complete results', () => {
    expect(render([])).toContain('暂未找到关联 PR');
    const incomplete = render([], { incomplete: true });
    expect(incomplete).toContain('状态未完整获取');
    expect(incomplete).not.toContain('暂未找到关联 PR');
    expect(incomplete).not.toContain('未提交');
    expect(render([], { suppressUnknown: true })).toBe('');
  });

  it('keeps observed matches while acknowledging incomplete retrieval', () => {
    const markup = render([pullRequest(17)], { incomplete: true, suppressUnknown: true });
    expect(markup).toContain('#17');
    expect(markup).toContain('PR处理中');
    expect(markup).toContain('状态未完整获取');
  });

  it('treats truncated file lists as incomplete even without an explicit incomplete flag', () => {
    const noMatch = render([pullRequest(17, [], { filesTruncated: true })]);
    expect(noMatch).toContain('状态未完整获取');
    expect(noMatch).not.toContain('暂未找到关联 PR');
    const withMatch = render([pullRequest(17, [problem()], { filesTruncated: true })]);
    expect(withMatch).toContain('PR处理中');
    expect(withMatch).toContain('状态未完整获取');
  });

  it('shows a nonblocking repeat notice only when there is related evidence', () => {
    expect(render([], { warning: true })).toBe('');
    expect(render([], { warning: true, incomplete: true })).toBe('');
    const markup = render([pullRequest(17, [problem('2026-09-20')])], { warning: true });
    expect(markup).toContain('这道题已关联以下 PR，仍可继续提交。');
    expect(markup).toContain('#17');
    expect(markup).toContain('aria-label="关联 PR"');
    expect(markup).not.toContain('disabled');
  });
});
