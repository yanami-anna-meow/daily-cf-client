import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState, ProblemDay, Settings } from '../shared/types';
import { setLocale } from '../shared/i18n';
import BatchComposer from '../src/components/BatchComposer';

vi.mock('../src/bridge', () => ({ api: { isDesktop: true } }));

const day: ProblemDay = {
  date: '2030-01-02', sourceUrl: 'https://github.com/example/problems', fetchedAt: '2030-01-01T00:00:00Z',
  problems: [{ id: 'cf4a', label: 'Watermelon', url: 'https://codeforces.com/problemset/problem/4/A', rating: 800, hint: '' }],
};
const settings: Settings = { clientId: 'example', language: 'cpp', theme: 'system', forkRepository: 'alice/problems' };
const auth: AuthState = { user: { login: 'alice', name: null, avatarUrl: '' }, configured: true, secureStorage: true };

function render(options: { empty?: boolean; noFork?: boolean; signedOut?: boolean; metadata?: string } = {}) {
  return renderToStaticMarkup(<BatchComposer
    day={options.empty ? undefined : day}
    problem={options.empty ? undefined : day.problems[0]}
    entries={[]}
    onEntriesChange={() => {}}
    notes=""
    onNotesChange={() => {}}
    requestId="test-request-id-1234"
    onResetRequestId={() => {}}
    settings={options.noFork ? { ...settings, forkRepository: undefined } : settings}
    auth={options.signedOut ? { ...auth, user: null } : auth}
    repository="upstream/problems"
    records={[]}
    statusIncomplete={false}
    onClose={() => {}}
    onLogin={() => {}}
    onSubmitted={() => {}}
    onSettingsSaved={() => {}}
    renderMetadata={() => <p>{options.metadata || ''}</p>}
  />);
}

afterEach(() => { setLocale('zh-CN'); });

describe('submission composer languages', () => {
  it('preserves Chinese controls and accessible names', () => {
    setLocale('zh-CN');
    const html = render();
    expect(html).toContain('aria-label="署名 CF4A · 2030-01-02 · 第 1 份"');
    expect(html).toContain('aria-label="扩展名 CF4A · 2030-01-02 · 第 1 份"');
    expect(html).toContain('<option value="c">C (.c)</option>');
    expect(html).toContain('填写署名后显示文件名');
    expect(html).toContain('加入提交列表');
    expect(html).toContain('选择代码文件');
    expect(html).toContain('列表中已有 0 个文件');
    expect(html).not.toContain('选择已有 PR');
    expect(html).not.toContain('添加题目日期');
    expect(html).not.toContain('请输入完整、有效的日期。');
    expect(html).not.toContain('正在读取…');
  });

  it('renders English controls, counts and accessible names without modifying repository metadata', () => {
    setLocale('en');
    const metadata = '仓库原文：保留此题名称 {{count}}';
    const html = render({ metadata });
    expect(html).toContain('aria-label="Author for CF4A · 2030-01-02 · Solution 1"');
    expect(html).toContain('aria-label="Programming language for CF4A · 2030-01-02 · Solution 1"');
    expect(html).toContain('aria-label="Extension for CF4A · 2030-01-02 · Solution 1"');
    expect(html).toContain('Other');
    expect(html).toContain('Add to submission list');
    expect(html).toContain('Enter an author to preview the filename');
    expect(html).toContain('Choose code file');
    expect(html).toContain('Files in list: 0');
    expect(html).toContain(metadata);
    expect(html.replace(metadata, '')).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('renders an empty PR composer in English with its zero counts and add controls', () => {
    setLocale('en');
    const html = render({ empty: true });
    expect(html).toContain('Problems: 0 · Solutions: 0 · Code files: 0');
    expect(html).toContain('Your submission list is empty');
    expect(html).toContain('The list stays when closed and is cleared when you exit the app.');
    expect(html).toContain('aria-label="Add more problems"');
    expect(html).toContain('aria-label="Date of the problem to add"');
    expect(html).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('only offers creating a new PR from the list, without an existing PR selector', () => {
    setLocale('en');
    const html = render({ empty: true });
    expect(html).toContain('All files in this list will be included in one new PR.');
    expect(html).toContain('Optional · Included in this PR description');
    expect(html).not.toContain('Select an existing PR');
    expect(html).not.toContain('Add to existing PR');
    expect(html).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('allows collecting files without a fork or GitHub sign-in', () => {
    setLocale('en');
    const html = render({ noFork: true, signedOut: true });
    expect(html).toContain('Add to submission list');
    expect(html).toContain('Choose code file');
    expect(html).not.toContain('Choose a fork');
    expect(html).not.toContain('Use this fork');
    expect(html).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
