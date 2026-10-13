import { describe, expect, it } from 'vitest';
import { appearanceBackground, appearanceEqual, contrastRatio, createDefaultPalettes, DEFAULT_PALETTE_COLORS, getSelectedPalette, normalizeColorHex, resolveAccentColor, themeVariables } from '../shared/appearance';
import type { Settings } from '../shared/types';

const settings = (): Settings => ({ clientId: '', language: 'cpp', theme: 'light', palettes: createDefaultPalettes('zh-CN'), paletteId: 'green' });

describe('shared appearance palettes', () => {
  it('uses exactly the same derived colors for seeded and user-created palettes', () => {
    for (const source of createDefaultPalettes()) {
      const copy = { ...structuredClone(source), id: 'my-palette', name: '我的方案' };
      for (const mode of ['light', 'dark'] as const) expect(themeVariables(copy[mode], mode)).toEqual(themeVariables(source[mode], mode));
    }
  });

  it('returns independently editable defaults, without shared color objects', () => {
    const first = createDefaultPalettes(), second = createDefaultPalettes();
    first[0].name = 'Renamed'; first[0].light.primary = '#000000';
    expect(second[0].name).not.toBe('Renamed');
    expect(second[0].light.primary).toBe('#c4e3cc');
    expect(first[0].dark.primary).toBe('#c5e6ce');
  });

  it('treats names and IDs only as data, and keeps saved names when UI language changes', () => {
    const saved = settings(); saved.palettes![0].name = 'My own name';
    expect(getSelectedPalette({ ...saved, uiLanguage: 'en' }).name).toBe('My own name');
    expect(createDefaultPalettes('en')[0].name).toBe('Green');
    expect(createDefaultPalettes('zh-CN')[0].name).toBe('绿色');
    expect(getSelectedPalette({}).id).toBe('green');
    expect(getSelectedPalette({ paletteId: 'pink' }).id).toBe('pink');
  });

  it('detects name, selection, ordering and either mode edits; equivalent hex input is clean', () => {
    const original = settings();
    const copy = structuredClone(original);
    copy.palettes![0].light.surface = '#FFF';
    expect(appearanceEqual(original, copy)).toBe(true);
    copy.palettes![0].dark.text = '#eeeeee';
    expect(appearanceEqual(original, copy)).toBe(false);
    expect(appearanceEqual(original, { ...original, paletteId: 'blue' })).toBe(false);
    const renamed = structuredClone(original); renamed.palettes![0].name += ' 2';
    expect(appearanceEqual(original, renamed)).toBe(false);
    expect(appearanceEqual(original, { ...original, palettes: [...original.palettes!].reverse() })).toBe(false);
  });

  it('uses the selected background for native windows and follows system mode only when requested', () => {
    const value = settings(); value.paletteId = 'blue'; value.theme = 'system';
    expect(appearanceBackground(value, false)).toBe('#f7faff');
    expect(appearanceBackground(value, true)).toBe('#1c2026');
    value.theme = 'light'; expect(appearanceBackground(value, true)).toBe('#f7faff');
    value.palettes![2].light.background = '#abc';
    expect(appearanceBackground(value, true)).toBe('#aabbcc');
  });

  it('normalizes hex colors and rejects CSS expressions and non-colors', () => {
    expect(normalizeColorHex(' #AbC ')).toBe('#aabbcc');
    expect(normalizeColorHex('#123ABC')).toBe('#123abc');
    for (const invalid of ['red', '#1234', '#12345678', 'var(--x)', 'url(x)', '#000; color:red', null, 10]) expect(normalizeColorHex(invalid)).toBeNull();
    expect(contrastRatio('#000', '#fff')).toBe(21);
  });

  for (const palette of createDefaultPalettes()) for (const mode of ['light', 'dark'] as const) {
    it(`${palette.id} ${mode} preserves chosen colors and keeps body, secondary and button text readable`, () => {
      const colors = palette[mode], variables = themeVariables(colors, mode);
      expect(variables['--primary-bg']).toBe(colors.primary);
      expect(variables['--panel']).toBe(colors.surface);
      expect(variables['--text']).toBe(colors.text);
      expect(variables['--bg']).toBe(colors.background);
      expect(variables['--accent']).toBe(colors.accent);
      for (const [foreground, background] of [
        ['--text', '--bg'], ['--text', '--panel'], ['--muted', '--panel'], ['--muted', '--bg'],
        ['--on-primary', '--primary-bg'], ['--on-primary', '--primary-hover'],
      ]) expect(contrastRatio(variables[foreground], variables[background])).toBeGreaterThanOrEqual(4.5);
      expect(variables).not.toHaveProperty('--success');
      expect(variables).not.toHaveProperty('--error');
    });
  }

  it('handles extreme custom colors, partial HEX drafts and preserves user body colors', () => {
    const base = createDefaultPalettes()[0].light;
    for (const primary of ['#000000', '#ffffff', '#808080', '#ff0000', '#0000ff', '#00ff00', '#ffff00']) {
      const variables = themeVariables({ ...base, primary });
      expect(contrastRatio(variables['--on-primary'], variables['--primary-bg'])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(variables['--on-primary'], variables['--primary-hover'])).toBeGreaterThanOrEqual(4.5);
    }
    const draft = themeVariables({ ...base, primary: '#', text: '#fff', surface: '#fff' });
    expect(draft['--primary-bg']).toBe(DEFAULT_PALETTE_COLORS.light.primary);
    expect(draft['--text']).toBe('#ffffff');
  });

  it('keeps readable custom button text at least as legible on hover', () => {
    const base = createDefaultPalettes()[0].light;
    for (const [primary, text] of [['#333333', '#aaaaaa'], ['#eeeeee', '#666666'], ['#808080', '#000000'], ['#777777', '#ffffff']]) {
      const variables = themeVariables({ ...base, primary, text });
      const normal = contrastRatio(variables['--on-primary'], variables['--primary-bg']);
      const hovered = contrastRatio(variables['--on-primary'], variables['--primary-hover']);
      expect(hovered).toBeGreaterThanOrEqual(normal);
      expect(hovered).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps button backgrounds and accent text independently editable in every palette', () => {
    for (const palette of createDefaultPalettes()) for (const mode of ['light', 'dark'] as const) {
      const base = palette[mode], original = themeVariables(base, mode);
      const buttonChange = themeVariables({ ...base, primary: '#deaaff' }, mode);
      for (const field of ['--accent', '--accent-soft', '--accent-border', '--accent-hover', '--focus-ring', '--selection', '--line']) expect(buttonChange[field]).toBe(original[field]);
      expect(buttonChange['--primary-bg']).toBe('#deaaff');
      const accentChange = themeVariables({ ...base, accent: mode === 'light' ? '#007050' : '#8affcc' }, mode);
      expect(accentChange['--accent']).not.toBe(original['--accent']);
      for (const field of ['--primary-bg', '--primary-hover', '--primary-border', '--on-primary']) expect(accentChange[field]).toBe(original[field]);
    }
  });

  it('uses the exact sampled pink action text while retaining pale buttons', () => {
    const pink = createDefaultPalettes().find(palette => palette.id === 'pink')!;
    const light = themeVariables(pink.light), dark = themeVariables(pink.dark, 'dark');
    expect(light['--accent']).toBe('#fb7299');
    expect(dark['--accent']).toBe('#ffa8c0');
    expect(light['--accent-soft']).toBe('#ffe6ed');
    expect(light['--line']).toBe('#fee6ed');
    expect(light['--primary-bg']).toBe('#f8bed0');
    expect(dark['--primary-bg']).toBe('#ffc4d4');
  });

  it('upgrades four-color palettes from color values alone without changing their base values', () => {
    const { accent: _, ...legacy } = createDefaultPalettes()[0].light;
    const before = structuredClone(legacy), accent = resolveAccentColor(legacy);
    expect(legacy).toEqual(before);
    expect(accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(accent, legacy.surface)).toBeGreaterThanOrEqual(4.5);
    expect(themeVariables(legacy)).toEqual(themeVariables({ ...legacy, accent }));
    const original = settings(); original.palettes![0].light = legacy;
    const migrated = structuredClone(original); migrated.palettes![0].light.accent = accent;
    expect(appearanceEqual(original, migrated)).toBe(true);
    migrated.palettes![0].light.accent = '#aa1144';
    expect(appearanceEqual(original, migrated)).toBe(false);
  });

  it('handles monochrome, extreme accents and incomplete accent drafts without invalid CSS', () => {
    const base = createDefaultPalettes()[0].light;
    for (const accent of ['#000000', '#ffffff', '#ff0000', '#0000ff', '#00ff00', '#ffff00', '#808080', '#']) {
      const variables = themeVariables({ ...base, accent });
      expect(variables['--accent']).toMatch(/^#[0-9a-f]{6}$/);
      if (normalizeColorHex(accent)) expect(variables['--accent']).toBe(accent);
    }
    const legacyMono = { ...base, primary: '#dddddd', accent: undefined };
    const accent = resolveAccentColor(legacyMono);
    expect(accent.slice(1, 3)).toBe(accent.slice(3, 5));
    expect(accent.slice(3, 5)).toBe(accent.slice(5, 7));
  });
});
