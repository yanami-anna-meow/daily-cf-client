import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../shared/i18n';
import type { RemotePullRequest, Settings, SubmissionInput } from '../shared/types';
import { createDefaultPalettes } from '../shared/appearance';
import AppearanceSettings from '../src/components/AppearanceSettings';
import CodeDiff from '../src/components/CodeDiff';
import CodeHighlight from '../src/components/CodeHighlight';
import ContributionList from '../src/components/ContributionList';
import DeviceCode from '../src/components/DeviceCode';
import ForkSettings from '../src/components/ForkSettings';
import Markdown from '../src/components/Markdown';
import Modal from '../src/components/Modal';
import ProblemContributionStatus from '../src/components/ProblemContributionStatus';
import TemplateSettings from '../src/components/TemplateSettings';

vi.mock('../src/bridge', () => ({
  api: { isDesktop: true, copyText: vi.fn(), openExternal: vi.fn() },
}));

const settings: Settings = { clientId: '', language: 'cpp', theme: 'light' };
const input: SubmissionInput = {
  date: '2026-10-07', problemId: 'cf1234a', language: 'cpp', author: 'alice', code: '// 用户源代码\n', notes: '用户提交说明',
};
const record: RemotePullRequest = {
  id: 'pr-1', number: 1, title: '用户自定义的 PR 标题', url: 'https://github.com/example/problems/pull/1', state: 'merged',
  createdAt: '2026-10-07T01:00:00Z', updatedAt: '2026-10-08T02:00:00Z', filesTruncated: false,
  problems: [{ date: input.date, problemId: input.problemId, path: 'daily_problems/2026/10/1007/personal_submission/cf1234a_alice.txt' }],
  otherFiles: [{ path: '原始文件.md', status: 'modified' }],
};

