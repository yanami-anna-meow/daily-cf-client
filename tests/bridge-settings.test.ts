import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPSTREAM, type ColorPalette, type Settings } from '../shared/types';
import { createDefaultPalettes, resolveAccentColor } from '../shared/appearance';

const PREFIX = `daily-cf-preview:${UPSTREAM.owner}/${UPSTREAM.repo}:`;
const KEY = `${PREFIX}settings`;
const SETTINGS: Settings = {
  clientId: 'configured_client', language: 'py', uiLanguage: 'system', theme: 'dark',
  palettes: createDefaultPalettes(), paletteId: 'pink',
  forkRepository: 'sample/fork', prTitleTemplate: 'Solutions', prBodyTemplate: '{{files}}',
};
const PALETTE_INPUT = {
  id: 'evening', name: ' Evening ',
  light: { primary: '#AbC', background: '#FFF', surface: '#F1E2D3', text: '#123', extra: 'discard me' },
  dark: { primary: '#DEF', background: '#102030', surface: '#234', text: '#FEDCBA', extra: 'discard me' },
  extra: 'discard me',
};
const LEGACY_PALETTE: ColorPalette = {
  id: 'evening', name: 'Evening',
  light: { primary: '#aabbcc', background: '#ffffff', surface: '#f1e2d3', text: '#112233' },
  dark: { primary: '#ddeeff', background: '#102030', surface: '#223344', text: '#fedcba' },
};
const NORMALIZED_PALETTE: ColorPalette = {
  ...LEGACY_PALETTE,
  light: { ...LEGACY_PALETTE.light, accent: resolveAccentColor(LEGACY_PALETTE.light) },
  dark: { ...LEGACY_PALETTE.dark, accent: resolveAccentColor(LEGACY_PALETTE.dark) },
};

function browserStorage(entries: Map<string, string>, failWrites = false) {
  const storage = {
    get length() { return entries.size; },
    key: vi.fn((index: number) => [...entries.keys()][index] ?? null),
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      if (failWrites) throw new Error('Storage unavailable');
      entries.set(key, value);
    }),
    removeItem: vi.fn((key: string) => { entries.delete(key); }),
  };
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', { languages: ['zh-CN'], language: 'zh-CN' });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No network expected'); }));
  return storage;
}

