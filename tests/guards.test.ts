import { describe, expect, it } from 'vitest';
import { batchSubmissionInput, safeExternal, settingsInput, text } from '../electron/guards';
import type { Settings, SubmissionInput } from '../shared/types';
import { submissionPath } from '../shared/domain';
import { createDefaultPalettes, resolveAccentColor } from '../shared/appearance';

const PALETTES = createDefaultPalettes();
const SETTINGS: Settings = { clientId: 'Ov23li_example', language: 'cpp', uiLanguage: 'system', theme: 'system', palettes: PALETTES, paletteId: PALETTES[0].id };

describe('external URL IPC boundary', () => {
  it.each([
    'https://github.com/Yawn-Sean/Daily_CF_Problems/pull/123',
    'https://github.com/login/device',
    'https://docs.github.com/en/apps/oauth-apps',
    'https://codeforces.com/problemset/problem/1185/D',
    'https://www.codeforces.com/contest/1185/problem/D',
    'https://codeforces.com/gym/102307/problem/K',
    'https://espresso.codeforces.com/example/diagram.png',
    'https://yawn-sean.github.io/',
    'https://WWW.Codeforces.com/contest/1185/problem/D?locale=en&from=archive#statement',
    'http://codeforces.com/gym/102307/problem/K?locale=ru#sample',
    'HTTP://WWW.Codeforces.com/problemset/problem/4/A?x=%2f%2F#Input',
  ])('preserves an explicitly supported resource exactly: %s', url => {
    expect(safeExternal(url)).toBe(url);
  });

  it.each([
    'javascript:alert(1)', 'file:///C:/Windows/system32/cmd.exe', 'data:text/html,<script>alert(1)</script>',
    'http://github.com/login/device', 'https://github.com.evil.test/login', 'https://evilgithub.com/',
    'https://github.com@evil.test/', 'https://evil.test@github.com/', 'https://user:secret@github.com/',
    'https://github.com:444/', 'https://api.github.com/', 'https://raw.githubusercontent.com/',
    'https://localhost/', 'https://127.0.0.1/', '//github.com/login/device',
    'https://github.com%2fevil.test/', 'https://github.com./', '',
    'https://codeforces.com.evil.test/problemset/problem/4/A', 'http://www.codeforces.com.evil.test/gym/102307/problem/K',
    'https://espresso.codeforces.com.evil.invalid/a.png', 'https://other.codeforces.com/a.png',
    'http://espresso.codeforces.com/a.png', 'http://docs.github.com/', 'http://yawn-sean.github.io/',
    'http://user:secret@codeforces.com/gym/102307/problem/K', 'http://codeforces.com:8080/gym/102307/problem/K',
    ' https://codeforces.com/problemset/problem/4/A', 'https://codeforces.com/problemset/problem/4/A\n',
    'https://codeforces.com\\problemset\\problem\\4\\A',
  ])('rejects an unsafe or unsupported external URL: %s', url => {
    expect(() => safeExternal(url)).toThrow();
  });

  it.each([undefined, null, 123, {}, ['https://github.com/'], 'https://github.com/' + 'x'.repeat(2048)])('rejects malformed IPC link values', value => {
    expect(() => safeExternal(value)).toThrow();
  });
});

