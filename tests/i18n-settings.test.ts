import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { Encryption } from '../electron/storage';
import type { Settings } from '../shared/types';
import { createDefaultPalettes } from '../shared/appearance';

const preferences = ['system', 'zh-CN', 'en'] as const;
const baseSettings = { clientId: 'test_client', language: 'py', theme: 'dark', palettes: createDefaultPalettes('zh-CN'), paletteId: 'pink' } as const;
let directory: string;

function encryption(): Encryption {
  // This reversible double keeps these tests independent of an OS keychain.
  const transform = (value: Buffer) => Buffer.from(value.map(byte => byte ^ 0xa5));
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test_keychain',
    encryptString: value => transform(Buffer.from(value, 'utf8')),
    decryptString: value => transform(value).toString('utf8'),
  };
}

async function browserPreview(options: { saved?: unknown; languages?: string[] } = {}) {
  const { UPSTREAM } = await import('../shared/types');
  const settingsKey = `daily-cf-preview:${UPSTREAM.owner}/${UPSTREAM.repo}:settings`;
  const entries = new Map<string, string>();
  if (options.saved !== undefined) entries.set(settingsKey, JSON.stringify(options.saved));
  const fault = { write: false };
  const storage = {
    get length() { return entries.size; },
    key: vi.fn((index: number) => [...entries.keys()][index] ?? null),
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      if (fault.write) throw new Error('Simulated localStorage write failure');
      entries.set(key, value);
    }),
    removeItem: vi.fn((key: string) => { entries.delete(key); }),
    clear: vi.fn(() => entries.clear()),
  };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', { languages: options.languages ?? ['zh-CN'], language: options.languages?.[0] ?? 'zh-CN' });
  const fetcher = vi.fn(() => Promise.reject(new Error('Settings tests must not make network requests')));
  vi.stubGlobal('fetch', fetcher);
  const { api } = await import('../src/bridge');
  const i18n = await import('../shared/i18n');
  return { api, i18n, entries, storage, fault, settingsKey, fetcher };
}

beforeEach(() => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), 'daily-cf-i18n-settings-test-'));
});

afterEach(async () => {
  const { setLocale } = await import('../shared/i18n');
  setLocale('zh-CN');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const target = resolve(directory);
  if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(target).startsWith('daily-cf-i18n-settings-test-')) {
    throw new Error('Unexpected i18n settings test cleanup path');
  }
  rmSync(target, { recursive: true, force: true });
});

