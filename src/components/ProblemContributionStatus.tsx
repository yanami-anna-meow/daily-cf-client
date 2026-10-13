import { ArrowUpRight, CircleDashed, CircleHelp, GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react';
import { normalizeProblemId } from '../../shared/domain';
import { latestPullRequests } from '../../shared/contributions';
import type { RemotePullRequest } from '../../shared/types';
import { getLocale, t } from '../../shared/i18n';

export interface ProblemContribution {
  record: RemotePullRequest;
  dates: string[];
}

export interface ProblemContributionSummary {
  contributions: ProblemContribution[];
  state: 'merged' | 'open' | 'closed' | 'none' | 'unknown';
  merged: number;
  open: number;
  closed: number;
  total: number;
  incomplete: boolean;
}

export interface ProblemContributionStatusProps {
  problemId: string;
  records: RemotePullRequest[];
  incomplete?: boolean;
  onOpen: (url: string) => void;
  compact?: boolean;
  warning?: boolean;
  suppressUnknown?: boolean;
}

function normalizedId(value: string): string | null {
  try { return normalizeProblemId(value); } catch { return null; }
}

function creationTime(record: RemotePullRequest): number {
  const time = Date.parse(record.createdAt);
  return Number.isFinite(time) ? time : -Infinity;
}

function matchProblems(records: RemotePullRequest[], problemId: string): ProblemContribution[] {
  const id = normalizedId(problemId);
  if (!id) return [];
  const contributions: ProblemContribution[] = [];
  for (const record of records) {
    const dates = new Set(record.problems.filter(problem => normalizedId(problem.problemId) === id).map(problem => problem.date));
    if (dates.size) contributions.push({ record, dates: [...dates].sort((a, b) => b.localeCompare(a)) });
  }
  return contributions.sort((a, b) => {
    const first = creationTime(a.record), second = creationTime(b.record);
    if (first !== second) return first > second ? -1 : 1;
    return b.record.number - a.record.number || a.record.id.localeCompare(b.record.id);
  });
}

/** Match identified solution files, never PR titles or summary metadata. */
export function findProblemContributions(records: RemotePullRequest[], problemId: string): ProblemContribution[] {
  return matchProblems(latestPullRequests(records), problemId);
}

/** One source of truth for card colors, counts, and the visible PR evidence. */
export function getProblemContributionSummary(records: RemotePullRequest[], problemId: string, incomplete = false): ProblemContributionSummary {
  const snapshots = latestPullRequests(records);
  const contributions = matchProblems(snapshots, problemId);
  const counts = { merged: 0, open: 0, closed: 0 };
  for (const { record } of contributions) counts[record.state]++;
  const statusIncomplete = incomplete || snapshots.some(record => record.filesTruncated);
  const state = counts.merged ? 'merged' : counts.open ? 'open' : counts.closed ? 'closed' : statusIncomplete ? 'unknown' : 'none';
  return { contributions, ...counts, total: contributions.length, incomplete: statusIncomplete, state };
}

const STATE_LABELS: Record<RemotePullRequest['state'], string> = {
  open: 'PR处理中',
  merged: 'PR已合并',
  closed: 'PR已关闭',
};

function ContributionLink({ record, dates, onOpen }: {
  record: RemotePullRequest;
  dates: string[];
  onOpen: (url: string) => void;
}) {
  return <li>
    <button type="button" className="text-button problem-contribution-link" onClick={() => onOpen(record.url)}
      title={record.title} aria-label={t('在 GitHub 查看 {{dates}} 的 PR #{{number}}：{{state}}', { dates: dates.join(getLocale().startsWith('zh') ? '、' : ', '), number: record.number, state: t(STATE_LABELS[record.state]) })}>
      <span className="problem-contribution-dates">{dates.map((date, index) => <span key={date}>
        {index > 0 && (getLocale().startsWith('zh') ? '、' : ', ')}<time dateTime={date}>{date}</time>
      </span>)}</span>
      <span className="problem-contribution-reference">
        <span>#{record.number}</span>
        <span className={`pr-status pr-${record.state}`}>{t(STATE_LABELS[record.state])}</span>
        <ArrowUpRight size={13} aria-hidden="true" />
      </span>
    </button>
  </li>;
}

export default function ProblemContributionStatus({
  problemId, records, incomplete = false, onOpen, compact = false, warning = false, suppressUnknown = false,
}: ProblemContributionStatusProps) {
  const summary = getProblemContributionSummary(records, problemId, incomplete);
  const { contributions, total: relatedCount, incomplete: statusIncomplete } = summary;
  const className = `problem-contribution-status${compact ? ' is-compact' : ''}${warning ? ' is-warning' : ''}`;

  if (!relatedCount) {
    if (warning || suppressUnknown) return null;
    return <div className={`${className} problem-contribution-empty`}>
      {statusIncomplete ? <CircleHelp size={14} aria-hidden="true" /> : <CircleDashed size={14} aria-hidden="true" />}
      {t(statusIncomplete ? '状态未完整获取' : '暂未找到关联 PR')}
    </div>;
  }

  return <div className={className}>
    {warning && <p className="problem-contribution-notice">{t('这道题已关联以下 PR，仍可继续提交。')}</p>}
    <div className="problem-contribution-summary" aria-label={t('关联 PR 状态统计')}>
      <span className="problem-contribution-summary-states">
        {summary.merged > 0 && <span className="pr-status pr-merged"><GitMerge size={14} aria-hidden="true" />{t('已合并 {{count}} 个 PR', { count: summary.merged })}</span>}
        {summary.open > 0 && <span className="pr-status pr-open"><GitPullRequest size={14} aria-hidden="true" />{t('等待合并 {{count}} 个 PR', { count: summary.open })}</span>}
        {summary.closed > 0 && <span className="pr-status pr-closed"><GitPullRequestClosed size={14} aria-hidden="true" />{t('已关闭 {{count}} 个 PR', { count: summary.closed })}</span>}
      </span>
      {relatedCount > 1 && <span className="problem-contribution-total">{t('共 {{count}} 个关联 PR', { count: relatedCount })}</span>}
    </div>
    <ul className="problem-contribution-list" aria-label={t('关联 PR')}>
      {contributions.map(({ record, dates }) => <ContributionLink key={record.id} record={record} dates={dates} onOpen={onOpen} />)}
    </ul>
    {statusIncomplete && <span className="problem-contribution-incomplete">{t('状态未完整获取，可能还有其他关联 PR')}</span>}
  </div>;
}
