import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CodeDiff, { diffLines, type LineDiff } from '../src/components/CodeDiff';

function requireDiff(result: LineDiff) {
  if (result.kind !== 'diff') throw new Error(`Unexpected fallback: ${result.reason}`);
  return result;
}

function assertReconstruction(previous: string, next: string) {
  const result = requireDiff(diffLines(previous, next));
  expect(result.lines.filter(line => line.kind !== 'add').map(line => line.text).join('')).toBe(previous);
  expect(result.lines.filter(line => line.kind !== 'remove').map(line => line.text).join('')).toBe(next);
  expect(result.lines.flatMap(line => line.previousLine === undefined ? [] : [line.previousLine]))
    .toEqual(Array.from({ length: result.previousLines }, (_, index) => index + 1));
  expect(result.lines.flatMap(line => line.nextLine === undefined ? [] : [line.nextLine]))
    .toEqual(Array.from({ length: result.nextLines }, (_, index) => index + 1));
  return result;
}

describe('bounded exact line diff', () => {
  it('aligns unchanged context and reports deletions before replacement additions', () => {
    const result = assertReconstruction('head\nx\ny\ntail\n', 'head\np\nq\ntail\n');
    expect(result.lines).toEqual([
      { kind: 'context', text: 'head\n', previousLine: 1, nextLine: 1 },
      { kind: 'remove', text: 'x\n', previousLine: 2 },
      { kind: 'remove', text: 'y\n', previousLine: 3 },
      { kind: 'add', text: 'p\n', nextLine: 2 },
      { kind: 'add', text: 'q\n', nextLine: 3 },
      { kind: 'context', text: 'tail\n', previousLine: 4, nextLine: 4 },
    ]);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(2);
  });

  it.each([
    ['', ''], ['', 'a\n\n'], ['a\n\n', ''], ['\n', '\n\n'],
    ['a', 'a\n'], ['a\n', 'a'], ['a\r\n', 'a\n'],
    ['a\r\n\nb\r\nc', 'a\n\nb\r\nc\n'], ['a \n\tb\n', 'a\n b\n'],
    ['a\rb\n', 'a\rc\n'], ['a\nb\na\n', 'a\na\nb\n'],
    ['题🙂\r\n', '题😀\n'],
  ])('preserves the exact source and line numbers for %j → %j', (previous, next) => {
    const result = assertReconstruction(previous, next);
    expect(result.additions + result.deletions === 0).toBe(previous === next);
  });

  it('treats a final newline as part of the preceding line, without inventing an empty line', () => {
    expect(requireDiff(diffLines('', '')).lines).toEqual([]);
    const result = requireDiff(diffLines('a', 'a\n'));
    expect(result.previousLines).toBe(1);
    expect(result.nextLines).toBe(1);
    expect(result.lines.map(line => line.kind)).toEqual(['remove', 'add']);
  });

  it('reconstructs combinations with repeated lines, blank lines, and mixed endings', () => {
    const values = ['', 'last'];
    for (const first of ['a\n', 'b\r\n', '\n']) {
      values.push(first, `${first}last`);
      for (const second of ['a\n', 'b\r\n', '\n']) values.push(first + second, `${first}${second}last`);
    }
    for (const previous of values) for (const next of values) assertReconstruction(previous, next);
  });

  it('allows exactly 256 KiB per input and falls back above the byte limit', () => {
    const boundary = 'a'.repeat(256 * 1024);
    expect(diffLines(boundary, boundary).kind).toBe('diff');
    expect(diffLines(boundary + 'a', '')).toMatchObject({ kind: 'side-by-side', reason: 'size' });
    expect(diffLines('', boundary + 'a')).toMatchObject({ kind: 'side-by-side', reason: 'size' });
    const multibyte = '题'.repeat(88 * 1024);
    expect(multibyte.length).toBeLessThan(256 * 1024);
    expect(diffLines(multibyte, '')).toMatchObject({ kind: 'side-by-side', reason: 'size' });
  });

  it('bounds matrix allocation and rendered rows while still handling small edits in long files', () => {
    const boundaryOld = 'old\n'.repeat(999);
    const boundaryNew = 'new\n'.repeat(999);
    // Sentinel rows/columns bring this exact boundary to 1,000,000 cells.
    expect(diffLines(boundaryOld, boundaryNew).kind).toBe('diff');
    const oldLines = Array.from({ length: 1_000 }, (_, index) => `old-${index}\n`).join('');
    const newLines = Array.from({ length: 1_000 }, (_, index) => `new-${index}\n`).join('');
    expect(diffLines(oldLines, newLines)).toMatchObject({ kind: 'side-by-side', reason: 'complexity' });
    expect(diffLines('a\n'.repeat(4_000), '').kind).toBe('diff');
    expect(diffLines('a\n'.repeat(4_001), '')).toMatchObject({ kind: 'side-by-side', reason: 'complexity' });
    const unchanged = 'common\n'.repeat(1_500);
    const result = assertReconstruction(unchanged + 'old\n', unchanged + 'new\n');
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
  });
});

describe('code diff display', () => {
  it('renders source as escaped text, with real change indicators and visible line endings', () => {
    const markup = renderToStaticMarkup(<CodeDiff previous={'<script>bad()</script>\r\n'} next={'<img src=x>'} language="C++" />);
    expect(markup).not.toMatch(/<(?:script|img)\b/);
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('&lt;img src=x&gt;');
    expect(markup).toContain('code-diff-line--remove');
    expect(markup).toContain('code-diff-line--add');
    expect(markup).toContain('CRLF');
    expect(markup).toContain('文件末尾无换行');
    expect(markup).toContain('font-family:var(--font-code);font-size:14px');
  });

  it('renders exact full source in a clearly labelled fallback', () => {
    const previous = '<script>previous</script>\r\n' + 'a'.repeat(256 * 1024);
    const next = '<img src=x>\n\tnew\n';
    const markup = renderToStaticMarkup(<CodeDiff previous={previous} next={next} />);
    expect(markup).toContain('内容较长，显示并排对照');
    expect(markup).not.toContain('code-diff-line--');
    expect(markup).not.toContain('新增 0 行');
    expect(markup).toContain(renderToStaticMarkup(<code style={{ fontFamily: 'var(--font-code)', fontSize: 14 }}>{previous}</code>));
    expect(markup).toContain(renderToStaticMarkup(<code style={{ fontFamily: 'var(--font-code)', fontSize: 14 }}>{next}</code>));
  });

  it('does not imply the whole existing file was compared when its preview is truncated', () => {
    const markup = renderToStaticMarkup(<CodeDiff previous="same" next="same" truncated />);
    expect(markup).toContain('仓库现有代码预览不完整');
    expect(markup).toContain('部分预览');
    expect(markup).toContain('现有文件其余内容未显示');
    expect(markup).not.toContain('代码内容相同。');
  });
});
