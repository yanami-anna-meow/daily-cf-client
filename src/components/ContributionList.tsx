import { ArrowUpRight, ChevronDown, CircleHelp, GitPullRequest } from 'lucide-react';
import type { ContributionProblem, RemotePullRequest } from '../../shared/types';
import { extensionLanguageLabel, importExtension, normalizeExtension } from '../../shared/file-formats';
import { getLocale, t } from '../../shared/i18n';

interface ContributionListProps {
  items: RemotePullRequest[];
  openExternal: (url: string) => void;
}

const VISIBLE_FILES = 5;
const FILE_STATUS_LABELS: Record<string, string> = {
  added: '新增', removed: '删除', modified: '修改', renamed: '重命名',
  copied: '已复制', changed: '变更', unchanged: '未变更',
};

function languageLabel(problem: ContributionProblem) {
  try {
    return extensionLanguageLabel(normalizeExtension(importExtension(problem.path)));
  } catch {
    return t('未识别');
  }
}

function timeLabel(value: string) {
  return new Date(value).toLocaleString(getLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function ProblemChips({ problems }: { problems: ContributionProblem[] }) {
  return <ul className="history-problems" aria-label={t('题目解答文件')}>
    {problems.map((problem) => {
      const language = languageLabel(problem);
      const label = `${problem.problemId.toUpperCase()} · ${problem.date} · ${language}`;
      return <li className="history-problem-chip" key={problem.path} title={problem.path} aria-label={`${label} · ${problem.path}`}>
        <span>{problem.problemId.toUpperCase()}</span>
        <time dateTime={problem.date}>{problem.date}</time>
        <small>{language}</small>
      </li>;
    })}
  </ul>;
}

export default function ContributionList({ items, openExternal }: ContributionListProps) {
  return <div className="panel history-panel">
    <div className="history-table-header" aria-hidden="true"><span>{t('Pull Request / 题目信息')}</span><span>{t('语言')}</span><span>{t('状态')}</span><span>GitHub</span></div>
    {items.map((record) => {
      const problems = record.problems;
      const otherFiles = record.otherFiles ?? [];
      const languages = [...new Set(problems.map(languageLabel))];
      const stateLabel = t(record.state === 'merged' ? '已合并' : record.state === 'closed' ? '已关闭' : '处理中');
      return <article className="history-row" key={record.id} aria-label={t('PR #{{number}}：{{title}}', { number: record.number, title: record.title })}>
        <div className="history-problem">
          <span className={`pr-icon pr-${record.state}`} aria-hidden="true"><GitPullRequest size={21} /></span>
          <div>
            <strong title={record.title}>{record.title}</strong>
            {problems.length > 0 ? <>
              <p className="history-file-count">{t('已识别 {{count}} 个解答文件', { count: problems.length })}</p>
              <ProblemChips problems={problems.slice(0, VISIBLE_FILES)} />
              {problems.length > VISIBLE_FILES && <details className="history-problem-more">
                <summary>{t('其余 {{remaining}} 个解答文件（共 {{count}} 个）', { remaining: problems.length - VISIBLE_FILES, count: problems.length })}<ChevronDown size={13} aria-hidden="true" /></summary>
                <ProblemChips problems={problems.slice(VISIBLE_FILES)} />
              </details>}
            </> : <p>{t('未识别到题目文件')}</p>}
            {otherFiles.length > 0 && <details className="history-problem-more history-other-files">
              <summary>{t('其他变更文件（{{count}} 个）', { count: otherFiles.length })}<ChevronDown size={13} aria-hidden="true" /></summary>
              <ul className="history-other-files-list" aria-label={t('其他变更文件')}>
                {otherFiles.map((file) => <li key={file.path}>
                  <span className="history-file-status" title={file.status}>{Object.hasOwn(FILE_STATUS_LABELS, file.status) ? t(FILE_STATUS_LABELS[file.status]) : file.status || t('未知')}</span>
                  <code title={file.path}>{file.path}</code>
                </li>)}
              </ul>
            </details>}
            {record.filesTruncated && <p className="history-detail-warning"><CircleHelp size={13} aria-hidden="true" /><span>{t('文件列表的完整性尚未核实，当前显示已读取的文件。刷新可重新读取。')}</span></p>}
            <span>{t('创建于')} <time dateTime={record.createdAt} title={new Date(record.createdAt).toLocaleString(getLocale())}>{timeLabel(record.createdAt)}</time> · {t('更新于')} <time dateTime={record.updatedAt} title={new Date(record.updatedAt).toLocaleString(getLocale())}>{timeLabel(record.updatedAt)}</time></span>
          </div>
        </div>
        <div className="history-languages" aria-label={t('解答语言')}>
          {languages.map((language) => <span className="language-badge" key={language}>{language}</span>)}
          {!problems.length && <span className="language-badge">—</span>}
        </div>
        <span className={`pr-status pr-${record.state}`}>{stateLabel}</span>
        <button type="button" className="text-button" aria-label={t('在 GitHub 查看 PR #{{number}}：{{title}}', { number: record.number, title: record.title })} onClick={() => openExternal(record.url)}>#{record.number} <ArrowUpRight size={15} aria-hidden="true" /></button>
      </article>;
    })}
  </div>;
}