describe('interface language settings validation', () => {
  it('normalizes missing interface language to system without changing the programming language', async () => {
    const { settingsInput } = await import('../electron/guards');
    for (const language of ['cpp', 'py', 'rs'] as const) {
      expect(settingsInput({ ...baseSettings, language })).toEqual({ ...baseSettings, language, uiLanguage: 'system' });
    }
  });

  it('accepts each explicit preference and keeps unrelated fields inside the existing whitelist', async () => {
    const { settingsInput } = await import('../electron/guards');
    for (const uiLanguage of preferences) {
      expect(settingsInput({ ...baseSettings, uiLanguage, token: 'not-a-setting', unknown: true })).toEqual({ ...baseSettings, uiLanguage });
    }
  });

  it('rejects null, unsupported locale names, numbers, and object values rather than silently defaulting', async () => {
    const { settingsInput } = await import('../electron/guards');
    for (const uiLanguage of [null, '', 'zh', 'en-US', 'fr', 0, 1, true, {}, [], ['en']]) {
      expect(() => settingsInput({ ...baseSettings, uiLanguage })).toThrow();
    }
    expect(() => settingsInput({ ...baseSettings, language: 'en', uiLanguage: 'en' })).toThrow();
  });

  it('uses an English guard error after switching the interface locale to English', async () => {
    const { settingsInput } = await import('../electron/guards');
    const { setLocale } = await import('../shared/i18n');
    setLocale('en');
    let caught: unknown;
    try { settingsInput({ ...baseSettings, uiLanguage: 'fr' }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/language|locale|setting/i);
    expect((caught as Error).message).not.toMatch(/[\u3400-\u9fff]/);
  });

  it('localizes palette validation without changing the stored palette or brightness', async () => {
    const { settingsInput } = await import('../electron/guards');
    const { setLocale } = await import('../shared/i18n');
    setLocale('en');
    expect(() => settingsInput({ ...baseSettings, paletteId: 'missing' })).toThrow('Select a palette from the list.');
    expect(() => settingsInput({ ...baseSettings, palettes: null })).toThrow('The palette list must contain 1–100 palettes.');
    const invalidAccent = [{ ...baseSettings.palettes[0], light: { ...baseSettings.palettes[0].light, accent: null } }];
    expect(() => settingsInput({ ...baseSettings, palettes: invalidAccent })).toThrow('The palette colors are invalid.');
    expect(settingsInput({ ...baseSettings, uiLanguage: 'en', paletteId: 'blue' })).toEqual({ ...baseSettings, uiLanguage: 'en', paletteId: 'blue' });
    setLocale('zh-CN');
    expect(() => settingsInput({ ...baseSettings, paletteId: 'missing' })).toThrow('请选择列表中的配色方案。');
    expect(() => settingsInput({ ...baseSettings, palettes: null })).toThrow('配色方案列表须包含 1 至 100 个方案。');
    expect(() => settingsInput({ ...baseSettings, palettes: invalidAccent })).toThrow('配色方案颜色设置不正确。');
  });

  it('seeds names in the selected language only when the palette list is absent', async () => {
    const { settingsInput } = await import('../electron/guards');
    const legacy = { ...baseSettings, palettes: undefined, paletteId: undefined, uiLanguage: 'en' as const };
    const english = settingsInput(legacy);
    expect(english.palettes).toEqual(createDefaultPalettes('en'));
    const renamed = english.palettes!.map((palette, index) => index ? palette : { ...palette, name: '我取的名字' });
    expect(settingsInput({ ...english, palettes: renamed, uiLanguage: 'zh-CN' }).palettes).toEqual(renamed);
  });
});

describe('stored interface language migration', () => {
  it('defaults a new store to system and writes that preference explicitly', async () => {
    const { LocalStore, DEFAULT_SETTINGS } = await import('../electron/storage');
    expect(DEFAULT_SETTINGS.uiLanguage).toBe('system');
    const store = new LocalStore(directory, encryption());
    expect(store.data.settings.uiLanguage).toBe('system');
    store.persist();
    expect(JSON.parse(readFileSync(join(directory, 'data.json'), 'utf8')).settings.uiLanguage).toBe('system');
  });

  it('normalizes an old settings file in memory and adds system on its next save', async () => {
    const { LocalStore } = await import('../electron/storage');
    const original = JSON.stringify({ settings: baseSettings });
    const file = join(directory, 'data.json');
    writeFileSync(file, original);

    const store = new LocalStore(directory, encryption());
    expect(store.data.settings).toEqual({ ...baseSettings, uiLanguage: 'system' });
    expect(store.warning).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readdirSync(directory)).toEqual(['data.json']);

    store.persist();
    expect(JSON.parse(readFileSync(file, 'utf8')).settings).toEqual({ ...baseSettings, uiLanguage: 'system' });
    expect(new LocalStore(directory, encryption()).data.settings).toEqual(store.data.settings);
  });

  it('restores and persists all supported explicit preferences independently of code language', async () => {
    const { LocalStore } = await import('../electron/storage');
    for (const uiLanguage of preferences) {
      writeFileSync(join(directory, 'data.json'), JSON.stringify({ settings: { ...baseSettings, uiLanguage } }));
      const store = new LocalStore(directory, encryption());
      expect(store.data.settings).toEqual({ ...baseSettings, uiLanguage });
      store.data.settings.language = 'go';
      store.persist();
      expect(new LocalStore(directory, encryption()).data.settings).toEqual({ ...baseSettings, language: 'go', uiLanguage });
    }
  });

  it('preserves corrupt locale data in a backup and retains the encrypted login while using defaults', async () => {
    const { LocalStore, DEFAULT_SETTINGS } = await import('../electron/storage');
    const crypto = encryption();
    for (const [index, uiLanguage] of [null, 42, 'unsupported'].entries()) {
      const testDirectory = join(directory, `invalid-${index}`);
      mkdirSync(testDirectory);
      const originalStore = new LocalStore(testDirectory, crypto);
      originalStore.saveToken('ghp_i18n_test_preserved_login');
      const credentialFile = join(testDirectory, 'session.enc');
      const credential = readFileSync(credentialFile);
      const original = JSON.stringify({ settings: { ...baseSettings, uiLanguage } });
      writeFileSync(join(testDirectory, 'data.json'), original);

      const restored = new LocalStore(testDirectory, crypto);
      expect(restored.data.settings).toEqual(DEFAULT_SETTINGS);
      expect(restored.warning).toBeTruthy();
      const backups = readdirSync(testDirectory).filter(name => /^data-corrupt-.*\.json$/.test(name));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(testDirectory, backups[0]), 'utf8')).toBe(original);
      expect(restored.loadToken()).toBe('ghp_i18n_test_preserved_login');
      expect(readFileSync(credentialFile)).toEqual(credential);

      restored.persist();
      expect(JSON.parse(readFileSync(join(testDirectory, 'data.json'), 'utf8')).settings.uiLanguage).toBe('system');
      expect(readFileSync(join(testDirectory, backups[0]), 'utf8')).toBe(original);
      expect(readFileSync(credentialFile)).toEqual(credential);
    }
  });

  it('translates stored warning keys at read time so an existing warning follows a language change', async () => {
    const { LocalStore } = await import('../electron/storage');
    const { setLocale } = await import('../shared/i18n');
    writeFileSync(join(directory, 'data.json'), '{invalid');
    const store = new LocalStore(directory, encryption());
    expect(store.warning).toContain('本地数据文件无法读取');
    setLocale('en');
    expect(store.warning).toContain('The local data file could not be read');
    expect(store.warning).not.toMatch(/[\u3400-\u9fff]/);
    setLocale('zh-CN');
    expect(store.warning).toContain('本地数据文件无法读取');
  });
});

