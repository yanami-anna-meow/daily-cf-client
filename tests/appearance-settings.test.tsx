import { isValidElement, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPalettes, getSelectedPalette, resolveAccentColor } from '../shared/appearance';
import { setLocale } from '../shared/i18n';
import type { ColorPalette, Settings } from '../shared/types';
import AppearanceSettings from '../src/components/AppearanceSettings';
import { api } from '../src/bridge';

vi.mock('../src/bridge', () => ({ api: { saveSettings: vi.fn() } }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: vi.fn(),
  useEffect: vi.fn(),
  useId: () => 'appearance-test',
}));

type ControlProps = Record<string, unknown> & {
  children?: ReactNode;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
};
type Control = ReactElement<ControlProps>;

function controls(node: ReactNode): Control[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!isValidElement<ControlProps>(node)) return [];
  if (typeof node.type === 'function') return controls((node.type as (props: ControlProps) => ReactNode)(node.props));
  return [node, ...controls(node.props.children)];
}

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return isValidElement<ControlProps>(node) ? text(node.props.children) : '';
}

// The project uses node-only component tests. Keep hook state and effects here so
// native handlers and media subscriptions can run without a DOM dependency.
function editor(overrides: Partial<Settings> = {}) {
  let draft: Settings = { clientId: 'existing-client', language: 'cpp', theme: 'light', ...overrides };
  let cursor = 0;
  let effectCursor = 0;
  const states: unknown[] = [];
  const effects: { dependencies?: readonly unknown[]; cleanup?: () => void }[] = [];
  let pendingEffects: (() => void)[] = [];
  vi.mocked(useState).mockImplementation(((initial: unknown) => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], (next: unknown) => {
      states[index] = typeof next === 'function' ? next(states[index]) : next;
    }];
  }) as typeof useState);
  vi.mocked(useEffect).mockImplementation((effect, dependencies) => {
    const index = effectCursor++;
    const previous = effects[index];
    if (!previous || !dependencies || !previous.dependencies || dependencies.length !== previous.dependencies.length || dependencies.some((value, position) => !Object.is(value, previous.dependencies![position]))) {
      pendingEffects.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        effects[index] = { dependencies, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      });
    }
  });
  const onChange = vi.fn((patch: Partial<Settings>) => { draft = { ...draft, ...patch }; });
  const all = () => {
    cursor = 0;
    effectCursor = 0;
    const result = controls(AppearanceSettings({ settings: draft, onChange }));
    const scheduled = pendingEffects;
    pendingEffects = [];
    scheduled.forEach(effect => effect());
    return result;
  };
  const find = (type: string, properties: Record<string, unknown> = {}) => {
    const found = all().find(node => node.type === type && Object.entries(properties).every(([key, value]) => node.props[key] === value));
    if (!found) throw new Error(`Missing ${type}: ${JSON.stringify(properties)}`);
    return found;
  };
  const button = (label: string) => {
    const found = all().find(node => node.type === 'button' && text(node) === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  const field = (label: string) => find('input', { id: find('label', { children: label }).props.htmlFor });
  const select = (label: string) => {
    const wrapper = all().find(node => node.type === 'label' && controls(node.props.children).some(child => child.type === 'span' && text(child) === label));
    const found = wrapper && controls(wrapper.props.children).find(node => node.type === 'select');
    if (!found) throw new Error(`Missing select: ${label}`);
    return found;
  };
  return { all, find, button, field, select, onChange, dispose: () => effects.forEach(effect => effect.cleanup?.()), settings: () => draft, selected: () => getSelectedPalette(draft), nameField: () => find('input', { placeholder: '为配色方案命名' }) };
}

beforeEach(() => { setLocale('zh-CN'); vi.clearAllMocks(); });
afterEach(() => { setLocale('zh-CN'); vi.unstubAllGlobals(); });

describe('appearance settings controls', () => {
  it('starts settings without a saved palette with green and four editable palettes', () => {
    const view = editor();
    expect(view.find('button', { 'data-palette-id': 'green' }).props['aria-pressed']).toBe(true);
    expect(view.all().filter(node => node.type === 'button' && node.props['data-palette-id'])).toHaveLength(4);
    expect(view.find('div', { 'aria-label': '配色方案' }).props.role).toBe('group');
    expect(view.find('div', { 'aria-label': '外观主题' }).props.role).toBe('group');
    expect(view.select('界面语言').props.value).toBe('system');
    expect(view.nameField().props.value).toBe('绿色');
    expect(view.field('按钮底色').props.value).toBe(createDefaultPalettes()[0].light.primary);
    for (const button of view.all().filter(node => node.type === 'button')) expect(button.props.type).toBe('button');
    expect(view.onChange).not.toHaveBeenCalled();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('can switch from default green to pink with the requested accent and pale button background', () => {
    const view = editor();
    const originalGreen = structuredClone(view.selected());
    view.find('button', { 'data-palette-id': 'pink' }).props.onClick!();
    expect(view.onChange).toHaveBeenLastCalledWith({ paletteId: 'pink' });
    expect(view.find('button', { 'data-palette-id': 'pink' }).props['aria-pressed']).toBe(true);
    expect(view.nameField().props.value).toBe('粉色');
    expect(view.field('强调色').props.value).toBe('#fb7299');
    expect(view.field('按钮底色').props.value).toBe('#f8bed0');
    expect(view.find('div', { 'aria-label': '配色预览' }).props.style).toMatchObject({ '--accent': '#fb7299', '--primary-bg': '#f8bed0' });
    view.find('button', { 'data-palette-id': 'green' }).props.onClick!();
    expect(view.selected()).toEqual(originalGreen);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('selects arbitrary saved palettes and display modes through independent draft patches', () => {
    const palettes: ColorPalette[] = createDefaultPalettes().map((palette, index) => ({ ...palette, id: 'user-' + index, name: '用户方案 ' + index }));
    const view = editor({ palettes, paletteId: palettes[0].id });
    for (const palette of palettes) {
      view.find('button', { 'data-palette-id': palette.id }).props.onClick!();
      expect(view.onChange).toHaveBeenLastCalledWith({ paletteId: palette.id });
      expect(view.all().filter(node => node.type === 'button' && node.props['data-palette-id'] && node.props['aria-pressed']).map(node => node.props['data-palette-id'])).toEqual([palette.id]);
      expect(view.nameField().props.value).toBe(palette.name);
      expect(view.settings().theme).toBe('light');
    }
    for (const [theme, label] of [['dark', '深色'], ['system', '跟随系统'], ['light', '浅色']] as const) {
      view.button(label).props.onClick!();
      expect(view.onChange).toHaveBeenLastCalledWith({ theme });
      expect(view.button(label).props['aria-pressed']).toBe(true);
      expect(view.settings().paletteId).toBe(palettes.at(-1)!.id);
    }
    view.select('界面语言').props.onChange!({ target: { value: 'en' } });
    expect(view.onChange).toHaveBeenLastCalledWith({ uiLanguage: 'en' });
    expect(view.settings()).toMatchObject({ clientId: 'existing-client', language: 'cpp', theme: 'light', palettes, uiLanguage: 'en' });
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it.each(['light', 'dark', 'system'] as const)('opens %s mode with five labeled fields and a matching preview', theme => {
    const view = editor({ theme });
    const mode = theme === 'dark' ? 'dark' : 'light';
    const colors = createDefaultPalettes()[0][mode];
    for (const [label, key] of [['按钮底色', 'primary'], ['页面背景', 'background'], ['卡片背景', 'surface'], ['正文文字', 'text']] as const) expect(view.field(label).props.value).toBe(colors[key]);
    expect(view.field('强调色').props.value).toBe(colors.accent ?? resolveAccentColor(colors));
    const descriptionId = view.field('强调色').props['aria-describedby'];
    expect(text(view.find('small', { id: descriptionId }))).toBe('链接、操作文字和选中状态');
    expect(view.find('input', { type: 'color', 'aria-label': '强调色选色器' }).props['aria-describedby']).toBe(descriptionId);
    expect(view.find('div', { 'aria-label': '编辑明暗配色' }).props.role).toBe('group');
    expect(view.button(mode === 'dark' ? '深色配色' : '浅色配色').props['aria-pressed']).toBe(true);
    expect(view.all().filter(node => node.type === 'input' && node.props.type === 'color').map(node => node.props['aria-label'])).toEqual(['按钮底色选色器', '强调色选色器', '页面背景选色器', '卡片背景选色器', '正文文字选色器']);
    expect(view.find('div', { 'aria-label': '配色预览' }).props.style).toMatchObject({ '--bg': colors.background, '--text': colors.text });
    expect(view.onChange).not.toHaveBeenCalled();
  });

  it('shows resolved accent colors for legacy palettes without adding settings fields or saving', () => {
    const palettes = createDefaultPalettes();
    delete palettes[0].light.accent;
    delete palettes[0].dark.accent;
    const original = structuredClone(palettes);
    const view = editor({ palettes, paletteId: palettes[0].id });
    for (const [mode, label] of [['light', '浅色配色'], ['dark', '深色配色']] as const) {
      view.button(label).props.onClick!();
      const expected = resolveAccentColor(palettes[0][mode]);
      expect(view.field('强调色').props.value).toBe(expected);
      expect(view.field('强调色').props['aria-invalid']).toBe(false);
      expect(view.find('input', { type: 'color', 'aria-label': '强调色选色器' }).props.value).toBe(expected);
      expect(view.find('div', { 'aria-label': '配色预览' }).props.style).toMatchObject({ '--accent': expected });
    }
    expect(view.settings().palettes).toEqual(original);
    expect(view.onChange).not.toHaveBeenCalled();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('edits accent separately from button backgrounds and keeps light and dark accents independent', () => {
    const palettes = createDefaultPalettes();
    const original = structuredClone(palettes);
    const view = editor({ palettes, paletteId: palettes[0].id });
    view.field('强调色').props.onChange!({ target: { value: '#234567' } });
    expect(view.selected().light).toEqual({ ...original[0].light, accent: '#234567' });
    expect(view.selected().dark).toEqual(original[0].dark);
    expect(view.field('按钮底色').props.value).toBe(original[0].light.primary);
    expect(view.find('button', { 'data-palette-id': palettes[0].id }).props.style).toMatchObject({ '--preview-accent': '#234567' });
    expect(view.find('div', { 'aria-label': '配色预览' }).props.style).toMatchObject({ '--primary-bg': original[0].light.primary, '--accent': '#234567' });
    view.button('深色配色').props.onClick!();
    view.find('input', { type: 'color', 'aria-label': '强调色选色器' }).props.onChange!({ target: { value: '#aabbcc' } });
    expect(view.selected().dark).toEqual({ ...original[0].dark, accent: '#aabbcc' });
    expect(view.selected().light.accent).toBe('#234567');
    view.field('按钮底色').props.onChange!({ target: { value: '#fedcba' } });
    expect(view.selected().dark.accent).toBe('#aabbcc');
    expect(view.field('强调色').props.value).toBe('#aabbcc');
    expect(view.settings().palettes?.slice(1)).toEqual(original.slice(1));
    expect(palettes).toEqual(original);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('preserves invalid accent text and derives a safe picker and preview until the value is corrected', () => {
    const palettes = createDefaultPalettes();
    delete palettes[0].light.accent;
    const expectedFallback = resolveAccentColor(palettes[0].light);
    const view = editor({ palettes, paletteId: palettes[0].id });
    view.field('强调色').props.onChange!({ target: { value: '#zz' } });
    const field = view.field('强调色');
    expect(view.selected().light.accent).toBe('#zz');
    expect(field.props.value).toBe('#zz');
    expect(field.props['aria-invalid']).toBe(true);
    expect(text(view.find('small', { id: field.props['aria-describedby'] }))).toBe('请输入 #RGB 或 #RRGGBB 格式的颜色。');
    expect(view.find('input', { type: 'color', 'aria-label': '强调色选色器' }).props.value).toBe(expectedFallback);
    expect(view.find('div', { 'aria-label': '配色预览' }).props.style).toMatchObject({ '--accent': expectedFallback });
    view.field('强调色').props.onChange!({ target: { value: '#AbC' } });
    expect(view.selected().light.accent).toBe('#AbC');
    expect(view.field('强调色').props['aria-invalid']).toBe(false);
    expect(view.find('input', { type: 'color', 'aria-label': '强调色选色器' }).props.value).toBe('#aabbcc');
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('follows system darkness in every swatch without resetting the editor tab or saving settings', () => {
    const listeners = new Set<() => void>();
    const media = {
      matches: true,
      addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
      removeEventListener: vi.fn((_event: string, listener: () => void) => listeners.delete(listener)),
    };
    const matchMedia = vi.fn(() => media);
    vi.stubGlobal('window', { matchMedia });
    const palettes = createDefaultPalettes();
    const view = editor({ theme: 'system', palettes });
    const expectSwatches = (mode: 'light' | 'dark') => {
      for (const palette of palettes) expect(view.find('button', { 'data-palette-id': palette.id }).props.style).toMatchObject({
        '--preview-bg': palette[mode].background, '--preview-panel': palette[mode].surface,
      });
    };
    const changeSystemDarkness = (dark: boolean) => {
      media.matches = dark;
      listeners.forEach(listener => listener());
    };
    expectSwatches('dark');
    expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(media.addEventListener).toHaveBeenCalledTimes(1);
    expect(media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(view.button('深色配色').props['aria-pressed']).toBe(true);
    expect(view.field('按钮底色').props.value).toBe(palettes[0].dark.primary);

    changeSystemDarkness(false);
    expectSwatches('light');
    expect(view.button('深色配色').props['aria-pressed']).toBe(true);
    expect(view.field('按钮底色').props.value).toBe(palettes[0].dark.primary);
    view.button('浅色配色').props.onClick!();
    changeSystemDarkness(true);
    expectSwatches('dark');
    expect(view.button('浅色配色').props['aria-pressed']).toBe(true);
    expect(view.field('按钮底色').props.value).toBe(palettes[0].light.primary);
    expect(view.settings().theme).toBe('system');
    expect(view.onChange).not.toHaveBeenCalled();

    view.button('浅色').props.onClick!();
    expectSwatches('light');
    changeSystemDarkness(false);
    changeSystemDarkness(true);
    expectSwatches('light');
    view.button('深色').props.onClick!();
    expectSwatches('dark');
    changeSystemDarkness(false);
    expectSwatches('dark');
    expect(view.onChange).toHaveBeenCalledTimes(2);
    expect(api.saveSettings).not.toHaveBeenCalled();
    const listener = media.addEventListener.mock.calls[0][1];
    view.dispose();
    expect(media.removeEventListener).toHaveBeenCalledWith('change', listener);
    expect(listeners.size).toBe(0);
  });

  it('renames and edits an initial palette while preserving its identity, other mode and other palettes', () => {
    const original = createDefaultPalettes();
    const view = editor({ palettes: original, paletteId: original[0].id });
    view.nameField().props.onChange!({ target: { value: '我的配色 {{name}}' } });
    view.field('按钮底色').props.onChange!({ target: { value: '#123456' } });
    view.find('input', { type: 'color', 'aria-label': '页面背景选色器' }).props.onChange!({ target: { value: '#abcdef' } });
    expect(view.selected()).toMatchObject({ id: original[0].id, name: '我的配色 {{name}}', light: { primary: '#123456', background: '#abcdef' }, dark: original[0].dark });
    expect(text(view.find('button', { 'data-palette-id': original[0].id }))).toBe('我的配色 {{name}}');
    const callsBeforeSwitch = view.onChange.mock.calls.length;
    view.button('深色配色').props.onClick!();
    expect(view.field('按钮底色').props.value).toBe(original[0].dark.primary);
    expect(view.onChange).toHaveBeenCalledTimes(callsBeforeSwitch);
    expect(view.settings().theme).toBe('light');
    view.field('卡片背景').props.onChange!({ target: { value: '#112233' } });
    view.field('正文文字').props.onChange!({ target: { value: '#fedcba' } });
    expect(view.selected().dark).toMatchObject({ surface: '#112233', text: '#fedcba' });
    expect(view.find('div', { 'aria-label': '配色预览' }).props.style).toMatchObject({ '--panel': '#112233', '--text': '#fedcba' });
    view.button('浅色配色').props.onClick!();
    expect(view.field('按钮底色').props.value).toBe('#123456');
    expect(view.settings().palettes?.slice(1)).toEqual(original.slice(1));
    expect(original).toEqual(createDefaultPalettes());
    expect(view.onChange.mock.calls.every(([patch]) => Object.keys(patch).join() === 'palettes')).toBe(true);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('adds independent copies of both modes, selects them and avoids duplicate names', () => {
    const palettes = createDefaultPalettes();
    palettes[1].name = palettes[0].name + '副本';
    const view = editor({ palettes, paletteId: palettes[0].id });
    const before = structuredClone(palettes);
    const sourcePreview = view.find('button', { 'data-palette-id': palettes[0].id }).props.style;
    view.button('添加方案').props.onClick!();
    const copied = view.selected();
    expect(view.settings().palettes).toHaveLength(5);
    expect(palettes.some(palette => palette.id === copied.id || palette.name === copied.name)).toBe(false);
    expect(copied.light).toEqual(palettes[0].light);
    expect(copied.dark).toEqual(palettes[0].dark);
    expect(copied.light).not.toBe(palettes[0].light);
    expect(copied.dark).not.toBe(palettes[0].dark);
    expect(view.find('button', { 'data-palette-id': copied.id }).props.style).toEqual(sourcePreview);
    view.field('按钮底色').props.onChange!({ target: { value: '#123abc' } });
    view.button('深色配色').props.onClick!();
    view.field('正文文字').props.onChange!({ target: { value: '#abc123' } });
    expect(view.selected()).toMatchObject({ light: { primary: '#123abc' }, dark: { text: '#abc123' } });
    expect(view.settings().palettes?.slice(0, 4)).toEqual(before);
    expect(palettes).toEqual(before);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('keeps deletion pending until confirmed, selects a remaining neighbor and retains a final palette', () => {
    const palettes = createDefaultPalettes().slice(0, 3);
    const view = editor({ palettes, paletteId: palettes[1].id });
    view.button('删除方案').props.onClick!();
    expect(view.find('div', { 'aria-label': '删除配色方案？' }).props.role).toBe('group');
    expect(view.onChange).not.toHaveBeenCalled();
    view.button('取消').props.onClick!();
    expect(view.all().some(node => node.props['aria-label'] === '删除配色方案？')).toBe(false);
    expect(view.onChange).not.toHaveBeenCalled();
    for (const remainingId of [palettes[2].id, palettes[0].id]) {
      view.button('删除方案').props.onClick!();
      view.button('确认删除方案').props.onClick!();
      expect(view.settings().paletteId).toBe(remainingId);
      expect(view.all().some(node => node.props['aria-label'] === '删除配色方案？')).toBe(false);
    }
    expect(view.settings().palettes).toEqual([palettes[0]]);
    expect(view.button('删除方案').props.disabled).toBe(true);
    expect(view.all().some(node => node.type === 'small' && text(node) === '至少保留一个配色方案。')).toBe(true);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('leaves the complete settings draft untouched when restoring defaults is opened and cancelled', () => {
    const palettes = createDefaultPalettes();
    palettes[0].name = '已修改的方案';
    palettes[0].light.accent = '#bad-input';
    const view = editor({ palettes, paletteId: 'pink', theme: 'dark', clientId: 'keep-this-client' });
    const before = structuredClone(view.settings());
    view.button('恢复默认方案集').props.onClick!();
    expect(view.find('div', { 'aria-label': '恢复默认方案集？' }).props.role).toBe('group');
    expect(view.button('确认恢复').props.type).toBe('button');
    expect(view.settings()).toEqual(before);
    expect(view.onChange).not.toHaveBeenCalled();
    view.button('取消').props.onClick!();
    expect(view.all().some(node => node.props['aria-label'] === '恢复默认方案集？')).toBe(false);
    expect(view.settings()).toEqual(before);
    expect(view.onChange).not.toHaveBeenCalled();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('restores the complete scheme set only after confirmation and preserves unrelated settings', () => {
    const defaults = createDefaultPalettes();
    const changedGreen = {
      ...structuredClone(defaults.find(palette => palette.id === 'green')!), name: '改过的绿色',
      light: { primary: '#112233', accent: '#445566', background: '#778899', surface: '#aabbcc', text: '#ddeeff' },
      dark: { primary: '#ffeedd', accent: '#ccbbaa', background: '#998877', surface: '#665544', text: '#332211' },
    };
    const custom = { ...structuredClone(defaults[0]), id: 'my-scheme', name: '自己添加的方案' };
    const palettes = [custom, changedGreen];
    const originalPalettes = structuredClone(palettes);
    const unrelated: Omit<Settings, 'palettes' | 'paletteId'> = {
      clientId: 'custom-oauth-client', language: 'cpp', uiLanguage: 'en', theme: 'system',
      forkRepository: 'someone/chosen-fork', prTitleTemplate: '标题 {{date}}', prBodyTemplate: '说明 {{notes}}',
    };
    const view = editor({ ...unrelated, palettes, paletteId: custom.id });
    view.button('恢复默认方案集').props.onClick!();
    expect(view.onChange).not.toHaveBeenCalled();
    view.button('确认恢复').props.onClick!();
    expect(view.onChange).toHaveBeenCalledExactlyOnceWith({ palettes: defaults, paletteId: 'green' });
    expect(view.settings()).toEqual({ ...unrelated, palettes: defaults, paletteId: 'green' });
    expect(view.all().filter(node => node.type === 'button' && node.props['data-palette-id']).map(node => node.props['data-palette-id'])).toEqual(['green', 'pink', 'blue', 'mono']);
    expect(view.find('button', { 'data-palette-id': 'green' }).props['aria-pressed']).toBe(true);
    expect(view.all().some(node => node.props['aria-label'] === '恢复默认方案集？')).toBe(false);
    expect(palettes).toEqual(originalPalettes);
    expect(api.saveSettings).not.toHaveBeenCalled();

    const firstReset = view.settings().palettes!;
    view.button('恢复默认方案集').props.onClick!();
    view.button('确认恢复').props.onClick!();
    const secondReset = view.settings().palettes!;
    expect(secondReset).toEqual(firstReset);
    expect(secondReset).not.toBe(firstReset);
    secondReset.forEach((palette, index) => {
      expect(palette).not.toBe(firstReset[index]);
      expect(palette.light).not.toBe(firstReset[index].light);
      expect(palette.dark).not.toBe(firstReset[index].dark);
    });
    view.field('强调色').props.onChange!({ target: { value: '#123456' } });
    expect(firstReset).toEqual(defaults);
    expect(createDefaultPalettes()).toEqual(defaults);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it.each([
    { locale: 'zh-CN', draftLanguage: 'en', open: '恢复默认方案集', label: '恢复默认方案集？', confirm: '确认恢复', names: ['绿色', '粉色', '蓝色', '黑白'] },
    { locale: 'en', draftLanguage: 'zh-CN', open: 'Restore default schemes', label: 'Restore default color schemes?', confirm: 'Restore schemes', names: ['Green', 'Pink', 'Blue', 'Black & white'] },
  ] as const)('uses the displayed $locale language for restored names while retaining the pending language choice', ({ locale, draftLanguage, open, label, confirm, names }) => {
    setLocale(locale);
    const view = editor({ uiLanguage: draftLanguage, palettes: createDefaultPalettes(draftLanguage), paletteId: 'blue' });
    view.button(open).props.onClick!();
    expect(view.find('div', { 'aria-label': label }).props.role).toBe('group');
    view.button(confirm).props.onClick!();
    expect(view.settings().palettes?.map(palette => palette.name)).toEqual(names);
    expect(view.settings().uiLanguage).toBe(draftLanguage);
    expect(view.settings().paletteId).toBe('green');
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('keeps restoring the set and deleting one scheme as mutually exclusive confirmations', () => {
    const view = editor();
    const confirmations = () => view.all().filter(node => node.props['aria-label'] === '恢复默认方案集？' || node.props['aria-label'] === '删除配色方案？').map(node => node.props['aria-label']);
    view.button('删除方案').props.onClick!();
    expect(confirmations()).toEqual(['删除配色方案？']);
    view.button('恢复默认方案集').props.onClick!();
    expect(confirmations()).toEqual(['恢复默认方案集？']);
    view.button('删除方案').props.onClick!();
    expect(confirmations()).toEqual(['删除配色方案？']);
    view.button('取消').props.onClick!();
    expect(confirmations()).toEqual([]);
    expect(view.onChange).not.toHaveBeenCalled();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it.each([1, 100])('can restore defaults with %i schemes even when the selected colors are invalid', count => {
    const source = createDefaultPalettes()[0];
    const palettes = Array.from({ length: count }, (_, index) => ({ ...structuredClone(source), id: 'scheme-' + index, name: '方案 ' + index }));
    palettes[0].light.accent = '#zz';
    const view = editor({ palettes, paletteId: palettes[0].id });
    expect(view.field('强调色').props['aria-invalid']).toBe(true);
    expect(view.button(count === 100 ? '添加方案' : '删除方案').props.disabled).toBe(true);
    expect(view.button('恢复默认方案集').props.disabled).not.toBe(true);
    view.button('恢复默认方案集').props.onClick!();
    expect(view.button('确认恢复').props.disabled).not.toBe(true);
    view.button('确认恢复').props.onClick!();
    expect(view.settings().palettes).toEqual(createDefaultPalettes());
    expect(view.settings().paletteId).toBe('green');
    expect(view.field('强调色').props['aria-invalid']).toBe(false);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('allows correcting an empty name while identifying its field error and unnamed card', () => {
    const view = editor();
    const selectedId = view.selected().id;
    view.nameField().props.onChange!({ target: { value: '   ' } });
    const field = view.nameField();
    expect(field.props.value).toBe('   ');
    expect(field.props['aria-invalid']).toBe(true);
    expect(text(view.find('small', { id: field.props['aria-describedby'] }))).toBe('请输入方案名称。');
    view.nameField().props.onChange!({ target: { value: '' } });
    expect(text(view.find('button', { 'data-palette-id': selectedId }))).toBe('未命名方案');
    view.nameField().props.onChange!({ target: { value: '新的名称' } });
    expect(view.nameField().props['aria-invalid']).toBe(false);
    expect(text(view.find('button', { 'data-palette-id': selectedId }))).toBe('新的名称');
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('disables adding another scheme after the last available slot is used', () => {
    const source = createDefaultPalettes()[0];
    const palettes = Array.from({ length: 99 }, (_, index) => ({ ...structuredClone(source), id: 'scheme-' + index, name: '方案 ' + index }));
    const view = editor({ palettes, paletteId: palettes[0].id });
    expect(view.button('添加方案').props.disabled).toBe(false);
    view.button('添加方案').props.onClick!();
    expect(view.settings().palettes).toHaveLength(100);
    expect(view.button('添加方案').props.disabled).toBe(true);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('keeps invalid text editable with an associated error and valid picker and preview values', () => {
    const view = editor();
    view.field('按钮底色').props.onChange!({ target: { value: '#zz' } });
    const field = view.field('按钮底色');
    expect(field.props.value).toBe('#zz');
    expect(field.props['aria-invalid']).toBe(true);
    expect(text(view.find('small', { id: field.props['aria-describedby'] }))).toBe('请输入 #RGB 或 #RRGGBB 格式的颜色。');
    expect(view.find('input', { type: 'color', 'aria-label': '按钮底色选色器' }).props.value).toBe(createDefaultPalettes()[0].light.primary);
    expect(Object.values(view.find('div', { 'aria-label': '配色预览' }).props.style as Record<string, string>)).not.toContain('#zz');
    view.field('按钮底色').props.onChange!({ target: { value: '#AbC' } });
    expect(view.field('按钮底色').props['aria-invalid']).toBe(false);
    expect(view.find('input', { type: 'color', 'aria-label': '按钮底色选色器' }).props.value).toBe('#aabbcc');
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it.each(['background', 'surface'] as const)('warns about poor text contrast on the %s without disabling editing', background => {
    const palettes = createDefaultPalettes();
    palettes[0].light = { primary: '#456789', background: '#ffffff', surface: '#ffffff', text: '#000000', [background]: '#000000' };
    const view = editor({ palettes });
    expect(text(view.find('p', { role: 'status' }))).toContain('1.00:1，建议至少 4.5:1');
    expect(view.all().filter(node => node.type === 'button' || node.type === 'input').every(node => !node.props.disabled)).toBe(true);
    view.field(background === 'background' ? '页面背景' : '卡片背景').props.onChange!({ target: { value: '#ffffff' } });
    expect(view.all().some(node => node.props.role === 'status')).toBe(false);
  });
});

