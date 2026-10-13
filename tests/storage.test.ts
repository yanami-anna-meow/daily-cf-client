import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, linkSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore, type Encryption } from '../electron/storage';
import type { ColorPalette, Settings } from '../shared/types';
import { createDefaultPalettes, resolveAccentColor } from '../shared/appearance';

const PREFERENCES: Settings = {
  clientId: 'saved_client', language: 'rs', uiLanguage: 'en', theme: 'dark',
  forkRepository: 'sample/personal-fork', prTitleTemplate: 'Solutions {{count}}', prBodyTemplate: '{{files}}\n\n{{notes}}',
};
const PALETTE_INPUT = {
  id: 'evening-study', name: '  Evening study  ',
  light: { primary: '#AbC', background: '#FFF', surface: '#F1E2D3', text: '#123', extra: 'discard me' },
  dark: { primary: '#DEF', background: '#102030', surface: '#234', text: '#FEDCBA', extra: 'discard me' },
  extra: 'discard me',
};
const LEGACY_PALETTE: ColorPalette = {
  id: 'evening-study', name: 'Evening study',
  light: { primary: '#aabbcc', background: '#ffffff', surface: '#f1e2d3', text: '#112233' },
  dark: { primary: '#ddeeff', background: '#102030', surface: '#223344', text: '#fedcba' },
};
const NORMALIZED_PALETTE: ColorPalette = {
  ...LEGACY_PALETTE,
  light: { ...LEGACY_PALETTE.light, accent: resolveAccentColor(LEGACY_PALETTE.light) },
  dark: { ...LEGACY_PALETTE.dark, accent: resolveAccentColor(LEGACY_PALETTE.dark) },
};
function palette(id: string, name = id): ColorPalette {
  return { ...NORMALIZED_PALETTE, id, name, light: { ...NORMALIZED_PALETTE.light }, dark: { ...NORMALIZED_PALETTE.dark } };
}
function seededSettings(): Settings {
  const palettes = createDefaultPalettes('en');
  return { ...PREFERENCES, palettes, paletteId: palettes[0].id };
}

const fault = vi.hoisted(() => ({ temporaryWrite: false, rename: false, removeLibrary: false, collidingTemporary: '' }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (fault.collidingTemporary && String(args[0]).endsWith('.tmp')) actual.linkSync(fault.collidingTemporary, String(args[0]));
      return actual.openSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fault.temporaryWrite && typeof args[0] === 'number') {
        actual.writeFileSync(args[0], 'incomplete write');
        throw new Error('Simulated disk full');
      }
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (fault.rename && String(args[0]).endsWith('.tmp')) throw new Error('Simulated rename failure');
      return actual.renameSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (fault.removeLibrary && String(args[0]).endsWith('library.json')) throw new Error('Simulated removal failure');
      return actual.unlinkSync(...args);
    },
  };
});

function encryption(available = true, backend = 'test_keychain'): Encryption {
  // A reversible test double, not the application's encryption implementation.
  const transform = (value: Buffer): Buffer => Buffer.from(value.map(byte => byte ^ 0xa5));
  return {
    isEncryptionAvailable: vi.fn(() => available),
    getSelectedStorageBackend: vi.fn(() => backend),
    encryptString: vi.fn(value => transform(Buffer.from(value, 'utf8'))),
    decryptString: vi.fn(value => transform(value).toString('utf8')),
  };
}