describe('browser preview interface language', () => {
  it('uses system language for first-run names and saved language for legacy names', async () => {
    const initial = await browserPreview({ languages: ['en-US'] });
    expect((await initial.api.bootstrap()).settings.palettes).toEqual(createDefaultPalettes('en'));
    vi.resetModules();
    const legacy = await browserPreview({ saved: { ...baseSettings, palettes: undefined, paletteId: undefined, uiLanguage: 'zh-CN' }, languages: ['en-US'] });
    const boot = await legacy.api.bootstrap();
    expect(boot.settings.palettes).toEqual(createDefaultPalettes('zh-CN'));
    await legacy.api.saveSettings({ ...boot.settings, uiLanguage: 'en' });
    expect((await legacy.api.bootstrap()).settings.palettes).toEqual(createDefaultPalettes('zh-CN'));
  });

  it('exposes navigator language preferences at bootstrap and resolves system language in their order', async () => {
    const languages = ['en-US', 'zh-CN'];
    const { api, i18n, fetcher } = await browserPreview({ languages });
    const boot = await api.bootstrap();
    expect(boot.settings.uiLanguage).toBe('system');
    expect(boot.systemLanguages).toEqual(languages);
    expect(i18n.getLocale()).toBe('en');
    expect(i18n.resolveLocale('system', ['zh-CN', 'en-US'])).toBe('zh-CN');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('normalizes legacy preview settings and preserves the programming language', async () => {
    const { api, i18n, entries, settingsKey } = await browserPreview({ saved: baseSettings, languages: ['en-GB'] });
    const boot = await api.bootstrap();
    expect(boot.settings).toEqual({ ...baseSettings, uiLanguage: 'system' });
    expect(i18n.getLocale()).toBe('en');
    await api.saveSettings(boot.settings);
    expect(JSON.parse(entries.get(settingsKey)!)).toEqual({ ...baseSettings, uiLanguage: 'system' });
  });

  it('honors an explicit saved locale over navigator preferences', async () => {
    const { api, i18n } = await browserPreview({ saved: { ...baseSettings, uiLanguage: 'zh-CN' }, languages: ['en-US'] });
    expect((await api.bootstrap()).settings).toEqual({ ...baseSettings, uiLanguage: 'zh-CN' });
    expect(i18n.getLocale()).toBe('zh-CN');
  });

  it('switches language immediately after saving and resolves a later system selection without restarting', async () => {
    const { api, i18n, entries, settingsKey, fetcher } = await browserPreview({ languages: ['zh-CN', 'en-US'] });
    await api.bootstrap();
    expect(i18n.getLocale()).toBe('zh-CN');
    expect(await api.saveSettings({ ...baseSettings, uiLanguage: 'en' })).toEqual({ ...baseSettings, uiLanguage: 'en' });
    expect(i18n.getLocale()).toBe('en');
    expect(JSON.parse(entries.get(settingsKey)!)).toEqual({ ...baseSettings, uiLanguage: 'en' });
    expect((await api.bootstrap()).settings.uiLanguage).toBe('en');

    await api.saveSettings({ ...baseSettings, uiLanguage: 'system' });
    expect(i18n.getLocale()).toBe('zh-CN');
    expect((await api.bootstrap()).settings).toEqual({ ...baseSettings, uiLanguage: 'system' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps both current language and settings when localStorage rejects a language change', async () => {
    const saved = { ...baseSettings, uiLanguage: 'zh-CN' } as const;
    const { api, i18n, fault, entries, settingsKey } = await browserPreview({ saved });
    await api.bootstrap();
    fault.write = true;

    await expect(api.saveSettings({ ...baseSettings, uiLanguage: 'en' })).rejects.toThrow('Simulated localStorage write failure');
    expect(i18n.getLocale()).toBe('zh-CN');
    expect((await api.bootstrap()).settings).toEqual(saved);
    expect(JSON.parse(entries.get(settingsKey)!)).toEqual(saved);
  });

  it('rejects invalid preview language before writing storage or changing the active locale', async () => {
    const saved = { ...baseSettings, uiLanguage: 'en' } as const;
    const { api, i18n, storage } = await browserPreview({ saved });
    await api.bootstrap();
    await expect(api.saveSettings({ ...baseSettings, uiLanguage: null } as unknown as Settings)).rejects.toThrow();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(i18n.getLocale()).toBe('en');
    expect((await api.bootstrap()).settings).toEqual(saved);
  });
});