describe('settings IPC boundary', () => {
  it('seeds a missing palette list while retaining the existing brightness preference', () => {
    for (const theme of ['light', 'dark', 'system'] as const) {
      expect(settingsInput({ ...SETTINGS, theme, palettes: undefined, paletteId: undefined })).toEqual({ ...SETTINGS, theme });
    }
  });

  it('accepts any valid palette ID and does not require a seeded palette', () => {
    const palettes = [{ ...PALETTES[0], id: 'my-ocean_2026', name: '海洋' }];
    for (const theme of ['light', 'dark', 'system'] as const) {
      expect(settingsInput({ ...SETTINGS, theme, palettes, paletteId: palettes[0].id })).toEqual({ ...SETTINGS, theme, palettes, paletteId: palettes[0].id });
    }
  });

  it.each([null, '', 0, true, {}, [], new Array(1)].map(palettes => ({ palettes })))('rejects malformed or empty lists: $palettes', ({ palettes }) => {
    expect(() => settingsInput({ ...SETTINGS, palettes })).toThrow('配色方案');
  });

  it('rejects a bad item instead of silently dropping it from a saved list', () => {
    expect(() => settingsInput({ ...SETTINGS, palettes: [PALETTES[0], null] })).toThrow('配色方案');
    const sparse = [PALETTES[0], , PALETTES[1]];
    expect(() => settingsInput({ ...SETTINGS, palettes: sparse })).toThrow('配色方案');
  });

  it('normalizes palette names and colors and whitelists supported fields', () => {
    const palette = {
      id: 'personal-01', name: '  我的配色  ', token: 'discard',
      light: { primary: '#ABC', accent: '#A1B', background: '#FaFaFa', surface: '#FFF', text: '#123', token: 'discard' },
      dark: { primary: '#AABBCC', accent: '#AbCdEf', background: '#000', surface: '#123456', text: '#FFE', code: 'discard' },
      system: { primary: '#fff' },
    };
    expect(settingsInput({ ...SETTINGS, palettes: [palette], paletteId: palette.id })).toEqual({
      ...SETTINGS, paletteId: palette.id, palettes: [{ id: palette.id, name: '我的配色',
        light: { primary: '#aabbcc', accent: '#aa11bb', background: '#fafafa', surface: '#ffffff', text: '#112233' },
        dark: { primary: '#aabbcc', accent: '#abcdef', background: '#000000', surface: '#123456', text: '#ffffee' },
      }],
    });
    expect(palette.light.primary).toBe('#ABC');
    expect(palette.name).toBe('  我的配色  ');
  });

  it('fills legacy accent colors without changing identity, selection, names or original colors', () => {
    const palette = {
      id: 'renamed-and-recolored', name: 'My palette',
      light: { primary: '#abcdef', background: '#fefefe', surface: '#ffffff', text: '#123456' },
      dark: { primary: '#c3d4e5', background: '#121212', surface: '#234567', text: '#efefef' },
    };
    const original = structuredClone(palette);
    const saved = settingsInput({ ...SETTINGS, palettes: [palette], paletteId: palette.id });
    expect(saved).toEqual({ ...SETTINGS, paletteId: palette.id, palettes: [{ ...palette,
      light: { ...palette.light, accent: resolveAccentColor(palette.light) },
      dark: { ...palette.dark, accent: resolveAccentColor(palette.dark) },
    }] });
    expect(palette).toEqual(original);
    const recolored = { ...saved.palettes![0], light: { ...saved.palettes![0].light, primary: '#fedcba' } };
    expect(settingsInput({ ...saved, palettes: [recolored] }).palettes![0].light.accent).toBe(saved.palettes![0].light.accent);
  });

  it('rejects an explicitly invalid accent instead of treating it as a missing legacy field', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const accent of [null, '', 12, {}, [], '#12', '#abcd', '#12345678', '#ggg', 'red', 'var(--accent)', 'url(https://example.test/color)']) {
        const palette = { ...PALETTES[0], [theme]: { ...PALETTES[0][theme], accent } };
        expect(() => settingsInput({ ...SETTINGS, palettes: [palette] }), `${theme}.accent: ${String(accent)}`).toThrow('配色方案颜色');
      }
    }
  });

  it('accepts the palette count, ID and name boundaries', () => {
    const palettes = Array.from({ length: 100 }, (_, index) => ({ ...PALETTES[0], id: index ? `palette-${index}` : 'x'.repeat(128), name: '名'.repeat(80) }));
    expect(settingsInput({ ...SETTINGS, palettes, paletteId: palettes[0].id }).palettes).toEqual(palettes);
    expect(() => settingsInput({ ...SETTINGS, palettes: [...palettes, { ...PALETTES[0], id: 'overflow' }], paletteId: palettes[0].id })).toThrow('1 至 100');
  });

  it.each([undefined, null, '', 'contains space', 'a'.repeat(129), 'name\n', '" onload="x', '#accent', {}].map(id => ({ id })))('rejects invalid palette IDs: $id', ({ id }) => {
    expect(() => settingsInput({ ...SETTINGS, palettes: [{ ...PALETTES[0], id }] })).toThrow('配色方案编号');
  });

  it.each([undefined, null, '', '   ', '名'.repeat(81), {}].map(name => ({ name })))('rejects empty or oversized palette names: $name', ({ name }) => {
    expect(() => settingsInput({ ...SETTINGS, palettes: [{ ...PALETTES[0], name }] })).toThrow('配色方案名称');
  });

  it('requires unique IDs and an existing selected palette', () => {
    expect(() => settingsInput({ ...SETTINGS, palettes: [PALETTES[0], { ...PALETTES[0], name: 'Duplicate' }] })).toThrow('编号不能重复');
    for (const paletteId of ['missing', '', null, 42, {}]) {
      expect(() => settingsInput({ ...SETTINGS, paletteId })).toThrow('请选择列表');
    }
    const palettes = [{ ...PALETTES[0], id: 'only-saved' }];
    expect(settingsInput({ ...SETTINGS, palettes, paletteId: undefined }).paletteId).toBe('only-saved');
  });

  it('requires every color in both brightness variants to be a valid hex string', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const key of ['primary', 'background', 'surface', 'text'] as const) {
        for (const color of [undefined, null, 12, {}, '#12', '#abcd', '#12345678', '#ggg', 'red', 'var(--accent)', 'url(https://example.test/color)']) {
          const palette = { ...PALETTES[0], [theme]: { ...PALETTES[0][theme], [key]: color } };
          expect(() => settingsInput({ ...SETTINGS, palettes: [palette] }), `${theme}.${key}: ${String(color)}`).toThrow('配色方案颜色');
        }
      }
    }
  });

  it('normalizes permitted fields and drops unrecognized fields', () => {
    expect(settingsInput({ ...SETTINGS, clientId: '  Ov23li_example  ', author: '  user_name  ', token: 'secret', directory: '../../' }))
      .toEqual(SETTINGS);
  });

  it('allows an unconfigured Client ID for read-only use without a default author', () => {
    expect(settingsInput({ ...SETTINGS, clientId: '' })).toEqual({ ...SETTINGS, clientId: '' });
  });

  it.each(['previous_author', '../old-unsupported-value', null, { name: 'legacy' }])('drops obsolete author settings instead of exposing a local identity', author => {
    expect(settingsInput({ ...SETTINGS, author })).toEqual(SETTINGS);
  });

  it('preserves the shared pull request templates and ignores removed batch templates', () => {
    const templates = {
      prTitleTemplate: 'Solutions {{count}}', prBodyTemplate: '{{files}}\n\n{{notes}}',
    };
    expect(settingsInput({ ...SETTINGS, ...templates, batchPrTitleTemplate: 'removed', batchPrBodyTemplate: 'removed', unexpected: 'ignored' }))
      .toEqual({ ...SETTINGS, ...templates });
    expect(settingsInput({ ...SETTINGS, prTitleTemplate: '', prBodyTemplate: '' }))
      .toEqual({ ...SETTINGS, prTitleTemplate: '', prBodyTemplate: '' });
  });

  it.each([
    { prTitleTemplate: 'x'.repeat(2001) }, { prBodyTemplate: 'x'.repeat(60001) },
    { prTitleTemplate: null }, { prBodyTemplate: ['text'] },
  ])('rejects invalid shared template settings', invalid => {
    expect(() => settingsInput({ ...SETTINGS, ...invalid })).toThrow('PR');
  });

  it.each([
    null, [], {}, { ...SETTINGS, clientId: 'secret&scope=repo' }, { ...SETTINGS, clientId: 'x'.repeat(121) },
    { ...SETTINGS, language: 'sh' }, { ...SETTINGS, theme: 'custom' }, { ...SETTINGS, language: null },
  ])('rejects malformed settings before persistence', value => {
    expect(() => settingsInput(value)).toThrow();
  });
});