describe('localized component chrome preserves user content', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale('zh-CN'));

  it('translates overwrite warnings and accessibility text without translating code', () => {
    const markup = renderToStaticMarkup(<CodeDiff previous="// 原始代码" next="// 提交代码" truncated />);
    expect(markup).toContain('Review code before overwriting');
    expect(markup).toContain('The existing file preview is incomplete.');
    expect(markup).toContain('Removed line:');
    expect(markup).toContain('Added line:');
    expect(markup).toContain('No newline at end of file');
    expect(markup).toContain('// 原始代码');
    expect(markup).toContain('// 提交代码');
    expect(markup).not.toContain('仓库现有');
  });

  it('keeps exact source and language identifiers when display language changes', () => {
    const code = 'const char* message = "中文代码内容";\r\n\t// 保留注释\n';
    const english = renderToStaticMarkup(<CodeHighlight language="cpp" code={code} />);
    setLocale('zh-CN');
    expect(renderToStaticMarkup(<CodeHighlight language="cpp" code={code} />)).toBe(english);
    expect(english).toContain('中文代码内容');
    expect(english).toContain('\r\n');
  });

  it('translates Markdown controls while retaining the repository document', () => {
    const markup = renderToStaticMarkup(<Markdown content={'仓库原始说明\n\n```cpp\n// 不翻译代码\n```\n\n- [x] 保留任务文字\n\n![原图说明](https://example.com/picture.png)'} />);
    expect(markup).toContain('Copy code');
    expect(markup).toContain('aria-label="Completed"');
    expect(markup).toContain('Image: 原图说明');
    expect(markup).toContain('仓库原始说明');
    expect(markup).toContain('不翻译代码');
    expect(markup).toContain('保留任务文字');
    expect(markup).not.toContain('复制代码');
  });

  it('localizes device login and modal accessibility labels without changing the code', () => {
    const markup = renderToStaticMarkup(<Modal title="GitHub" onClose={() => {}}><DeviceCode code="ABCD-1234" /></Modal>);
    expect(markup).toContain('aria-label="Close"');
    expect(markup).toContain('aria-label="GitHub device verification code"');
    expect(markup).toContain('Copy code');
    expect(markup).toContain('value="ABCD-1234"');
  });

  it('localizes contribution status, plain text language and dates without changing PR evidence', () => {
    const markup = renderToStaticMarkup(<ContributionList items={[record]} openExternal={() => {}} />);
    expect(markup).toContain('Pull request / problem');
    expect(markup).toContain('Merged');
    expect(markup).toContain('Modified');
    expect(markup).toContain('Text');
    expect(markup).toContain(new Date(record.createdAt).toLocaleString('en', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
    expect(markup).toContain(record.title);
    expect(markup).toContain(record.problems[0].path);
    expect(markup).toContain('原始文件.md');
    expect(markup).not.toContain('已合并');
  });

  it('keeps repeat submissions available with localized evidence and incomplete status', () => {
    const markup = renderToStaticMarkup(<ProblemContributionStatus problemId={input.problemId} records={[record]} incomplete warning onOpen={() => {}} />);
    expect(markup).toContain('PR merged');
    expect(markup).toContain('You can still submit it again.');
    expect(markup).toContain('Submission status is incomplete.');
    expect(markup).toContain('2026-10-07');
    expect(markup).not.toContain('disabled');
  });

  it('localizes fork selection while keeping repository identities exact', () => {
    const markup = renderToStaticMarkup(<ForkSettings repository="Yawn-Sean/Daily_CF_Problems" value="" auth={{ user: null, configured: true, secureStorage: true }} onChange={() => {}} />);
    expect(markup).toContain('Fork repository');
    expect(markup).toContain('Sign in to GitHub to select or create a fork.');
    expect(markup).toContain('Create fork');
    expect(markup).toContain('Yawn-Sean/Daily_CF_Problems');
    expect(markup).not.toContain('请选择');
  });

  it('localizes template controls and defaults but never translates custom template text or notes', () => {
    const props = { settings, input, login: 'alice-github', onChange: () => {} };
    const defaultMarkup = renderToStaticMarkup(<TemplateSettings {...props} />);
    expect(defaultMarkup).toContain('Pull request template');
    expect(defaultMarkup).toContain('Insert variable');
    expect(defaultMarkup).toContain('Live preview');
    expect(defaultMarkup).toContain('用户提交说明');
    expect(defaultMarkup).not.toContain('解题提交');
    const custom = { ...settings, prTitleTemplate: '{{date_compact}} 自定义标题', prBodyTemplate: '自定义描述：{{notes}}' };
    const customMarkup = renderToStaticMarkup(<TemplateSettings {...props} settings={custom} />);
    expect(customMarkup).toContain('自定义标题');
    expect(customMarkup).toContain('自定义描述：用户提交说明');
    expect(custom.prBodyTemplate).toBe('自定义描述：{{notes}}');
  });

  it('localizes appearance controls, errors and contrast guidance while preserving user names and color values', () => {
    const defaults = renderToStaticMarkup(<AppearanceSettings settings={settings} onChange={() => {}} />);
    for (const label of ['Pink', 'Green', 'Blue', 'Black &amp; white']) expect(defaults).toContain(label);
    const palettes = createDefaultPalettes();
    palettes[0].name = '用户方案 {{count}}';
    palettes[1].name = '外观';
    palettes[0].light = { primary: '#gg', accent: '#n0', background: '#aabbcc', surface: '#aabbcc', text: '#aabbcc' };
    const markup = renderToStaticMarkup(<AppearanceSettings settings={{ ...settings, palettes, paletteId: palettes[0].id }} onChange={() => {}} />);
    for (const label of [
      'Appearance', 'Interface language', 'Color scheme', 'Scheme name', 'Name this color scheme',
      'Display mode', 'Appearance theme', 'Edit light and dark colors', 'Light colors', 'Dark colors',
      'Button background', 'Accent color', 'Links, action labels, and selected states', 'Page background', 'Card background', 'Body text', 'Add scheme', 'Delete scheme', 'Restore default schemes',
      'Create a new scheme from the current colors',
      'Color preview', 'Color picker: Button background', 'Color picker: Accent color', 'Enter a color in #RGB or #RRGGBB format.',
      'Body text has a contrast ratio of 1.00:1', 'Changes take effect after saving.',
    ]) expect(markup).toContain(label);
    expect(markup).toContain('value="#gg"');
    expect(markup).toContain('value="#n0"');
    expect(markup).toContain('value="#aabbcc"');
    expect(markup).toContain('用户方案 {{count}}');
    expect(markup).toContain('title="外观"');
    expect(markup.replaceAll('简体中文', '').replaceAll('用户方案 {{count}}', '').replaceAll('外观', '')).not.toMatch(/[\p{Script=Han}]/u);
    expect(palettes[0].light).toEqual({ primary: '#gg', accent: '#n0', background: '#aabbcc', surface: '#aabbcc', text: '#aabbcc' });

    setLocale('zh-CN');
    const chinese = renderToStaticMarkup(<AppearanceSettings settings={{ ...settings, palettes, paletteId: palettes[0].id }} onChange={() => {}} />);
    for (const label of ['外观', '配色方案', '方案名称', '编辑明暗配色', '浅色配色', '深色配色', '按钮底色选色器', '强调色选色器', '链接、操作文字和选中状态', '添加方案', '删除方案', '恢复默认方案集', '请输入 #RGB 或 #RRGGBB 格式的颜色。', '对比度为 1.00:1', '用户方案 {{count}}']) expect(chinese).toContain(label);
    expect(chinese).toContain('value="#gg"');
    expect(chinese).toContain('value="#n0"');
    expect(chinese).toContain('value="#aabbcc"');
    expect(chinese).not.toContain('Button background');
  });

  it('returns to Chinese on the next render without translating content already supplied by the caller', () => {
    const render = () => renderToStaticMarkup(<Modal title="用户标题" onClose={() => {}}><DeviceCode code="ABCD-1234" /></Modal>);
    expect(render()).toContain('Copy code');
    setLocale('zh-CN');
    const chinese = render();
    expect(chinese).toContain('复制验证码');
    expect(chinese).toContain('aria-label="关闭"');
    expect(chinese).toContain('用户标题');
    expect(chinese).toContain('ABCD-1234');
  });
});