describe('browser settings migration', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('removes the old default author from active browser settings without touching other storage', async () => {
    const entries = new Map([
      [KEY, JSON.stringify({ ...SETTINGS, author: 'old_default' })],
      ['unrelated-session-state', 'leave this value unchanged'],
      [`${PREFIX}day-2024-03-18`, '{"cached":"problem"}'],
    ]);
    const storage = browserStorage(entries);
    const { api } = await import('../src/bridge');
    expect((await api.bootstrap()).settings).toEqual(SETTINGS);
    expect(JSON.parse(entries.get(KEY)!)).toEqual(SETTINGS);
    expect(entries.get('unrelated-session-state')).toBe('leave this value unchanged');
    expect(entries.has(`${PREFIX}day-2024-03-18`)).toBe(false);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem.mock.calls[0][0]).toBe(KEY);
    expect(api).not.toHaveProperty('getHandleSubmissions');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes browser settings saves and never persists an injected default author', async () => {
    const entries = new Map<string, string>();
    browserStorage(entries);
    const { api } = await import('../src/bridge');
    const source = { ...SETTINGS, author: 'should_not_persist' };
    expect(await api.saveSettings(source)).toEqual(SETTINGS);
    expect((await api.bootstrap()).settings).toEqual(SETTINGS);
    expect(JSON.parse(entries.get(KEY)!)).toEqual(SETTINGS);
  });

  it('round-trips adding, renaming, editing, selecting and deleting palettes, including the initial entries', async () => {
    const entries = new Map([[KEY, JSON.stringify(SETTINGS)], ['unrelated-session-state', 'preserved session']]);
    browserStorage(entries);
    let { api } = await import('../src/bridge');
    const seeds = createDefaultPalettes();
    const added = { ...NORMALIZED_PALETTE, name: 'My palette' };
    const renamed = { ...added, name: 'Evening study' };
    const edited = {
      ...renamed,
      light: { primary: '#112233', accent: '#445566', background: '#fefefe', surface: '#eeeeee', text: '#223344' },
      dark: { primary: '#aabbcc', accent: '#bbaadd', background: '#101112', surface: '#202122', text: '#ddeeff' },
    };
    const editedSeed = {
      ...seeds[0], name: 'My first palette',
      light: { ...seeds[0].light, background: '#fafafa' },
      dark: { ...seeds[0].dark, primary: '#abcdef' },
    };
    const replacement = { ...NORMALIZED_PALETTE, id: 'replacement', name: 'Replacement' };
    const stages = [
      { name: 'add', palettes: [...seeds, added], paletteId: seeds[0].id },
      { name: 'rename', palettes: [...seeds, renamed], paletteId: seeds[0].id },
      { name: 'edit both modes', palettes: [...seeds, edited], paletteId: seeds[0].id },
      { name: 'select added palette', palettes: [...seeds, edited], paletteId: edited.id },
      { name: 'edit and rename initial palette', palettes: [editedSeed, ...seeds.slice(1), edited], paletteId: edited.id },
      { name: 'delete initial palette', palettes: [editedSeed, ...seeds.slice(2), edited], paletteId: edited.id },
      { name: 'select edited initial palette', palettes: [editedSeed, ...seeds.slice(2), edited], paletteId: editedSeed.id },
      { name: 'delete all initial palettes', palettes: [edited], paletteId: edited.id },
      { name: 'add replacement', palettes: [edited, replacement], paletteId: replacement.id },
      { name: 'delete added palette', palettes: [replacement], paletteId: replacement.id },
    ];

    for (const stage of stages) {
      const expected: Settings = { ...SETTINGS, palettes: stage.palettes, paletteId: stage.paletteId };
      expect(await api.saveSettings(expected), stage.name).toEqual(expected);
      expect((await api.bootstrap()).settings, stage.name).toEqual(expected);
      expect(JSON.parse(entries.get(KEY)!), stage.name).toEqual(expected);
      vi.resetModules();
      ({ api } = await import('../src/bridge'));
      expect((await api.bootstrap()).settings, stage.name).toEqual(expected);
      expect(entries.get('unrelated-session-state'), stage.name).toBe('preserved session');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['light', 'dark', 'system'] as const)('keeps palette colors and selection independent of %s mode', async theme => {
    const entries = new Map<string, string>();
    browserStorage(entries);
    const { api } = await import('../src/bridge');
    const expected: Settings = { ...SETTINGS, theme, palettes: [NORMALIZED_PALETTE], paletteId: NORMALIZED_PALETTE.id };
    expect(await api.saveSettings(expected)).toEqual(expected);
    expect(JSON.parse(entries.get(KEY)!)).toEqual(expected);
    vi.resetModules();
    const { api: restored } = await import('../src/bridge');
    expect((await restored.bootstrap()).settings).toEqual(expected);
  });

  it('normalizes legacy colors, fills text accents and drops extra palette fields on save and reload', async () => {
    const entries = new Map<string, string>();
    browserStorage(entries);
    const { api } = await import('../src/bridge');
    const expected: Settings = { ...SETTINGS, palettes: [NORMALIZED_PALETTE], paletteId: NORMALIZED_PALETTE.id };
    expect(await api.saveSettings({ ...expected, palettes: [PALETTE_INPUT] })).toEqual(expected);
    expect(JSON.parse(entries.get(KEY)!)).toEqual(expected);
    vi.resetModules();
    const { api: restored } = await import('../src/bridge');
    expect((await restored.bootstrap()).settings).toEqual(expected);
  });

  it('fills missing text accents on startup without changing the palette name, selection or existing colors', async () => {
    const other = createDefaultPalettes()[0];
    const source: Settings = { ...SETTINGS, uiLanguage: 'en', palettes: [other, LEGACY_PALETTE], paletteId: LEGACY_PALETTE.id };
    const original = JSON.stringify(source);
    const entries = new Map([[KEY, original]]);
    const storage = browserStorage(entries);
    const { api } = await import('../src/bridge');
    const expected: Settings = { ...source, palettes: [other, NORMALIZED_PALETTE] };
    expect((await api.bootstrap()).settings).toEqual(expected);
    expect(entries.get(KEY)).toBe(original);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(await api.saveSettings(source)).toEqual(expected);
    expect(JSON.parse(entries.get(KEY)!)).toEqual(expected);
    vi.resetModules();
    const { api: restored } = await import('../src/bridge');
    expect((await restored.bootstrap()).settings).toEqual(expected);
  });

  it('normalizes explicit text accents on startup and save without changing button colors or other settings', async () => {
    const selected = {
      ...NORMALIZED_PALETTE,
      light: { ...NORMALIZED_PALETTE.light, accent: ' #F0A ' },
      dark: { ...NORMALIZED_PALETTE.dark, accent: '#aBCD12' },
    };
    const source: Settings = { ...SETTINGS, palettes: [createDefaultPalettes()[0], selected], paletteId: selected.id };
    const expected: Settings = {
      ...source,
      palettes: [source.palettes![0], {
        ...NORMALIZED_PALETTE,
        light: { ...NORMALIZED_PALETTE.light, accent: '#ff00aa' },
        dark: { ...NORMALIZED_PALETTE.dark, accent: '#abcd12' },
      }],
    };
    const original = JSON.stringify(source);
    const entries = new Map([[KEY, original]]);
    const storage = browserStorage(entries);
    const { api } = await import('../src/bridge');
    expect((await api.bootstrap()).settings).toEqual(expected);
    expect(entries.get(KEY)).toBe(original);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(await api.saveSettings(source)).toEqual(expected);
    expect(JSON.parse(entries.get(KEY)!)).toEqual(expected);
    vi.resetModules();
    const { api: restored } = await import('../src/bridge');
    expect((await restored.bootstrap()).settings).toEqual(expected);
  });

  it.each([
    { mode: 'light' as const, accent: 'red' },
    { mode: 'dark' as const, accent: null },
  ])('drops a palette with an invalid $mode text accent while retaining valid entries', async ({ mode, accent }) => {
    const retained = { ...NORMALIZED_PALETTE, id: 'retained', name: 'Retained name' };
    const broken = { ...NORMALIZED_PALETTE, id: 'broken', [mode]: { ...NORMALIZED_PALETTE[mode], accent } };
    const source = { ...SETTINGS, uiLanguage: 'en', palettes: [broken, retained], paletteId: broken.id };
    const original = JSON.stringify(source);
    const entries = new Map([[KEY, original]]);
    const storage = browserStorage(entries);
    const { api } = await import('../src/bridge');
    const expected: Settings = { ...SETTINGS, uiLanguage: 'en', palettes: [retained], paletteId: retained.id };
    expect((await api.bootstrap()).settings).toEqual(expected);
    expect(entries.get(KEY)).toBe(original);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(await api.saveSettings(expected)).toEqual(expected);
    expect(JSON.parse(entries.get(KEY)!)).toEqual(expected);
    vi.resetModules();
    const { api: restored } = await import('../src/bridge');
    expect((await restored.bootstrap()).settings).toEqual(expected);
  });

  it('initializes fresh browser settings with green selected and the other palettes available', async () => {
    const storage = browserStorage(new Map<string, string>());
    const { api } = await import('../src/bridge');
    const defaults = createDefaultPalettes();
    expect(defaults.map(palette => palette.id)).toEqual(['green', 'pink', 'blue', 'mono']);
    expect((await api.bootstrap()).settings).toEqual({
      clientId: '', language: 'cpp', uiLanguage: 'system', theme: 'light',
      palettes: defaults, paletteId: defaults[0].id,
    });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('keeps an existing pink palette and its colors rather than replacing them with new defaults', async () => {
    const oldPink: ColorPalette = {
      id: 'pink', name: 'My pink',
      light: { primary: '#f8bed0', accent: '#b62d56', background: '#fff8fa', surface: '#ffffff', text: '#3b2e32' },
      dark: { primary: '#ffc4d4', accent: '#ffa8c0', background: '#211e20', surface: '#2b2729', text: '#f7ecef' },
    };
    const source: Settings = { ...SETTINGS, palettes: [oldPink, NORMALIZED_PALETTE], paletteId: 'pink' };
    const original = JSON.stringify(source);
    const entries = new Map([[KEY, original]]);
    const storage = browserStorage(entries);
    const { api } = await import('../src/bridge');
    expect((await api.bootstrap()).settings).toEqual(source);
    expect(entries.get(KEY)).toBe(original);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(await api.saveSettings(source)).toEqual(source);
    vi.resetModules();
    const { api: restored } = await import('../src/bridge');
    expect((await restored.bootstrap()).settings).toEqual(source);
  });

  it.each([
    { name: 'both palette fields', input: { palettes: undefined, paletteId: undefined }, palettes: createDefaultPalettes(), paletteId: 'green' },
    { name: 'palette list', input: { palettes: undefined, paletteId: 'pink' }, palettes: createDefaultPalettes(), paletteId: 'pink' },
    { name: 'selection', input: { palettes: [NORMALIZED_PALETTE], paletteId: undefined }, palettes: [NORMALIZED_PALETTE], paletteId: NORMALIZED_PALETTE.id },
  ])('fills missing $name on startup and save without changing other settings', async ({ input, palettes, paletteId }) => {
    const source: Settings = { ...SETTINGS, ...input };
    const original = JSON.stringify(source);
    const entries = new Map([[KEY, original]]);
    const storage = browserStorage(entries);
    const { api } = await import('../src/bridge');
    const expected: Settings = { ...SETTINGS, palettes, paletteId };
    expect((await api.bootstrap()).settings).toEqual(expected);
    expect(entries.get(KEY)).toBe(original);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(await api.saveSettings(source)).toEqual(expected);
    expect(JSON.parse(entries.get(KEY)!)).toEqual(expected);
    vi.resetModules();
    const { api: restored } = await import('../src/bridge');
    expect((await restored.bootstrap()).settings).toEqual(expected);
  });

  it.each([
    { name: 'valid selection', paletteId: 'retained', expectedId: 'retained' },
    { name: 'removed selection', paletteId: 'broken', expectedId: NORMALIZED_PALETTE.id },
  ])('recovers valid entries from a partly malformed list with $name', async ({ paletteId, expectedId }) => {
    const retained = { ...NORMALIZED_PALETTE, id: 'retained', name: 'Retained' };
    const source = {
      ...SETTINGS, uiLanguage: 'en' as const, paletteId,
      palettes: [
        null,
        { ...NORMALIZED_PALETTE, id: 'broken', light: { ...NORMALIZED_PALETTE.light, primary: 'red' } },
        PALETTE_INPUT,
        { ...NORMALIZED_PALETTE, id: 'incomplete', dark: undefined },
        retained,
      ],
    };
    const original = JSON.stringify(source);
    const entries = new Map([[KEY, original], ['unrelated-session-state', 'preserved session']]);
    const storage = browserStorage(entries);
    const { api } = await import('../src/bridge');
    const { getLocale } = await import('../shared/i18n');
    const expected: Settings = { ...SETTINGS, uiLanguage: 'en', palettes: [NORMALIZED_PALETTE, retained], paletteId: expectedId };
    expect((await api.bootstrap()).settings).toEqual(expected);
    expect(getLocale()).toBe('en');
    expect(entries.get(KEY)).toBe(original);
    expect(storage.setItem).not.toHaveBeenCalled();
    await api.saveSettings(expected);
    vi.resetModules();
    const { api: restored } = await import('../src/bridge');
    expect((await restored.bootstrap()).settings).toEqual(expected);
    expect(entries.get('unrelated-session-state')).toBe('preserved session');
  });

  it('keeps the first valid occurrence of a duplicated palette id', async () => {
    const firstValid = { ...NORMALIZED_PALETTE, id: 'repeated', name: 'First valid' };
    const other = { ...NORMALIZED_PALETTE, id: 'other', name: 'Other' };
    const entries = new Map([[KEY, JSON.stringify({
      ...SETTINGS, paletteId: firstValid.id,
      palettes: [
        { ...firstValid, name: '' },
        firstValid,
        { ...firstValid, name: 'Later valid', light: { ...firstValid.light, primary: '#000000' } },
        other,
      ],
    })]]);
    browserStorage(entries);
    const { api } = await import('../src/bridge');
    const expected: Settings = { ...SETTINGS, palettes: [firstValid, other], paletteId: firstValid.id };
    expect((await api.bootstrap()).settings).toEqual(expected);
    await api.saveSettings(expected);
    vi.resetModules();
    const { api: restored } = await import('../src/bridge');
    expect((await restored.bootstrap()).settings).toEqual(expected);
  });

  it.each([
    { name: 'empty list', palettes: [] },
    { name: 'entirely invalid list', palettes: [null, {}, { ...NORMALIZED_PALETTE, name: '' }] },
    { name: 'null list', palettes: null },
    { name: 'object list', palettes: {} },
    { name: 'string list', palettes: 'invalid' },
  ])('restores default palettes for a stored $name while preserving other preferences', async ({ palettes }) => {
    const source = { ...SETTINGS, uiLanguage: 'en' as const, palettes, paletteId: 'unavailable' };
    const original = JSON.stringify(source);
    const entries = new Map([[KEY, original]]);
    const storage = browserStorage(entries);
    const { api } = await import('../src/bridge');
    const { getLocale } = await import('../shared/i18n');
    const expected: Settings = { ...SETTINGS, uiLanguage: 'en', palettes: createDefaultPalettes('en'), paletteId: 'green' };
    expect((await api.bootstrap()).settings).toEqual(expected);
    expect(getLocale()).toBe('en');
    expect(entries.get(KEY)).toBe(original);
    expect(storage.setItem).not.toHaveBeenCalled();
    await api.saveSettings(expected);
    vi.resetModules();
    const { api: restored } = await import('../src/bridge');
    expect((await restored.bootstrap()).settings).toEqual(expected);
  });

  it('accepts and reloads the maximum of one hundred palettes', async () => {
    const entries = new Map<string, string>();
    browserStorage(entries);
    const { api } = await import('../src/bridge');
    const palettes = Array.from({ length: 100 }, (_, index) => ({
      ...NORMALIZED_PALETTE, id: 'palette-' + index, name: 'Palette ' + index,
    }));
    const expected: Settings = { ...SETTINGS, palettes, paletteId: palettes[99].id };
    expect(await api.saveSettings(expected)).toEqual(expected);
    expect(JSON.parse(entries.get(KEY)!)).toEqual(expected);
    vi.resetModules();
    const { api: restored } = await import('../src/bridge');
    expect((await restored.bootstrap()).settings).toEqual(expected);
  });

  it.each([
    { name: 'empty list', invalid: { palettes: [] } },
    { name: 'null list', invalid: { palettes: null } },
    { name: 'non-array list', invalid: { palettes: {} } },
    { name: 'too many palettes', invalid: { palettes: Array.from({ length: 101 }, (_, index) => ({ ...NORMALIZED_PALETTE, id: 'palette-' + index })), paletteId: 'palette-0' } },
    { name: 'duplicate ids', invalid: { palettes: [NORMALIZED_PALETTE, { ...NORMALIZED_PALETTE, name: 'Duplicate' }] } },
    { name: 'invalid id', invalid: { palettes: [{ ...NORMALIZED_PALETTE, id: 'invalid/id' }], paletteId: 'invalid/id' } },
    { name: 'empty id', invalid: { palettes: [{ ...NORMALIZED_PALETTE, id: '' }], paletteId: '' } },
    { name: 'empty name', invalid: { palettes: [{ ...NORMALIZED_PALETTE, name: '' }] } },
    { name: 'non-string name', invalid: { palettes: [{ ...NORMALIZED_PALETTE, name: 17 }] } },
    { name: 'missing dark colors', invalid: { palettes: [{ ...NORMALIZED_PALETTE, dark: undefined }] } },
    { name: 'invalid light color', invalid: { palettes: [{ ...NORMALIZED_PALETTE, light: { ...NORMALIZED_PALETTE.light, primary: '#abcd' } }] } },
    { name: 'invalid dark color', invalid: { palettes: [{ ...NORMALIZED_PALETTE, dark: { ...NORMALIZED_PALETTE.dark, text: 'red' } }] } },
    { name: 'empty text accent', invalid: { palettes: [{ ...NORMALIZED_PALETTE, light: { ...NORMALIZED_PALETTE.light, accent: '' } }] } },
    { name: 'invalid text accent', invalid: { palettes: [{ ...NORMALIZED_PALETTE, dark: { ...NORMALIZED_PALETTE.dark, accent: '#abcd' } }] } },
    { name: 'unknown selection', invalid: { paletteId: 'missing' } },
    { name: 'null selection', invalid: { paletteId: null } },
  ])('rejects $name without changing browser storage, memory or locale', async ({ invalid }) => {
    const savedSettings: Settings = { ...SETTINGS, palettes: [NORMALIZED_PALETTE], paletteId: NORMALIZED_PALETTE.id };
    const original = JSON.stringify(savedSettings);
    const entries = new Map([[KEY, original], ['unrelated-session-state', 'preserved session']]);
    const storage = browserStorage(entries);
    const { api } = await import('../src/bridge');
    const { getLocale } = await import('../shared/i18n');
    expect(getLocale()).toBe('zh-CN');

    await expect(api.saveSettings({ ...savedSettings, theme: 'light', uiLanguage: 'en', ...invalid } as unknown as Settings)).rejects.toThrow();
    expect(entries.get(KEY)).toBe(original);
    expect(entries.get('unrelated-session-state')).toBe('preserved session');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect((await api.bootstrap()).settings).toEqual(savedSettings);
    expect(getLocale()).toBe('zh-CN');
  });

  it('keeps memory and locale unchanged after a failed palette write and saves after storage recovers', async () => {
    const original = JSON.stringify(SETTINGS);
    const entries = new Map([[KEY, original]]);
    const storage = browserStorage(entries);
    const { api } = await import('../src/bridge');
    const { getLocale } = await import('../shared/i18n');
    storage.setItem.mockImplementationOnce(() => { throw new Error('Storage unavailable'); });
    const changed: Settings = {
      ...SETTINGS, theme: 'light', uiLanguage: 'en', palettes: [PALETTE_INPUT], paletteId: PALETTE_INPUT.id,
    };

    await expect(api.saveSettings(changed)).rejects.toThrow('Storage unavailable');
    expect(entries.get(KEY)).toBe(original);
    expect((await api.bootstrap()).settings).toEqual(SETTINGS);
    expect(getLocale()).toBe('zh-CN');

    const expected: Settings = { ...changed, palettes: [NORMALIZED_PALETTE] };
    expect(await api.saveSettings(changed)).toEqual(expected);
    expect((await api.bootstrap()).settings).toEqual(expected);
    expect(JSON.parse(entries.get(KEY)!)).toEqual(expected);
    expect(getLocale()).toBe('en');
    vi.resetModules();
    const { api: restored } = await import('../src/bridge');
    expect((await restored.bootstrap()).settings).toEqual(expected);
    const { getLocale: restoredLocale } = await import('../shared/i18n');
    expect(restoredLocale()).toBe('en');
  });

  it('does not mistake a saved or injected Client ID for a build-provided default', async () => {
    const entries = new Map([[KEY, JSON.stringify({ ...SETTINGS, defaultClientId: 'injected_default' })]]);
    browserStorage(entries);
    const { api } = await import('../src/bridge');
    const boot = await api.bootstrap();
    expect(boot.settings.clientId).toBe('configured_client');
    expect(boot.defaultClientId).toBe('');
    const changed = { ...SETTINGS, clientId: 'another_custom_client', defaultClientId: 'injected_default' };
    await api.saveSettings(changed);
    expect((await api.bootstrap()).defaultClientId).toBe('');
    expect((await api.bootstrap()).settings.clientId).toBe('another_custom_client');
    expect(JSON.parse(entries.get(KEY)!)).not.toHaveProperty('defaultClientId');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never exposes the old author even when browser storage cannot be updated', async () => {
    const original = JSON.stringify({ ...SETTINGS, author: 'old_default' });
    const entries = new Map([[KEY, original]]);
    browserStorage(entries, true);
    const { api } = await import('../src/bridge');
    expect((await api.bootstrap()).settings).toEqual(SETTINGS);
    expect(entries.get(KEY)).toBe(original);
    await expect(api.saveSettings({ ...SETTINGS, theme: 'light' })).rejects.toThrow('Storage unavailable');
    expect((await api.bootstrap()).settings).toEqual(SETTINGS);
  });

  it('removes only exact legacy remote-data keys in this repository namespace', async () => {
    const obsolete = ['library', 'day-latest', 'day-2024-02-29', 'day-0001-01-01', 'day-9999-12-31'].map(name => `${PREFIX}${name}`);
    const keep = [KEY, `${PREFIX}day-2024-02-30`, `${PREFIX}day-0000-01-01`, `${PREFIX}day-2024-3-18`, `${PREFIX}library-backup`, `${PREFIX}drafts`, `${PREFIX}session`, 'daily-cf-preview:other/repository:library', 'unrelated-session-state'];
    const entries = new Map([...obsolete, ...keep].map(name => [name, `original ${name}`]));
    entries.set(KEY, JSON.stringify(SETTINGS));
    const storage = browserStorage(entries);
    const { api } = await import('../src/bridge');
    expect((await api.bootstrap()).settings).toEqual(SETTINGS);
    for (const name of obsolete) expect(entries.has(name), name).toBe(false);
    for (const name of keep) expect(entries.get(name), name).toBe(name === KEY ? JSON.stringify(SETTINGS) : `original ${name}`);
    expect(storage.removeItem.mock.calls.map(([name]) => name).sort()).toEqual(obsolete.sort());
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('always requests remote days with no-store and never persists or falls back after a success', async () => {
    const entries = new Map([[KEY, JSON.stringify(SETTINGS)]]);
    const storage = browserStorage(entries);
    const response = (hint: string) => new Response(`| 1700 | [CF773A](https://codeforces.com/problemset/problem/773/A) | ${hint} |`);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response('first')).mockResolvedValueOnce(response('changed'))
      .mockResolvedValueOnce(new Response('missing', { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const { api } = await import('../src/bridge');
    expect((await api.getDay('2024-03-18')).problems[0].hint).toBe('first');
    expect((await api.getDay('2024-03-18')).problems[0].hint).toBe('changed');
    await expect(api.getDay('2024-03-18')).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, options] of fetcher.mock.calls) expect(options?.cache).toBe('no-store');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect([...entries.keys()]).toEqual([KEY]);
  });
});