describe('LocalStore', () => {
  let directory: string;
  beforeEach(() => {
    fault.temporaryWrite = false;
    fault.rename = false;
    fault.removeLibrary = false;
    fault.collidingTemporary = '';
    directory = mkdtempSync(join(tmpdir(), 'daily-cf-storage-test-'));
  });
  afterEach(() => {
    fault.temporaryWrite = false;
    fault.rename = false;
    fault.removeLibrary = false;
    fault.collidingTemporary = '';
    const target = resolve(directory);
    // Remove only the temporary directory created by this test.
    if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(target).startsWith('daily-cf-storage-test-')) {
      throw new Error('Unexpected test cleanup path');
    }
    rmSync(target, { recursive: true, force: true });
  });

  it('persists and restores only settings, without a draft or submission ledger', () => {
    const store = new LocalStore(directory, encryption(), 'build_client');
    expect(store.data.settings.paletteId).toBe('green');
    expect(store.data.settings.palettes?.map(palette => palette.id)).toEqual(['green', 'pink', 'blue', 'mono']);
    store.data.settings.language = 'py';
    store.persist();
    const restored = new LocalStore(directory, encryption(), 'build_client');
    expect(restored.data).toEqual(store.data);
    expect(Object.keys(restored.data)).toEqual(['settings']);
    expect(readdirSync(directory)).toEqual(['data.json']);
  });

  it('persists the shared PR templates inside the validated settings whitelist', () => {
    const store = new LocalStore(directory, encryption());
    store.data.settings.prTitleTemplate = 'Solutions {{count}}';
    store.data.settings.prBodyTemplate = '{{files}}\n\n{{notes}}';
    store.persist();
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(store.data.settings);
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8'))).toEqual({ settings: store.data.settings });
  });

  it('persists palette creation, edits, selection and deletion without touching the encrypted session', () => {
    const crypto = encryption();
    const store = new LocalStore(directory, crypto);
    store.saveToken('fixture_session_for_palette_roundtrip');
    const session = readFileSync(join(directory, 'session.enc'));
    const defaults = createDefaultPalettes();
    const added = palette('my-reading-room', 'Reading room');
    const editedSeed = { ...defaults[0], name: 'My renamed palette', dark: { ...defaults[0].dark, primary: '#123456' } };
    const editedAdded = { ...added, name: 'Evening reading', light: { ...added.light, surface: '#abcdef' } };
    const steps: Settings[] = [
      { ...PREFERENCES, palettes: defaults, paletteId: defaults[0].id },
      { ...PREFERENCES, palettes: [...defaults, added], paletteId: added.id },
      { ...PREFERENCES, palettes: [editedSeed, ...defaults.slice(1), editedAdded], paletteId: editedSeed.id },
      { ...PREFERENCES, palettes: [editedAdded], paletteId: editedAdded.id },
      { ...PREFERENCES, palettes: [editedAdded, palette('replacement')], paletteId: 'replacement' },
      { ...PREFERENCES, palettes: [palette('replacement')], paletteId: 'replacement' },
    ];
    for (const expected of steps) {
      store.data.settings = expected;
      store.persist();
      const restored = new LocalStore(directory, crypto);
      expect(restored.data.settings).toEqual(expected);
      expect(restored.warning).toBeUndefined();
      expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8'))).toEqual({ settings: expected });
      expect(readFileSync(join(directory, 'session.enc'))).toEqual(session);
    }
    expect(new LocalStore(directory, crypto).loadToken()).toBe('fixture_session_for_palette_roundtrip');
    expect(crypto.encryptString).toHaveBeenCalledTimes(1);
  });

  it.each(['light', 'dark', 'system'] as const)('keeps the same palette list and selection when saving %s mode', theme => {
    const store = new LocalStore(directory, encryption());
    const expected: Settings = { ...PREFERENCES, theme, palettes: [palette('first'), palette('chosen')], paletteId: 'chosen' };
    store.data.settings = expected;
    store.persist();
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(expected);
  });

  it('adds default palettes to old settings while preserving preferences and encrypted login', () => {
    const crypto = encryption();
    new LocalStore(directory, crypto).saveToken('fixture_preserved_session');
    const session = readFileSync(join(directory, 'session.enc'));
    const original = JSON.stringify({ settings: PREFERENCES });
    writeFileSync(join(directory, 'data.json'), original);
    const restored = new LocalStore(directory, crypto);
    const expected = seededSettings();

    expect(expected.paletteId).toBe('green');
    expect(restored.data.settings).toEqual(expected);
    expect(restored.warning).toBeUndefined();
    expect(readFileSync(join(directory, 'data.json'), 'utf8')).toBe(original);
    restored.persist();
    expect(new LocalStore(directory, crypto).data.settings).toEqual(expected);
    expect(readFileSync(join(directory, 'session.enc'))).toEqual(session);
    expect(crypto.encryptString).toHaveBeenCalledTimes(1);
  });

  it('preserves an existing pink selection and its saved colors when the initial default changes', () => {
    const crypto = encryption();
    const oldPink: ColorPalette = {
      id: 'pink', name: 'My pink',
      light: { primary: '#f8bed0', accent: '#b62d56', background: '#fff8fa', surface: '#ffffff', text: '#3b2e32' },
      dark: { primary: '#ffc4d4', accent: '#ffa8c0', background: '#211e20', surface: '#2b2729', text: '#f7ecef' },
    };
    const source: Settings = { ...PREFERENCES, palettes: [oldPink, palette('personal')], paletteId: 'pink' };
    const original = JSON.stringify({ settings: source });
    writeFileSync(join(directory, 'data.json'), original);
    const store = new LocalStore(directory, crypto);
    expect(store.data.settings).toEqual(source);
    expect(readFileSync(join(directory, 'data.json'), 'utf8')).toBe(original);
    store.persist();
    expect(new LocalStore(directory, crypto).data.settings).toEqual(source);
  });

  it('uses the first palette when saving or loading a list without a selected ID', () => {
    const source = { ...PREFERENCES, palettes: [palette('my-first'), palette('my-second')] };
    const expected = { ...source, paletteId: 'my-first' };
    writeFileSync(join(directory, 'data.json'), JSON.stringify({ settings: source }));
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(expected);
    const store = new LocalStore(directory, encryption());
    store.data.settings = source;
    store.persist();
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(expected);
  });

  it('seeds a settings save with no palette fields', () => {
    const store = new LocalStore(directory, encryption());
    store.data.settings = { ...PREFERENCES };
    store.persist();
    expect(store.data.settings).toEqual(seededSettings());
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(seededSettings());
  });

  it.each([null, {}, 'invalid', [], [null, { id: 'broken', name: 'Broken' }]].map(palettes => ({ palettes })))('recovers an unusable saved palette list without resetting other preferences (%j)', ({ palettes }) => {
    writeFileSync(join(directory, 'data.json'), JSON.stringify({ settings: { ...PREFERENCES, palettes, paletteId: 'missing' } }));
    const restored = new LocalStore(directory, encryption());
    expect(restored.data.settings).toEqual(seededSettings());
    expect(restored.warning).toBeUndefined();
    expect(readdirSync(directory).filter(name => name.startsWith('data-corrupt-'))).toEqual([]);
    restored.persist();
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(seededSettings());
  });

  it.each([
    { selected: 'evening-study', expectedId: 'evening-study' },
    { selected: 'broken', expectedId: 'surviving-first' },
    { selected: 'missing', expectedId: 'surviving-first' },
    { selected: 9, expectedId: 'surviving-first' },
  ])('recovers valid palette entries and resolves saved selection $selected', ({ selected, expectedId }) => {
    const first = palette('surviving-first');
    const broken = { ...palette('broken'), dark: { ...NORMALIZED_PALETTE.dark, text: 'not a color' } };
    writeFileSync(join(directory, 'data.json'), JSON.stringify({
      settings: { ...PREFERENCES, palettes: [broken, first, null, PALETTE_INPUT], paletteId: selected },
    }));
    const expected = { ...PREFERENCES, palettes: [first, NORMALIZED_PALETTE], paletteId: expectedId };
    const restored = new LocalStore(directory, encryption());
    expect(restored.data.settings).toEqual(expected);
    expect(restored.warning).toBeUndefined();
    restored.persist();
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(expected);
  });

  it('keeps the first valid entry for a duplicate ID and preserves other valid palettes', () => {
    const first = palette('duplicate', 'First valid palette');
    const later = { ...palette('duplicate', 'Later duplicate'), light: { ...NORMALIZED_PALETTE.light, primary: '#000000' } };
    const other = palette('other');
    writeFileSync(join(directory, 'data.json'), JSON.stringify({ settings: {
      ...PREFERENCES,
      palettes: [{ id: 'duplicate', name: 'Invalid entry before valid entry' }, first, later, other],
      paletteId: 'duplicate',
    } }));
    const restored = new LocalStore(directory, encryption());
    const expected = { ...PREFERENCES, palettes: [first, other], paletteId: 'duplicate' };
    expect(restored.data.settings).toEqual(expected);
    restored.persist();
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(expected);
  });

  it('normalizes names and colors and strips extra fields when saving palette entries', () => {
    const store = new LocalStore(directory, encryption());
    store.data.settings = { ...PREFERENCES, palettes: [PALETTE_INPUT], paletteId: PALETTE_INPUT.id };
    store.persist();
    const expected = { ...PREFERENCES, palettes: [NORMALIZED_PALETTE], paletteId: NORMALIZED_PALETTE.id };
    expect(store.data.settings).toEqual(expected);
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8'))).toEqual({ settings: expected });
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(expected);
  });

  it('fills legacy accent colors without changing the palette identity, selection, other colors or encrypted login', () => {
    const crypto = encryption();
    new LocalStore(directory, crypto).saveToken('fixture_session_for_accent_migration');
    const session = readFileSync(join(directory, 'session.enc'));
    const other = palette('other');
    const source: Settings = { ...PREFERENCES, palettes: [other, LEGACY_PALETTE], paletteId: LEGACY_PALETTE.id };
    const original = JSON.stringify({ settings: source });
    writeFileSync(join(directory, 'data.json'), original);

    const restored = new LocalStore(directory, crypto);
    const expected = { ...source, palettes: [other, NORMALIZED_PALETTE] };
    expect(restored.data.settings).toEqual(expected);
    expect(restored.warning).toBeUndefined();
    expect(readFileSync(join(directory, 'data.json'), 'utf8')).toBe(original);
    restored.persist();
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8'))).toEqual({ settings: expected });
    expect(new LocalStore(directory, crypto).data.settings).toEqual(expected);
    expect(readFileSync(join(directory, 'session.enc'))).toEqual(session);
    expect(crypto.encryptString).toHaveBeenCalledTimes(1);
  });

  it('normalizes explicit accents on startup and save while preserving the primary colors and other preferences', () => {
    const explicit = {
      ...NORMALIZED_PALETTE,
      light: { ...NORMALIZED_PALETTE.light, accent: '#0aF' },
      dark: { ...NORMALIZED_PALETTE.dark, accent: '#123ABC' },
    };
    const source: Settings = { ...PREFERENCES, palettes: [explicit], paletteId: explicit.id };
    const expected = {
      ...source,
      palettes: [{
        ...explicit,
        light: { ...explicit.light, accent: '#00aaff' },
        dark: { ...explicit.dark, accent: '#123abc' },
      }],
    };
    writeFileSync(join(directory, 'data.json'), JSON.stringify({ settings: source }));
    const store = new LocalStore(directory, encryption());
    expect(store.data.settings).toEqual(expected);
    store.data.settings = source;
    store.persist();
    expect(store.data.settings).toEqual(expected);
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8'))).toEqual({ settings: expected });
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(expected);
  });

  it.each([
    { mode: 'light', accent: 'red', selected: 'retained', expectedId: 'retained' },
    { mode: 'dark', accent: '#abcd', selected: 'broken', expectedId: 'first' },
  ] as const)('drops a palette with an invalid $mode accent and resolves selection $selected', ({ mode, accent, selected, expectedId }) => {
    const first = palette('first');
    const retained = palette('retained');
    const broken = { ...palette('broken'), [mode]: { ...NORMALIZED_PALETTE[mode], accent } };
    writeFileSync(join(directory, 'data.json'), JSON.stringify({ settings: {
      ...PREFERENCES, palettes: [first, broken, retained], paletteId: selected,
    } }));

    const restored = new LocalStore(directory, encryption());
    const expected = { ...PREFERENCES, palettes: [first, retained], paletteId: expectedId };
    expect(restored.data.settings).toEqual(expected);
    expect(restored.warning).toBeUndefined();
    expect(readdirSync(directory).filter(name => name.startsWith('data-corrupt-'))).toEqual([]);
    restored.persist();
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(expected);
  });

  it('persists the complete supported palette list without truncating entries', () => {
    const palettes = Array.from({ length: 100 }, (_, index) => palette(`palette_${index}`));
    const expected = { ...PREFERENCES, palettes, paletteId: palettes[99].id };
    const store = new LocalStore(directory, encryption());
    store.data.settings = expected;
    store.persist();
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(expected);
  });

  it.each([
    { label: 'empty list', invalid: { palettes: [] } },
    { label: 'missing selected ID', invalid: { paletteId: 'not-in-the-list' } },
    { label: 'duplicate ID', invalid: { palettes: [palette('kept'), palette('kept')] } },
    { label: 'blank name', invalid: { palettes: [{ ...palette('kept'), name: '   ' }] } },
    { label: 'invalid color', invalid: { palettes: [{ ...palette('kept'), dark: { ...NORMALIZED_PALETTE.dark, primary: '#abcd' } }] } },
    { label: 'invalid light accent', invalid: { palettes: [{ ...palette('kept'), light: { ...NORMALIZED_PALETTE.light, accent: 'red' } }] } },
    { label: 'invalid dark accent', invalid: { palettes: [{ ...palette('kept'), dark: { ...NORMALIZED_PALETTE.dark, accent: '#abcd' } }] } },
    { label: 'too many palettes', invalid: { palettes: Array.from({ length: 101 }, (_, index) => palette(`palette_${index}`)), paletteId: 'palette_0' } },
  ])('rejects $label without replacing saved settings or session', ({ invalid }) => {
    const crypto = encryption();
    const store = new LocalStore(directory, crypto);
    const savedSettings: Settings = { ...PREFERENCES, palettes: [palette('kept')], paletteId: 'kept' };
    store.data.settings = savedSettings;
    store.saveToken('fixture_session_for_invalid_save');
    store.persist();
    const saved = readFileSync(join(directory, 'data.json'), 'utf8');
    const session = readFileSync(join(directory, 'session.enc'));
    store.data.settings = { ...savedSettings, theme: 'light', uiLanguage: 'zh-CN', ...invalid } as unknown as Settings;

    expect(() => store.persist()).toThrow();
    expect(readFileSync(join(directory, 'data.json'), 'utf8')).toBe(saved);
    expect(new LocalStore(directory, crypto).data.settings).toEqual(savedSettings);
    expect(readFileSync(join(directory, 'session.enc'))).toEqual(session);
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['temporaryWrite', 'rename'] as const)('preserves palettes and encrypted login when %s fails', failure => {
    const crypto = encryption();
    const store = new LocalStore(directory, crypto);
    const savedSettings = { ...PREFERENCES, palettes: [palette('saved')], paletteId: 'saved' };
    store.data.settings = savedSettings;
    store.saveToken('fixture_session_for_failed_write');
    store.persist();
    const saved = readFileSync(join(directory, 'data.json'), 'utf8');
    const session = readFileSync(join(directory, 'session.enc'));
    const changed = { ...PREFERENCES, palettes: [palette('replacement')], paletteId: 'replacement' };
    store.data.settings = changed;
    fault[failure] = true;

    expect(() => store.persist()).toThrow('Simulated');
    expect(readFileSync(join(directory, 'data.json'), 'utf8')).toBe(saved);
    expect(readFileSync(join(directory, 'session.enc'))).toEqual(session);
    expect(new LocalStore(directory, crypto).data.settings).toEqual(savedSettings);
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
    fault[failure] = false;
    store.persist();
    expect(new LocalStore(directory, crypto).data.settings).toEqual(changed);
    expect(readFileSync(join(directory, 'session.enc'))).toEqual(session);
  });

  it('does not overwrite saved settings with an oversized shared template', () => {
    const store = new LocalStore(directory, encryption());
    store.data.settings.prTitleTemplate = 'Valid title';
    store.persist();
    const saved = readFileSync(join(directory, 'data.json'), 'utf8');
    store.data.settings.prBodyTemplate = 'x'.repeat(60001);
    expect(() => store.persist()).toThrow('PR 正文模板');
    expect(readFileSync(join(directory, 'data.json'), 'utf8')).toBe(saved);
    expect(new LocalStore(directory, encryption()).data.settings.prTitleTemplate).toBe('Valid title');
  });

  it('refuses to persist code or ledger fields added to runtime data', () => {
    const store = new LocalStore(directory, encryption());
    Object.assign(store.data, { drafts: [{ code: 'must stay in memory' }], history: [{ number: 42 }], code: 'unsaved code' });
    Object.assign(store.data.settings, { code: 'also unsaved', token: 'never persisted here' });
    store.persist();
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8'))).toEqual({ settings: store.data.settings });
    expect(Object.keys(store.data)).toEqual(['settings']);
    const serialized = readFileSync(join(directory, 'data.json'), 'utf8');
    for (const field of ['drafts', 'history', 'code', 'token']) expect(serialized).not.toContain(field);
  });

  it('ignores old drafts and local history, preserving their original file only once before migration', () => {
    const legacy = JSON.stringify({ settings: { language: 'py' }, drafts: [{ code: 'old unfinished code' }], history: [{ number: 42 }] });
    writeFileSync(join(directory, 'data.json'), legacy);
    const store = new LocalStore(directory, encryption());
    expect(Object.keys(store.data)).toEqual(['settings']);
    expect(store.data.settings.language).toBe('py');
    expect(readFileSync(join(directory, 'data.json'), 'utf8')).toBe(legacy);
    expect(readdirSync(directory)).toEqual(['data.json']);
    store.data.settings.theme = 'dark';
    store.persist();
    const backups = readdirSync(directory).filter(name => /^data-legacy-[a-f0-9]+\.json$/.test(name));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(directory, backups[0]), 'utf8')).toBe(legacy);
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8'))).toEqual({ settings: store.data.settings });
    expect(new LocalStore(directory, encryption()).data.settings.theme).toBe('dark');
    store.persist();
    expect(readdirSync(directory).filter(name => name.startsWith('data-legacy-'))).toEqual(backups);
    // A repeated migration of the same original file reuses the exact backup.
    writeFileSync(join(directory, 'data.json'), legacy);
    new LocalStore(directory, encryption()).persist();
    expect(readdirSync(directory).filter(name => name.startsWith('data-legacy-'))).toEqual(backups);
  });

  it('does not create legacy backups for empty removed-feature fields', () => {
    writeFileSync(join(directory, 'data.json'), JSON.stringify({ settings: {}, drafts: [], history: [] }));
    new LocalStore(directory, encryption()).persist();
    expect(readdirSync(directory)).toEqual(['data.json']);
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8'))).not.toHaveProperty('drafts');
  });

  it('keeps the old file intact if its migration backup cannot be written', () => {
    const legacy = JSON.stringify({ settings: {}, drafts: [{ code: 'irreplaceable old code' }] });
    writeFileSync(join(directory, 'data.json'), legacy);
    const store = new LocalStore(directory, encryption());
    fault.temporaryWrite = true;
    expect(() => store.persist()).toThrow('Simulated');
    expect(readFileSync(join(directory, 'data.json'), 'utf8')).toBe(legacy);
    fault.temporaryWrite = false;
    store.persist();
    const backup = readdirSync(directory).find(name => /^data-legacy-.*\.json$/.test(name));
    expect(backup).toBeDefined();
    expect(readFileSync(join(directory, backup!), 'utf8')).toBe(legacy);
  });

  it('keeps an explicit user Client ID and fills an empty saved one from the packaged default', () => {
    const store = new LocalStore(directory, encryption(), 'packaged_client');
    store.data.settings.clientId = 'personal_client';
    store.persist();
    expect(new LocalStore(directory, encryption(), 'new_packaged_client').data.settings.clientId).toBe('personal_client');
    store.data.settings.clientId = '';
    store.persist();
    expect(new LocalStore(directory, encryption(), 'new_packaged_client').data.settings.clientId).toBe('new_packaged_client');
  });

  it('migrates the obsolete default author and remote data without changing other settings or encrypted login', () => {
    const crypto = encryption();
    const initial = new LocalStore(directory, crypto);
    initial.saveToken('ghp_preserved_session');
    writeFileSync(join(directory, 'day-2024-03-18.json'), JSON.stringify({ date: '2024-03-18', problems: [] }));
    const credential = readFileSync(join(directory, 'session.enc'));
    const settings = { clientId: 'configured_client', language: 'py', uiLanguage: 'system', theme: 'dark', palettes: createDefaultPalettes(), paletteId: createDefaultPalettes()[0].id, forkRepository: 'sample/renamed-fork', prTitleTemplate: 'Solutions', prBodyTemplate: '{{files}}' };
    writeFileSync(join(directory, 'data.json'), JSON.stringify({ settings: { ...settings, author: 'old_default' } }));

    const migrated = new LocalStore(directory, crypto);
    expect(migrated.data.settings).toEqual(settings);
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8'))).toEqual({ settings });
    expect(migrated.loadToken()).toBe('ghp_preserved_session');
    expect(readFileSync(join(directory, 'session.enc'))).toEqual(credential);
    expect(existsSync(join(directory, 'day-2024-03-18.json'))).toBe(false);
    expect(readdirSync(directory).filter(name => name.startsWith('data-legacy-'))).toEqual([]);
  });

  it('preserves old authored code in its original backup when migrating a default author', () => {
    const original = JSON.stringify({ settings: { author: 'old_default', theme: 'dark' }, drafts: [{ code: 'previously authored code' }], history: [{ number: 42 }] });
    writeFileSync(join(directory, 'data.json'), original);
    const oldBackup = join(directory, 'data-legacy-existing.json');
    writeFileSync(oldBackup, 'previous archived user data');

    const migrated = new LocalStore(directory, encryption());
    expect(migrated.data.settings).not.toHaveProperty('author');
    expect(migrated.data.settings.theme).toBe('dark');
    const backups = readdirSync(directory).filter(name => /^data-legacy-[a-f0-9]{16}\.json$/.test(name));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(directory, backups[0]), 'utf8')).toBe(original);
    expect(readFileSync(oldBackup, 'utf8')).toBe('previous archived user data');
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8'))).toEqual({ settings: migrated.data.settings });
  });

  it('keeps active settings normalized and the original file safe if author migration cannot be written', () => {
    const original = JSON.stringify({ settings: { author: 'old_default', language: 'py' } });
    writeFileSync(join(directory, 'data.json'), original);
    fault.temporaryWrite = true;
    const migrated = new LocalStore(directory, encryption());
    expect(migrated.data.settings).not.toHaveProperty('author');
    expect(migrated.data.settings.language).toBe('py');
    expect(migrated.warning).toContain('迁移暂时无法保存');
    expect(readFileSync(join(directory, 'data.json'), 'utf8')).toBe(original);
    expect(readdirSync(directory).filter(name => name.startsWith('data-corrupt-'))).toEqual([]);
    fault.temporaryWrite = false;
    migrated.persist();
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8')).settings).not.toHaveProperty('author');
  });

  it('stores only encrypted credentials and keeps them out of persisted application data', () => {
    const crypto = encryption();
    const store = new LocalStore(directory, crypto);
    const token = 'ghp_this_value_must_not_be_plaintext';
    store.saveToken(token);
    store.persist();
    expect(crypto.encryptString).toHaveBeenCalledWith(token);
    expect(readFileSync(join(directory, 'session.enc')).includes(Buffer.from(token))).toBe(false);
    expect(readFileSync(join(directory, 'data.json'), 'utf8')).not.toContain(token);
    expect(new LocalStore(directory, crypto).loadToken()).toBe(token);
  });

  it.each([[false, 'test_keychain'], [true, 'basic_text']] as const)(
    'does not persist or decrypt credentials when availability=%s, backend=%s', (available, backend) => {
      const crypto = encryption(available, backend);
      const store = new LocalStore(directory, crypto);
      expect(store.secure).toBe(false);
      store.saveToken('ghp_memory_only');
      expect(existsSync(join(directory, 'session.enc'))).toBe(false);
      expect(store.loadToken()).toBeUndefined();
      expect(crypto.encryptString).not.toHaveBeenCalled();
      expect(crypto.decryptString).not.toHaveBeenCalled();
    },
  );

  it('removes an old saved identity when a replacement login can only live in memory', () => {
    const secureCrypto = encryption();
    const secure = new LocalStore(directory, secureCrypto);
    secure.saveToken('ghp_old_account');
    const memoryOnly = new LocalStore(directory, encryption(true, 'basic_text'));
    memoryOnly.saveToken('ghp_new_account');
    expect(existsSync(join(directory, 'session.enc'))).toBe(false);
    expect(new LocalStore(directory, secureCrypto).loadToken()).toBeUndefined();
  });

  it('treats a missing backend getter as supported platform storage', () => {
    const crypto = encryption();
    delete crypto.getSelectedStorageBackend;
    const store = new LocalStore(directory, crypto);
    expect(store.secure).toBe(true);
    store.saveToken('ghp_windows_or_mac');
    expect(store.loadToken()).toBe('ghp_windows_or_mac');
  });

  it('reports unreadable encrypted state without returning ciphertext as a credential', () => {
    const crypto = encryption();
    const store = new LocalStore(directory, crypto);
    writeFileSync(join(directory, 'session.enc'), 'corrupt ciphertext');
    vi.mocked(crypto.decryptString).mockImplementation(() => { throw new Error('Decrypt failed'); });
    expect(store.loadToken()).toBeUndefined();
    expect(store.warning).toContain('无法解密');
    expect(readFileSync(join(directory, 'session.enc'), 'utf8')).toBe('corrupt ciphertext');
  });

  it('clears a saved session idempotently', () => {
    const store = new LocalStore(directory, encryption());
    store.saveToken('ghp_session');
    store.clearToken();
    store.clearToken();
    expect(store.loadToken()).toBeUndefined();
    expect(existsSync(join(directory, 'session.enc'))).toBe(false);
  });

  it.each([
    '{"settings":',
    JSON.stringify({ settings: null }),
    JSON.stringify({ settings: [] }),
    JSON.stringify({ settings: { language: 'invalid' } }),
    JSON.stringify([]),
  ])('preserves corrupt persisted input for recovery: %s', original => {
    writeFileSync(join(directory, 'data.json'), original);
    const store = new LocalStore(directory, encryption(), 'packaged_client');
    expect(Object.keys(store.data)).toEqual(['settings']);
    expect(store.warning).toContain('备份');
    const backups = readdirSync(directory).filter(name => /^data-corrupt-.*\.json$/.test(name));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(directory, backups[0]), 'utf8')).toBe(original);
    store.persist();
    expect(readFileSync(join(directory, backups[0]), 'utf8')).toBe(original);
    expect(new LocalStore(directory, encryption()).data.settings.clientId).toBe('packaged_client');
  });

  it.each(['temporaryWrite', 'rename'] as const)('preserves the last saved settings if %s fails midway', failure => {
    const store = new LocalStore(directory, encryption());
    store.data.settings.language = 'py';
    store.persist();
    const oldData = readFileSync(join(directory, 'data.json'), 'utf8');
    store.data.settings.language = 'rs';
    fault[failure] = true;
    expect(() => store.persist()).toThrow('Simulated');
    expect(readFileSync(join(directory, 'data.json'), 'utf8')).toBe(oldData);
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(new LocalStore(directory, encryption()).data.settings.language).toBe('py');
  });

  it('recovers normally after a failed temporary write and removes the completed temporary file', () => {
    const store = new LocalStore(directory, encryption());
    store.data.settings.language = 'py';
    store.persist();
    fault.temporaryWrite = true;
    expect(() => store.persist()).toThrow();
    fault.temporaryWrite = false;
    store.data.settings.language = 'go';
    store.persist();
    expect(new LocalStore(directory, encryption()).data.settings.language).toBe('go');
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['data.json', 'session.enc'] as const)('does not write through a pre-existing %s.tmp hard link', name => {
    const profile = join(directory, 'profile');
    const store = new LocalStore(profile, encryption());
    const outside = join(directory, 'outside-profile.txt');
    const content = 'This file is outside the application profile.';
    writeFileSync(outside, content);
    linkSync(outside, join(profile, `${name}.tmp`));
    if (name === 'data.json') { store.data.settings.theme = 'dark'; store.persist(); }
    else store.saveToken('encrypted_test_session');
    expect(readFileSync(outside, 'utf8')).toBe(content);
    expect(readFileSync(join(profile, `${name}.tmp`), 'utf8')).toBe(content);
    expect(readdirSync(profile).filter(file => file.endsWith('.tmp'))).toEqual([`${name}.tmp`]);
    if (name === 'data.json') expect(new LocalStore(profile, encryption()).data.settings.theme).toBe('dark');
    else expect(store.loadToken()).toBe('encrypted_test_session');
  });

  it.each(['data.json', 'session.enc'] as const)('replaces the %s directory entry without changing another hard-linked file', name => {
    const profile = join(directory, 'profile');
    const store = new LocalStore(profile, encryption());
    const outside = join(directory, 'outside-profile.txt');
    const content = 'Preserve the other hard link.';
    writeFileSync(outside, content);
    linkSync(outside, join(profile, name));
    if (name === 'data.json') store.persist();
    else store.saveToken('encrypted_test_session');
    expect(readFileSync(outside, 'utf8')).toBe(content);
    expect(readFileSync(join(profile, name), 'utf8')).not.toBe(content);
    expect(readdirSync(profile).filter(file => file.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves an unexpected colliding temporary file untouched when exclusive creation fails', () => {
    const store = new LocalStore(directory, encryption());
    store.persist();
    const original = readFileSync(join(directory, 'data.json'), 'utf8');
    const victim = join(directory, 'preserved.txt');
    writeFileSync(victim, 'Do not overwrite or unlink this file.');
    fault.collidingTemporary = victim;
    store.data.settings.theme = 'dark';
    expect(() => store.persist()).toThrow();
    expect(readFileSync(join(directory, 'data.json'), 'utf8')).toBe(original);
    expect(readFileSync(victim, 'utf8')).toBe('Do not overwrite or unlink this file.');
    const collision = readdirSync(directory).filter(name => name.endsWith('.tmp'));
    expect(collision).toHaveLength(1);
    expect(readFileSync(join(directory, collision[0]), 'utf8')).toBe('Do not overwrite or unlink this file.');
  });

  it('removes only known remote data and interrupted atomic writes from the profile root', () => {
    const removed = ['library.json', 'library.json.tmp', 'day-latest.json', 'day-latest.json.tmp', 'day-2024-02-29.json', 'day-0001-01-01.json.tmp', 'day-9999-12-31.json'];
    const preserved = ['day-2024-02-30.json', 'day-0000-01-01.json', 'day-2024-3-18.json', 'library.json.backup', 'library.json.tmp.tmp', 'settings.json', 'session.enc', 'session.enc.tmp', 'data.json.tmp', 'data-legacy-deadbeef.json', 'data-corrupt-123.json', 'other.json'];
    for (const name of [...removed, ...preserved]) writeFileSync(join(directory, name), `original ${name}`);
    const nested = join(directory, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'library.json'), 'nested content');
    mkdirSync(join(directory, 'day-2024-03-18.json'));
    writeFileSync(join(directory, 'day-2024-03-18.json', 'user-code.cpp'), 'authored code');
    const store = new LocalStore(directory, encryption());
    for (const name of removed) expect(existsSync(join(directory, name)), name).toBe(false);
    for (const name of preserved) expect(readFileSync(join(directory, name), 'utf8'), name).toBe(`original ${name}`);
    expect(readFileSync(join(nested, 'library.json'), 'utf8')).toBe('nested content');
    expect(readFileSync(join(directory, 'day-2024-03-18.json', 'user-code.cpp'), 'utf8')).toBe('authored code');
    expect(store).not.toHaveProperty('readCache');
    expect(store).not.toHaveProperty('writeCache');
    expect(store.warning).toBeUndefined();
    expect(new LocalStore(directory, encryption()).warning).toBeUndefined();
  });

  it('reports a failed legacy cleanup and still removes other known remote data', () => {
    writeFileSync(join(directory, 'library.json'), '{broken old data');
    writeFileSync(join(directory, 'day-latest.json'), 'old day');
    fault.removeLibrary = true;
    const store = new LocalStore(directory, encryption());
    expect(store.warning).toContain('旧版远端数据文件未能全部清理');
    expect(existsSync(join(directory, 'library.json'))).toBe(true);
    expect(existsSync(join(directory, 'day-latest.json'))).toBe(false);
    store.persist();
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8'))).toEqual({ settings: store.data.settings });
    fault.removeLibrary = false;
    expect(new LocalStore(directory, encryption()).warning).toBeUndefined();
    expect(existsSync(join(directory, 'library.json'))).toBe(false);
  });
});
