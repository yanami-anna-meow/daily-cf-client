import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../shared/i18n';
import type { LibrarySyncProgress } from '../shared/types';
import LibrarySyncNotice from '../src/components/LibrarySyncNotice';

const render = (progress: LibrarySyncProgress | null, action = false) => renderToStaticMarkup(
  <LibrarySyncNotice progress={progress} onRefresh={action ? () => {} : undefined} />,
);

describe('library synchronization feedback', () => {
  beforeEach(() => setLocale('zh-CN'));
  afterEach(() => setLocale('zh-CN'));

  it('does not add an empty status strip or duplicate a page refresh action', () => {
    expect(render(null)).toBe('');
    expect(render({ phase: 'ready', completed: 0, unit: 'objects' })).not.toContain('<button');
    expect(render(null, true)).toContain('data-testid="library-sync-refresh"');
  });

  it('shows download size without inventing a percentage before the total is known', () => {
    const markup = render({ phase: 'downloading', completed: 1024 * 1024 * 2.5, unit: 'bytes' }, true);
    expect(markup).toContain('正在下载题库…');
    expect(markup).toContain('2.5 MB');
    expect(markup).toContain('<progress max="1"');
    expect(markup).not.toContain('<progress value=');
    expect(markup).toContain('disabled=""');
  });

  it('shows repair as ongoing work without claiming success or adding a second status area', () => {
    const progress: LibrarySyncProgress = { phase: 'repairing', completed: 0, unit: 'objects' };
    const markup = render(progress, true);
    expect(markup).toContain('正在修复本地题库…');
    expect(markup).toContain('data-sync-phase="repairing"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('<time');
    expect(markup).not.toContain('<progress');
    setLocale('en');
    expect(render(progress)).toContain('Repairing the local library…');
  });

  it('clamps measured progress to the reported total and formats object counts', () => {
    const markup = render({ phase: 'indexing', completed: 2000, total: 1900, unit: 'objects' });
    expect(markup).toContain('正在整理题目…');
    expect(markup).toContain('<progress value="1900" max="1900"');
    expect(markup).toContain('2,000 / 1,900');
  });

  it('handles unavailable or invalid counters without rendering NaN or an invalid maximum', () => {
    for (const total of [0, -1, NaN, Infinity]) {
      const markup = render({ phase: 'downloading', completed: NaN, total, unit: 'bytes' });
      expect(markup).toContain('<progress max="1"');
      expect(markup).not.toContain('NaN');
      expect(markup).not.toContain('Infinity');
    }
  });

  it('stops the spinner and makes retry available when synchronization fails', () => {
    const markup = render({ phase: 'error', completed: 0, unit: 'objects', message: 'Connection interrupted <remote>', updatedAt: '2026-10-09T01:00:00Z' }, true);
    expect(markup).toContain('题库更新失败');
    expect(markup).toContain('Connection interrupted &lt;remote&gt;');
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain('disabled=');
    expect(markup).not.toContain('class="spin"');
    expect(markup).not.toContain('<time');
  });

  it('shows the last successful update time only for a successful sync', () => {
    const markup = render({ phase: 'ready', completed: 0, unit: 'objects', updatedAt: '2026-10-09T01:00:00Z', message: 'obsolete failure' }, true);
    expect(markup).toContain('题库已更新');
    expect(markup).toContain('dateTime="2026-10-09T01:00:00Z"');
    expect(markup).not.toContain('obsolete failure');
    expect(markup).not.toContain('disabled=');
  });

  it('translates phase, action and accessibility text when the language changes', () => {
    setLocale('en');
    const markup = render({ phase: 'checking', completed: 0, unit: 'objects' }, true);
    expect(markup).toContain('Updating the problem library…');
    expect(markup).toContain('aria-label="Library update"');
    expect(markup).toContain('Refresh');
    expect(markup).not.toContain('刷新');
    expect(render({ phase: 'downloading', completed: 0, unit: 'bytes' })).toContain('aria-label="Library update progress"');
  });
});