describe('batch submission IPC boundary', () => {
  const requestId = 'submission-request-123456';
  const item = (overrides: Partial<SubmissionInput> = {}): SubmissionInput => ({
    date: '2024-03-18', problemId: 'cf1185d', language: 'cpp', author: 'sample',
    code: 'int main() {}\n', notes: '', ...overrides,
  });

  it('normalizes each solution before preview and preserves only allowed fields', () => {
    const source = { requestId, items: [{ ...item({ problemId: ' CF1185D ', code: '\uFEFFint main() {}\r\n', author: ' sample ', notes: ' item note ' }), filename: '../../other.cpp' }], notes: ' shared note ', token: 'secret' };
    expect(batchSubmissionInput(source)).toEqual({ items: [item({ extension: 'cpp', notes: 'item note' })], notes: 'shared note', requestId });
    expect(source.items[0].code).toContain('\r\n');
  });

  it('preserves a new PR target and nonce while dropping unknown nested and top-level fields', () => {
    const requestId = '123e4567-e89b-12d3-a456-426614174000';
    const source = { items: [item()], notes: ' PR description ', target: { kind: 'new', number: 123, expectedHeadSha: 'ignored invalid version', repository: 'evil/repo' }, requestId, branch: 'unexpected' };
    expect(batchSubmissionInput(source)).toEqual({ items: [item({ extension: 'cpp' })], notes: 'PR description', target: { kind: 'new' }, requestId });
  });

  it('allows an omitted target with a required request ID without inventing a target', () => {
    const parsed = batchSubmissionInput({ items: [item()], notes: '', requestId });
    expect(parsed).toEqual({ items: [item({ extension: 'cpp' })], notes: '', requestId });
    expect(parsed).not.toHaveProperty('target');
    expect(parsed).not.toHaveProperty('overwrites');
  });

  it('rejects even a fully formed existing PR target before dispatch', () => {
    expect(() => batchSubmissionInput({ items: [item()], notes: '', requestId, target: {
      kind: 'existing', number: 42, expectedHeadSha: 'a'.repeat(40),
    } })).toThrow();
  });

  it('requires a request ID even when the caller omits the target', () => {
    expect(() => batchSubmissionInput({ items: [item()], notes: '' })).toThrow('提交请求编号');
  });

  it.each([40, 64])('preserves a confirmed overwrite only for its canonical path and %i-character lowercase hash', length => {
    const path = submissionPath(item());
    const sha = 'Af09'.repeat(length / 4);
    const input = { requestId, items: [item()], notes: '', target: { kind: 'new' }, overwrites: [{ path, sha, code: 'unknown field', accepted: true }] };
    expect(batchSubmissionInput(input).overwrites).toEqual([{ path, sha: sha.toLowerCase() }]);
  });

  it('accepts an empty overwrite list and preserves confirmations without inventing a target', () => {
    expect(batchSubmissionInput({ requestId, items: [item()], notes: '', overwrites: [] }).overwrites).toEqual([]);
    const overwrites = [{ path: submissionPath(item()), sha: 'a'.repeat(40) }];
    const parsed = batchSubmissionInput({ requestId, items: [item()], notes: '', overwrites });
    expect(parsed.overwrites).toEqual(overwrites);
    expect(parsed).not.toHaveProperty('target');
  });

  it('rejects duplicate overwrite acknowledgments even when their hashes agree', () => {
    const entry = { path: submissionPath(item()), sha: 'a'.repeat(40) };
    expect(() => batchSubmissionInput({ requestId, items: [item()], notes: '', overwrites: [entry, entry] })).toThrow('重复文件路径');
  });

  it.each([
    '../outside.cpp', 'daily_problems/2024/03/0318/personal_submission/cf1185d_other.cpp',
    'daily_problems/2024/03/0318/personal_submission/CF1185D_sample.cpp',
    './daily_problems/2024/03/0318/personal_submission/cf1185d_sample.cpp',
    'daily_problems\\2024\\03\\0318\\personal_submission\\cf1185d_sample.cpp',
  ])('rejects unrelated or noncanonical overwrite paths', path => {
    expect(() => batchSubmissionInput({ requestId, items: [item()], notes: '', overwrites: [{ path, sha: 'a'.repeat(40) }] }))
      .toThrow('本次提交的规范文件路径');
  });

  it.each([null, {}, 'all', [null], [[]], [{}], new Array(1)])('rejects malformed overwrite acknowledgments', overwrites => {
    expect(() => batchSubmissionInput({ requestId, items: [item()], notes: '', overwrites })).toThrow('覆盖确认');
  });

  it.each([null, '', 123, 'a'.repeat(39), 'g'.repeat(40), 'a'.repeat(65)])('rejects invalid overwrite hashes', sha => {
    expect(() => batchSubmissionInput({ requestId, items: [item()], notes: '', overwrites: [{ path: submissionPath(item()), sha }] }))
      .toThrow('覆盖确认的文件版本无效');
  });

  it('bounds overwrite confirmations to the batch size limit', () => {
    const items = Array.from({ length: 50 }, (_, index) => item({ problemId: `cf${1000 + index}a` }));
    const overwrites = items.map(value => ({ path: submissionPath(value), sha: 'a'.repeat(40) }));
    expect(batchSubmissionInput({ requestId, items, notes: '', overwrites }).overwrites).toHaveLength(50);
    expect(() => batchSubmissionInput({ requestId, items, notes: '', overwrites: [...overwrites, overwrites[0]] })).toThrow('超过 50');
  });

  it.each([
    null, [], 'new', {}, { kind: 'NEW' }, { kind: 'existing' }, { kind: 'other', number: 1 },
    { kind: 'existing', number: '42' }, { kind: 'existing', number: 0 }, { kind: 'existing', number: -1 },
    { kind: 'existing', number: 1.5 }, { kind: 'existing', number: Number.MAX_SAFE_INTEGER + 1 },
    { kind: 'existing', number: Infinity }, { kind: 'existing', number: NaN },
  ])('rejects malformed targets instead of selecting a different PR', target => {
    expect(() => batchSubmissionInput({ requestId, items: [item()], notes: '', target })).toThrow();
  });

  it.each([
    undefined, null, 123, '', 'x'.repeat(15), 'x'.repeat(81), ' abcdefghijklmnop',
    'abcdefghijklmnop ', '../abcdefghijklmnop', 'abcdefghijklmnop\n', 'abcdefghijklmnop汉',
  ])('rejects unsafe or ambiguous request nonces', requestId => {
    expect(() => batchSubmissionInput({ items: [item()], notes: '', requestId })).toThrow('提交请求编号');
  });

  it.each(['a'.repeat(16), 'Z'.repeat(80), 'nonce_WITH-123456'])('accepts safe nonce boundaries', requestId => {
    expect(batchSubmissionInput({ items: [item()], notes: '', requestId }).requestId).toBe(requestId);
  });

  it('allows different language paths for the same date and problem', () => {
    const items = [item(), item({ language: 'py', code: 'print(1)' })];
    expect(batchSubmissionInput({ requestId, items, notes: '' }).items).toHaveLength(2);
  });

  it('normalizes the language from the actual extension and keeps C beside C++ for one signature', () => {
    const items = [item({ language: 'py', extension: '.c' }), item({ language: 'other', extension: 'cpp' })];
    const parsed = batchSubmissionInput({ requestId, items, notes: '' });
    expect(parsed.items.map(({ extension, language }) => ({ extension, language }))).toEqual([
      { extension: 'c', language: 'c' }, { extension: 'cpp', language: 'cpp' },
    ]);
    expect(parsed.items.map(submissionPath)).toEqual([
      'daily_problems/2024/03/0318/personal_submission/cf1185d_sample.c',
      'daily_problems/2024/03/0318/personal_submission/cf1185d_sample.cpp',
    ]);
  });

  it('rejects duplicate actual paths even when the requested languages differ', () => {
    const items = [item({ language: 'cpp', extension: '.custom.part' }), item({ language: 'py', extension: 'custom.part' })];
    expect(() => batchSubmissionInput({ requestId, items, notes: '' })).toThrow('文件路径重复');
  });

  it('keeps a free-form extension and accepts overwrite consent only for that exact path', () => {
    const source = item({ language: 'cpp', extension: 'custom+part.ext' });
    const path = 'daily_problems/2024/03/0318/personal_submission/cf1185d_sample.custom+part.ext';
    const parsed = batchSubmissionInput({ requestId, items: [source], notes: '', overwrites: [{ path, sha: 'a'.repeat(40) }] });
    expect(parsed.items[0]).toMatchObject({ extension: 'custom+part.ext', language: 'other' });
    expect(parsed.overwrites).toEqual([{ path, sha: 'a'.repeat(40) }]);
    expect(() => batchSubmissionInput({ requestId, items: [source], notes: '', overwrites: [{ path: submissionPath(item()), sha: 'a'.repeat(40) }] }))
      .toThrow('本次提交的规范文件路径');
  });

  it('rejects duplicate canonical repository paths even when input spellings differ', () => {
    expect(() => batchSubmissionInput({ requestId, items: [item(), item({ problemId: 'CF1185D', author: ' sample ' })], notes: '' }))
      .toThrow('文件路径重复');
  });

  it('allows the maximum item count while rejecting a fifty-first solution', () => {
    const items = Array.from({ length: 50 }, (_, index) => item({ problemId: `cf${1000 + index}a` }));
    expect(batchSubmissionInput({ requestId, items, notes: '' }).items).toHaveLength(50);
    expect(() => batchSubmissionInput({ requestId, items: [...items, item({ problemId: 'cf9999a' })], notes: '' })).toThrow('1 至 50');
  });

  it.each([
    null, [], {}, { items: [], notes: '' }, { items: 'not an array', notes: '' },
    { items: [null], notes: '' }, { items: [{}], notes: '' }, { items: new Array(1), notes: '' },
    { items: [item()], notes: null }, { items: [item()] },
  ])('rejects empty or malformed batches without dispatching a submission', value => {
    expect(() => batchSubmissionInput(value)).toThrow();
  });

  it.each([
    { date: '2024-02-30' }, { problemId: '../../file' }, { author: '../author' },
    { code: '' }, { code: '  \n ' }, { code: 'code\0data' }, { notes: 'x'.repeat(2001) },
  ])('uses normal per-solution validation and identifies the invalid item', invalid => {
    expect(() => batchSubmissionInput({ requestId, items: [item(), item({ ...invalid, language: 'py' })], notes: '' })).toThrow('第 2 份解答');
  });

  it('applies the 256 KiB per-file cap to normalized UTF-8 bytes', () => {
    const exactly256KiB = '汉'.repeat(87_381) + '\n';
    expect(new TextEncoder().encode(exactly256KiB).byteLength).toBe(256 * 1024);
    expect(batchSubmissionInput({ requestId, items: [item({ code: exactly256KiB })], notes: '' }).items[0].code).toBe(exactly256KiB);
    expect(() => batchSubmissionInput({ requestId, items: [item({ code: exactly256KiB + 'a' })], notes: '' })).toThrow('256 KiB');
  });

  it('accepts exactly 5 MiB and rejects a larger aggregate even when each file is valid', () => {
    const code = '汉'.repeat(87_381) + '\n';
    const items = Array.from({ length: 20 }, (_, index) => item({ problemId: `cf${1000 + index}a`, code }));
    expect(batchSubmissionInput({ requestId, items, notes: '' }).items).toHaveLength(20);
    expect(() => batchSubmissionInput({ requestId, items: [...items, item({ problemId: 'cf9999a', code: 'a' })], notes: '' })).toThrow('5 MiB');
  });

  it('bounds shared notes independently of each solution notes', () => {
    expect(batchSubmissionInput({ requestId, items: [item()], notes: 'x'.repeat(2000) }).notes).toHaveLength(2000);
    expect(() => batchSubmissionInput({ requestId, items: [item()], notes: 'x'.repeat(2001) })).toThrow('批量提交说明');
  });
});

describe('generic IPC text boundary', () => {
  it('applies length limits before accepting generic IPC strings', () => {
    expect(text('abc', '字段', 3)).toBe('abc');
    expect(() => text('abcd', '字段', 3)).toThrow('字段');
    expect(() => text(123, '字段')).toThrow('字段');
  });
});
