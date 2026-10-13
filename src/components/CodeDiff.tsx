import { useMemo } from 'react';
import { t } from '../../shared/i18n';

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_DIFF_ROWS = 4_000;
const MAX_LCS_CELLS = 1_000_000;
const codeStyle = { fontFamily: 'var(--font-code)', fontSize: 14 };

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  /** Original source, including its exact line terminator when present. */
  text: string;
  previousLine?: number;
  nextLine?: number;
}

export type LineDiff = {
  kind: 'diff';
  lines: DiffLine[];
  previousLines: number;
  nextLines: number;
  additions: number;
  deletions: number;
} | {
  kind: 'side-by-side';
  reason: 'size' | 'complexity';
  previousLines: number;
  nextLines: number;
};

function countLines(source: string): number {
  let count = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\r') {
      count++;
      if (source[index + 1] === '\n') index++;
    } else if (source[index] === '\n') {
      count++;
    }
  }
  return count + (source.length > 0 && !/[\r\n]$/.test(source) ? 1 : 0);
}

function sourceLines(source: string): string[] {
  return source.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
}

/** Exact line diff with bounded memory/work; a fallback never claims a computed diff. */
export function diffLines(previous: string, next: string): LineDiff {
  const previousLines = countLines(previous);
  const nextLines = countLines(next);
  const fallback = (reason: 'size' | 'complexity'): LineDiff => ({
    kind: 'side-by-side', reason, previousLines, nextLines,
  });
  // Bound individual inputs before allocating token arrays or an encoded copy.
  if (previous.length > MAX_SOURCE_BYTES || next.length > MAX_SOURCE_BYTES
    || new TextEncoder().encode(previous).byteLength > MAX_SOURCE_BYTES
    || new TextEncoder().encode(next).byteLength > MAX_SOURCE_BYTES) return fallback('size');
  if (previousLines + nextLines > MAX_DIFF_ROWS) return fallback('complexity');

  const before = sourceLines(previous);
  const after = sourceLines(next);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;

  const oldLength = before.length - prefix - suffix;
  const newLength = after.length - prefix - suffix;
  const columns = newLength + 1;
  // Prefix/suffix trimming keeps a small edit in a long file inexpensive.
  const cells = (oldLength + 1) * columns;
  if (cells > MAX_LCS_CELLS) return fallback('complexity');
  const lcs = new Uint32Array(cells);
  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex--) {
      const cell = oldIndex * columns + newIndex;
      lcs[cell] = before[prefix + oldIndex] === after[prefix + newIndex]
        ? lcs[cell + columns + 1] + 1
        : Math.max(lcs[cell + columns], lcs[cell + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let previousLine = 1;
  let nextLine = 1;
  let additions = 0;
  let deletions = 0;
  const append = (kind: DiffLine['kind'], text: string) => {
    const line: DiffLine = { kind, text };
    if (kind !== 'add') line.previousLine = previousLine++;
    if (kind !== 'remove') line.nextLine = nextLine++;
    if (kind === 'add') additions++;
    if (kind === 'remove') deletions++;
    lines.push(line);
  };
  for (let index = 0; index < prefix; index++) append('context', before[index]);
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLength || newIndex < newLength) {
    if (oldIndex < oldLength && newIndex < newLength
      && before[prefix + oldIndex] === after[prefix + newIndex]) {
      append('context', before[prefix + oldIndex]);
      oldIndex++;
      newIndex++;
    } else if (oldIndex < oldLength && (newIndex === newLength
      || lcs[(oldIndex + 1) * columns + newIndex] >= lcs[oldIndex * columns + newIndex + 1])) {
      append('remove', before[prefix + oldIndex++]);
    } else {
      append('add', after[prefix + newIndex++]);
    }
  }
  for (let index = before.length - suffix; index < before.length; index++) append('context', before[index]);
  return { kind: 'diff', lines, previousLines, nextLines, additions, deletions };
}

export interface CodeDiffProps {
  previous: string;
  next: string;
  language?: string;
  truncated?: boolean;
  context?: 'repository' | 'queue';
}

export default function CodeDiff({ previous, next, language, truncated = false, context = 'repository' }: CodeDiffProps) {
  const result = useMemo(() => diffLines(previous, next), [previous, next]);
  const previousLabel = context === 'queue' ? t('列表中的代码') : t('仓库现有代码');
  const nextLabel = context === 'queue' ? t('本次选择的代码') : t('即将提交代码');

  return <section className="code-diff" aria-label={t('覆盖代码对照')}>
    {truncated && <p className="code-diff-warning" role="note">{t('仓库现有代码预览不完整，下方仅包含已加载的部分。请查看仓库原文件后确认覆盖。')}</p>}
    <div className="code-diff-summary">
      <span>{context === 'queue' ? t('列表现有：{{count}} 行', { count: result.previousLines }) : t('仓库现有：{{count}} 行', { count: result.previousLines })}{truncated ? t('（部分预览）') : ''}</span>
      <span>{context === 'queue' ? t('本次选择：{{count}} 行', { count: result.nextLines }) : t('即将提交：{{count}} 行', { count: result.nextLines })}</span>
      {result.kind === 'diff' && <span>{t('新增 {{added}} 行 · 删除 {{removed}} 行', { added: result.additions, removed: result.deletions })}</span>}
      {language && <span>{language}</span>}
    </div>
    {result.kind === 'side-by-side' ? <>
      <p className="code-diff-warning">{t('内容较长，显示并排对照')}</p>
      <div className="code-diff-side-by-side">
        <div className="code-diff-pane">
          <h4>{previousLabel}{truncated ? t('（部分预览）') : ''}</h4>
          {previous.length === 0 && <p className="code-diff-empty">{t('空文件')}</p>}
          <pre className="code-diff-source" style={codeStyle} tabIndex={0} aria-label={previousLabel}><code style={codeStyle}>{previous}</code></pre>
        </div>
        <div className="code-diff-pane">
          <h4>{nextLabel}</h4>
          {next.length === 0 && <p className="code-diff-empty">{t('空文件')}</p>}
          <pre className="code-diff-source" style={codeStyle} tabIndex={0} aria-label={nextLabel}><code style={codeStyle}>{next}</code></pre>
        </div>
      </div>
    </> : <>
      {result.additions === 0 && result.deletions === 0 && <p className="code-diff-empty">{truncated ? t('已加载部分与待提交代码一致；现有文件其余内容未显示。') : previous.length === 0 ? t('两份代码均为空文件。') : t('代码内容相同。')}</p>}
      {result.lines.length > 0 && <div className="code-diff-lines" style={codeStyle} tabIndex={0} role="region" aria-label={context === 'queue' ? t('代码逐行差异；前两列为列表现有与本次选择的行号') : t('代码逐行差异；前两列为仓库现有与即将提交的行号')}>
        {result.lines.map((line, index) => {
          const ending = /(?:\r\n|\n|\r)$/.exec(line.text)?.[0] ?? '';
          const content = ending ? line.text.slice(0, -ending.length) : line.text;
          return <div className={`code-diff-line code-diff-line--${line.kind}`} key={index}>
            <span className="code-diff-number" aria-hidden="true">{line.previousLine ?? ''}</span>
            <span className="code-diff-number" aria-hidden="true">{line.nextLine ?? ''}</span>
            <span className="code-diff-marker"><span aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span><span className="sr-only">{line.kind === 'add' ? t('新增行：') : line.kind === 'remove' ? t('删除行：') : t('未更改行：')}</span></span>
            <code className="code-diff-source" style={codeStyle}>{content}</code>
            {line.kind !== 'context' && <span className="code-diff-ending">{ending === '\r\n' ? 'CRLF' : ending === '\n' ? 'LF' : ending === '\r' ? 'CR' : t('文件末尾无换行')}</span>}
          </div>;
        })}
      </div>}
    </>}
  </section>;
}
