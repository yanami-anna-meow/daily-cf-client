import type { Dispatch, SetStateAction } from 'react';
import { ChevronDown, CircleHelp, ExternalLink, ShieldCheck } from 'lucide-react';
import type { BatchSubmissionPreview, RemotePullRequest, SubmissionInput } from '../../shared/types';
import { extensionLanguageLabel, importExtension, normalizeExtension } from '../../shared/file-formats';
import { submissionExtension, submissionPath } from '../../shared/domain';
import { api } from '../bridge';
import { t, useLocale } from '../i18n';
import CodeDiff from './CodeDiff';
import Markdown from './Markdown';
import ProblemContributionStatus from './ProblemContributionStatus';

interface Props {
  preview: BatchSubmissionPreview;
  repository: string;
  login: string;
  records: RemotePullRequest[];
  statusIncomplete: boolean;
  normalizedInputs: Map<string, SubmissionInput>;
  confirmedOverwrites: Set<string>;
  onConfirmedOverwritesChange: Dispatch<SetStateAction<Set<string>>>;
  submitBusy: boolean;
  onError: (message: string) => void;
}

function fileLanguageLabel(path: string, input?: SubmissionInput): string {
  try {
    if (input && submissionPath(input) === path) return extensionLanguageLabel(submissionExtension(input));
    return extensionLanguageLabel(normalizeExtension(importExtension(path)));
  } catch {
    return t('未识别');
  }
}

export default function QueuePreview({ preview, repository, login, records, statusIncomplete, normalizedInputs, confirmedOverwrites, onConfirmedOverwritesChange, submitBusy, onError }: Props) {
  const locale = useLocale();
  const changedFiles = preview.items.filter(file => !file.unchanged);
  const changedBytes = changedFiles.reduce((sum, file) => sum + file.bytes, 0);
  const openExternal = (url: string) => {
    void api.openExternal(url).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : String(reason)));
  };

  return <section className="submission-preview">
    <div className="preview-title"><ShieldCheck size={18} /><strong>{t('确认提交')}</strong><span>{t('以 {{login}} 的身份提交', { login })}</span></div>
    <dl>
      <dt>{t('目标仓库')}</dt><dd>{repository}</dd>
      {preview.forkRepository && <><dt>{t('提交来源')}</dt><dd>{preview.forkRepository}</dd></>}
      {preview.forkSync && <>
        <dt>{t('Fork 状态')}</dt>
        <dd className={`fork-sync-status fork-sync-${preview.forkSync.state}`}>
          {preview.forkSync.state === 'synced' ? t('已与上游同步')
            : preview.forkSync.state === 'behind' ? t('落后上游 {{value1}} 条提交，将在提交代码前安全同步', { value1: preview.forkSync.behindBy })
              : preview.forkSync.state === 'ahead' ? t('已包含上游最新内容，另有 {{value1}} 条提交会保留', { value1: preview.forkSync.aheadBy })
                : t('与上游分叉，暂时不能提交')}
          {preview.forkSync.state === 'diverged' && <>
            <p>{t('请在 GitHub 处理分叉后返回调整并重新预览。客户端不会强制推送。')}</p>
            <button className="text-button" type="button" onClick={() => openExternal(`https://github.com/${preview.forkSync!.repository}`)}>{t('查看 Fork')}<ExternalLink size={13} /></button>
          </>}
        </dd>
      </>}
      <dt>{t('PR 标题')}</dt><dd>{preview.title}</dd>
      <dt>{t('提交文件')}</dt><dd>{t('{{count}} 个文件 · {{bytes}} 字节', { count: changedFiles.length, bytes: changedBytes.toLocaleString(locale) })}</dd>
    </dl>
    <div className="batch-preview-files">
      {preview.items.map(file => <article key={file.path} className="batch-preview-file">
        <div><strong>{file.problemId.toUpperCase()}</strong><span>{file.date}</span><small>{file.unchanged ? t('内容相同') : file.existing ? t('覆盖已有文件') : t('新增文件')}</small></div>
        <p className="path-preview">{file.path}</p>
        {!normalizedInputs.has(file.path) && <p className="inline-error">{t('预览路径与当前文件不一致，请返回调整并重新预览。')}</p>}
        <ProblemContributionStatus problemId={file.problemId} records={records} incomplete={statusIncomplete} warning onOpen={openExternal} />
        {file.problem.sourceWarning && <div className="alert alert-warning source-warning"><CircleHelp size={16} /><span>{t(file.problem.sourceWarning)}</span></div>}
        {file.unchanged ? <p className="unchanged-file-notice">{t('与上游内容相同，将跳过此文件。')}</p>
          : file.existing && <section className="overwrite-confirmation" aria-label={t('覆盖检查 {{value1}}', { value1: file.path })}>
            <strong><CircleHelp size={17} />{t('本次 PR 将修改上游已有文件')}</strong>
            <p>{t('请核对完整路径、署名和代码差异。')} {t('代码将提交到个人 Fork，合并此 PR 后才会更新上游文件。')}</p>
            {file.previous ? <>
              <CodeDiff previous={file.previous.code} next={normalizedInputs.get(file.path)?.code || ''} language={fileLanguageLabel(file.path, normalizedInputs.get(file.path))} truncated={file.previous.truncated} />
              <label className="overwrite-checkbox">
                <input type="checkbox" aria-label={t('确认覆盖 {{value1}}', { value1: file.path })} checked={confirmedOverwrites.has(file.path)} disabled={submitBusy} onChange={event => {
                  const checked = event.target.checked;
                  onConfirmedOverwritesChange(current => {
                    const next = new Set(current);
                    if (checked) next.add(file.path); else next.delete(file.path);
                    return next;
                  });
                }} />
                <span>{t('我已核对差异，确认在本次 PR 中修改此文件')}</span>
              </label>
            </> : <p className="inline-error">{t('未取得现有文件内容，暂时不能提交。请返回调整并重新预览。')}</p>}
          </section>}
      </article>)}
    </div>
    {preview.body && <details className="submission-body-preview" open><summary>{t('PR 描述 · 完整预览')}<ChevronDown size={13} /></summary><Markdown content={preview.body} /></details>}
    <p>{t('有变更的文件将提交到同一个 PR。')}</p>
  </section>;
}
