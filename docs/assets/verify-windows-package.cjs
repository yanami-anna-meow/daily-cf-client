// Packaged-runtime verification with isolated settings and restored clipboard.
// Run after npm run dist:win.
// No Forks, commits, or Pull Requests are created by this script.
const { _electron: electron } = require('playwright');
const asar = require('@electron/asar');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { verifyEmbeddedIcons, verifyNativeWindowIcon } = require('./verify-windows-icons.cjs');

const workspace = path.resolve(__dirname, '../..');
const manifest = require(path.join(workspace, 'package.json'));
const productName = manifest.build?.productName || manifest.productName || manifest.name;
const captureOnly = process.argv.includes('--capture-home-only');
const resumeNativeSource = process.argv.find(argument => argument.startsWith('--resume-native-close-from='))?.split('=').slice(1).join('=');
const localOnly = process.argv.includes('--local-only');
const oauthLayoutOnly = process.argv.includes('--oauth-layout-only');
const themeOnly = process.argv.includes('--theme-only');
const iconOnly = process.argv.includes('--icon-only');
const paletteResetOnly = process.argv.includes('--palette-reset-only');
const bootstrapOnly = process.argv.includes('--bootstrap-only');
const codeImportOnly = process.argv.includes('--code-import-only');
const presentationOnly = oauthLayoutOnly || themeOnly || iconOnly || paletteResetOnly || bootstrapOnly || codeImportOnly;
const verifyArchiveReuse = process.argv.includes('--verify-archive-reuse');
const verifyLibraryRepair = process.argv.includes('--verify-library-repair');

const remoteEvidenceSource = process.argv.find(argument => argument.startsWith('--remote-evidence='))?.split('=').slice(1).join('=');
const remoteSkipReason = process.argv.find(argument => argument.startsWith('--remote-repeat-skipped='))?.split('=').slice(1).join('=') || 'rate-limit';
const captureHome = captureOnly || process.argv.includes('--capture-home');
const executable = path.resolve(workspace, process.argv.slice(2).find(argument => !argument.startsWith('--')) || `release/win-unpacked/${productName}.exe`);
const archive = path.join(path.dirname(executable), 'resources/app.asar');
const reportFile = path.join(workspace, 'docs/windows-package-check.json');
const expectedRepository = 'Yawn-Sean/Daily_CF_Problems';
let verificationProgress = {};

async function verifyExternalProblemLink(application, page) {
  const expected = ['https://codeforces.com/problemset/problem/4/A', 'https://codeforces.com/gym/102307/problem/K',
    'http://www.codeforces.com/contest/4/problem/A?locale=en#statement'];
  await application.evaluate(({ shell }) => {
    globalThis.__externalProblemProbe = { original: shell.openExternal, calls: [] };
    shell.openExternal = async url => { globalThis.__externalProblemProbe.calls.push(url); };
  });
  try {
    for (const url of expected) await page.evaluate(url => window.dailyCF.openExternal(url), url);
    const invalidRejected = await page.evaluate(async () => {
      try { await window.dailyCF.openExternal('https://example.com/'); return false; }
      catch { return true; }
    });
    const nonCodeforcesHttpRejected = await page.evaluate(async () => {
      try { await window.dailyCF.openExternal('http://github.com/Yawn-Sean/Daily_CF_Problems'); return false; }
      catch { return true; }
    });
    const observed = await application.evaluate(({ BrowserWindow }) => ({
      calls: globalThis.__externalProblemProbe.calls,
      noHelperWindow: BrowserWindow.getAllWindows().length === 1,
    }));
    if (JSON.stringify(observed.calls) !== JSON.stringify(expected) || !observed.noHelperWindow || !invalidRejected || !nonCodeforcesHttpRejected) {
      throw new Error('External problem links were not handed to the guarded system-browser API as expected.');
    }
    return { passed: true, fixture: true, fixtureBoundary: 'shell.openExternal stub only',
      actualPreloadAndMainIPC: true, targetUrls: observed.calls, originalTargetPreserved: true,
      invalidHostRejected: invalidRejected, nonCodeforcesHttpRejected,
      noHelperWindow: observed.noHelperWindow, systemBrowserActuallyOpened: false, noWebsiteFetch: true };
  } finally {
    await application.evaluate(({ shell }) => {
      shell.openExternal = globalThis.__externalProblemProbe.original;
      delete globalThis.__externalProblemProbe;
    });
  }
}

function samePath(first, second) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(first) === normalize(second);
}

function verifyCurrentRendererBundle(files) {
  const assetNames = files.filter(name => name === '/dist/index.html' || /^\/dist\/assets\/.*\.(?:js|css)$/.test(name));
  if (!assetNames.includes('/dist/index.html') || !assetNames.some(name => name.endsWith('.js')) || !assetNames.some(name => name.endsWith('.css'))) {
    throw new Error('Packaged renderer entry point or assets are missing.');
  }
  const assets = assetNames.map(name => {
    const relative = name.slice(1);
    const current = fs.readFileSync(path.join(workspace, relative));
    const packed = asar.extractFile(archive, path.join(...relative.split('/')));
    if (!packed.equals(current)) throw new Error('Packaged renderer differs from the current production output: ' + relative);
    return { path: relative, bytes: packed.length, sha256: crypto.createHash('sha256').update(packed).digest('hex') };
  });
  return { passed: true, byteIdenticalToProductionOutput: true, assets };
}

async function verifyActualCodeImport(application, page, profile) {
  const directory = path.join(profile, 'code-import-fixtures');
  fs.mkdirSync(directory);
  const successes = [
    { name: 'solution.c', extension: 'c', language: 'c', code: '\uFEFFint main(void) { return 0; }\r\n' },
    { name: 'solution.cc', extension: 'cc', language: 'cpp', code: 'int main() { return 0; }\n' },
    { name: 'solution.cxx', extension: 'cxx', language: 'cpp', code: '// cxx\n' },
    { name: 'capital.C', extension: 'C', language: 'cpp', code: '// capital C\n' },
    { name: 'solution.custom', extension: 'custom', language: 'other', code: '<unknown>文本源码</unknown>\n' },
    { name: 'solution.d.ts', extension: 'd.ts', language: 'other', code: 'declare const answer: number;\n' },
  ];
  for (const item of successes) fs.writeFileSync(path.join(directory, item.name), item.code, 'utf8');
  const failures = [
    { name: 'malformed.custom', bytes: Buffer.from([0xc3, 0x28]), reason: 'invalid UTF-8' },
    { name: 'binary.custom', bytes: Buffer.from([65, 0, 66]), reason: 'NUL byte' },
    { name: 'large.custom', bytes: Buffer.alloc(256 * 1024 + 1, 65), reason: 'over 256 KiB' },
  ];
  for (const item of failures) fs.writeFileSync(path.join(directory, item.name), item.bytes);
  await application.evaluate(({ dialog }) => {
    globalThis.__codeImportProbe = { original: dialog.showOpenDialog, nextPath: null, calls: [] };
    dialog.showOpenDialog = async (_window, options) => {
      const probe = globalThis.__codeImportProbe;
      probe.calls.push({ extensions: options.filters?.flatMap(filter => filter.extensions), properties: options.properties });
      return probe.nextPath === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [probe.nextPath] };
    };
  });
  try {
    for (const item of successes) {
      await application.evaluate((_electron, filename) => { globalThis.__codeImportProbe.nextPath = filename; }, path.join(directory, item.name));
      const result = await page.evaluate(() => window.dailyCF.importCode());
      if (!result || result.name !== item.name || result.extension !== item.extension || result.language !== item.language || result.code !== item.code) {
        throw new Error('Actual packaged code import changed fixture contents or extension: ' + item.name + '; fixture result=' + JSON.stringify(result));
      }
    }
    for (const item of failures) {
      await application.evaluate((_electron, filename) => { globalThis.__codeImportProbe.nextPath = filename; }, path.join(directory, item.name));
      const result = await page.evaluate(async () => {
        try { await window.dailyCF.importCode(); return { rejected: false }; }
        catch (error) { return { rejected: true, message: String(error) }; }
      });
      if (!result.rejected) throw new Error('Actual packaged code import accepted ' + item.reason);
    }
    await application.evaluate(() => { globalThis.__codeImportProbe.nextPath = null; });
    if (await page.evaluate(() => window.dailyCF.importCode()) !== null) throw new Error('Import cancellation did not return null.');
    const calls = await application.evaluate(() => globalThis.__codeImportProbe.calls);
    if (calls.length !== successes.length + failures.length + 1 || calls.some(call => !call.extensions?.includes('*') || !call.properties?.includes('openFile'))) {
      throw new Error('The native import dialog did not allow all extensions.');
    }
    return { passed: true, actualPreloadAndMainIPC: true, actualFileReadAndDecode: true,
      fixtureBoundary: 'Only dialog.showOpenDialog returns owned temporary paths; native picker UI is not opened.',
      nativePickerOpened: false, preservedImports: successes.map(({ name, extension, language }) => ({ name, extension, language })),
      exactTextAndCasePreserved: true, rejected: failures.map(item => item.reason), cancelReturnsNull: true, allExtensionsSelectable: true };
  } finally {
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.__codeImportProbe.original;
      delete globalThis.__codeImportProbe;
    });
  }
}

function removeOwnedProfile(profile, temporaryRoot) {
  const resolved = path.resolve(profile);
  const relative = path.relative(temporaryRoot, resolved);
  if (!relative || path.isAbsolute(relative) || relative.startsWith('..')
    || !samePath(path.dirname(resolved), temporaryRoot)
    || !path.basename(resolved).startsWith('daily-cf-package-check-')
    || fs.lstatSync(resolved).isSymbolicLink()
    || !samePath(fs.realpathSync.native(resolved), resolved)) {
    throw new Error('Refusing to remove an unverified temporary profile path.');
  }
  fs.rmSync(resolved, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 });
}

async function verifyClipboard(application, page) {
  const marker = `Daily CF packaged clipboard check ${manifest.version} ${Date.now()}`;
  // Clipboard payloads remain exclusively in this temporary app's main-process memory.
  // Materialize every format before allowing the renderer to replace any content.
  try {
    await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      const snapshot = [];
      for (const item of await clipboard.read()) {
        const formats = {};
        for (const type of item.types) {
          const payload = await item.getType(type);
          formats[type] = type === 'electron application/bookmark'
            ? { title: payload.title, url: payload.url }
            : new Blob([await payload.arrayBuffer()], { type: payload.type });
        }
        snapshot.push(new ClipboardItem(formats));
      }
      globalThis.__dailyCFPackageClipboardState = snapshot;
    });
  } catch {
    throw new Error('Clipboard snapshot failed; the verification did not write to the clipboard.');
  }

  let copied = false;
  let restoration;
  try {
    await page.evaluate(text => window.dailyCF.copyText(text), marker);
    copied = await application.evaluate(async ({ clipboard }, text) => await clipboard.readText() === text, marker);
    if (!copied) throw new Error('Renderer clipboard IPC did not produce the exact system clipboard marker.');
  } finally {
    try {
      restoration = await application.evaluate(async ({ clipboard }, text) => {
        const snapshot = globalThis.__dailyCFPackageClipboardState;
        if (!Array.isArray(snapshot)) throw new Error('Clipboard snapshot is unavailable.');
        // Preserve new data if the user copied something during this brief check.
        if (await clipboard.readText() !== text) {
          delete globalThis.__dailyCFPackageClipboardState;
          return { restored: false, changedContentsPreserved: true };
        }
        if (snapshot.length) await clipboard.write(snapshot);
        else clipboard.clear();
        delete globalThis.__dailyCFPackageClipboardState;
        return { restored: true, changedContentsPreserved: false };
      }, marker);
    } catch {
      throw new Error('Clipboard verification could not restore the in-memory snapshot. No clipboard contents were written to disk.');
    }
  }
  return { passed: copied, snapshotMaterialized: true, ...restoration };
}

function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The isolated verification process did not exit.')), 10_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}

async function verifyInterfaceLanguage(application, page, contentDirectory) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel(/^界面语言/).selectOption('en');
  await page.locator('.page-heading').getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Latest problems', exact: true }).waitFor({ state: 'visible' });
  const stored = JSON.parse(fs.readFileSync(path.join(contentDirectory, 'data.json'), 'utf8'));
  if (stored.settings.uiLanguage !== 'en') throw new Error('English interface selection was not saved in the isolated profile.');
  const nativeEnglish = await application.evaluate(({ BrowserWindow, Menu }) => ({
    title: BrowserWindow.getAllWindows()[0].getTitle(),
    menuLabels: Menu.getApplicationMenu()?.items.map(item => item.label),
  }));
  if (nativeEnglish.title !== 'Yawn Sean’s Daily CF Problems'
    || !['File', 'Edit', 'View'].every(label => nativeEnglish.menuLabels?.includes(label))) {
    throw new Error('English interface selection did not update the native title and menu.');
  }
  // Reload this clean, saved window to check that bootstrap restores the persisted choice.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ state: 'visible' });
  const boot = await page.evaluate(() => window.dailyCF.bootstrap());
  if (boot.settings.uiLanguage !== 'en') throw new Error('English interface preference did not survive a renderer reload.');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  if (await page.getByLabel(/^Interface language/).inputValue() !== 'en') throw new Error('Reloaded settings did not show the saved English preference.');
  await page.getByLabel(/^Interface language/).selectOption('zh-CN');
  await page.locator('.page-heading').getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).waitFor({ state: 'visible' });
  const restored = await page.evaluate(() => window.dailyCF.bootstrap());
  if (restored.settings.uiLanguage !== 'zh-CN') throw new Error('Chinese interface preference was not restored before native-close verification.');
  return { passed: true, englishUI: true, persistedToIsolatedProfile: true, retainedAfterRendererReload: true,
    nativeEnglish, restoredChinese: true, systemLanguageMetadata: boot.systemLanguages };
}

async function verifyOAuthSettingsWarning(page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const advanced = page.locator('.advanced-settings');
  const summary = advanced.locator('summary');
  if (!(await summary.textContent()).includes('谨慎修改')) throw new Error('The OAuth settings summary has no caution label.');
  if (!(await advanced.evaluate(element => element.open))) await summary.click();
  await page.locator('#oauth-settings-warning').waitFor({ state: 'visible' });
  const input = advanced.locator('input');
  const original = await input.inputValue();
  const changed = original === 'Ov23PackageWarningFixture' ? 'Ov23OtherWarningFixture' : 'Ov23PackageWarningFixture';
  await input.fill(changed);
  await page.locator('.page-heading').getByRole('button', { name: '保存设置', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认更改 GitHub 登录配置？', exact: true });
  await confirmation.waitFor({ state: 'visible' });
  const values = await confirmation.locator('.oauth-change-values dd').allTextContents();
  if (values.length !== 2 || values[0] !== (original || '未配置') || values[1] !== changed) throw new Error('OAuth confirmation does not show the actual previous and edited IDs.');
  const beforeCancel = await page.evaluate(() => window.dailyCF.bootstrap());
  if (beforeCancel.settings.clientId !== original) throw new Error('OAuth settings were saved before confirmation.');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  if ((await page.evaluate(() => window.dailyCF.bootstrap())).settings.clientId !== original) throw new Error('Cancelling the OAuth change modified the saved ID.');
  await input.fill(original);
  await page.waitForFunction(() => document.querySelector('.settings-save-bar button')?.disabled);
  await summary.click();
  return { passed: true, fixture: true, fixtureBoundary: 'Unsaved Client ID field value in the isolated test profile only',
    cautionLabelVisible: true, persistentWarningVisible: true, actualChangedIDConfirmation: true,
    previousAndEditedIDsShown: true, noSaveBeforeConfirmation: true, cancelPreservedSavedID: true,
    originalFormRestored: true, noAuthorizationAttempt: true };
}

async function verifyOAuthDefaultRestore(page, contentDirectory) {
  const original = await page.evaluate(() => window.dailyCF.bootstrap());
  if (typeof original.defaultClientId !== 'string' || original.defaultClientId !== original.defaultClientId.trim()) {
    throw new Error('Bootstrap did not expose an independent trimmed default Client ID.');
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const advanced = page.locator('.advanced-settings');
  const reveal = async () => { if (!(await advanced.evaluate(element => element.open))) await advanced.locator('summary').click(); };
  await reveal();
  const restore = advanced.getByRole('button', { name: '恢复默认', exact: true });
  const result = { passed: false, fixture: true, fixtureBoundary: 'Client ID fixture saved only in the verifier-owned isolated profile; no authorization or token access',
    defaultExposedSeparately: true, builtInDefaultPresent: Boolean(original.defaultClientId), noAuthorizationAttempt: true };
  if (!original.defaultClientId) {
    if (!await restore.isDisabled() || !(await advanced.locator('.oauth-default-control').textContent()).includes('此版本未内置 OAuth Client ID')) {
      throw new Error('A package without a default did not disable restoration and explain why.');
    }
    if ((await page.evaluate(() => window.dailyCF.bootstrap())).settings.clientId !== original.settings.clientId) {
      throw new Error('The no-default state modified the saved Client ID.');
    }
    result.noDefaultDisabled = true; result.originalValuePreserved = true; result.passed = true;
    await advanced.locator('summary').click();
    return result;
  }
  if (original.settings.clientId !== original.defaultClientId || !await restore.isDisabled()) {
    throw new Error('The fresh isolated package did not start with its built-in default and disabled matching restore action.');
  }
  result.sameValueDisabled = true;
  const wrong = original.defaultClientId === 'Ov23PackageRestoreFixture' ? 'Ov23OtherRestoreFixture' : 'Ov23PackageRestoreFixture';
  await page.evaluate(async ({ settings, wrong }) => window.dailyCF.saveSettings({ ...settings, clientId: wrong }), { settings: original.settings, wrong });
  const changed = await page.evaluate(() => window.dailyCF.bootstrap());
  if (changed.settings.clientId !== wrong || changed.defaultClientId !== original.defaultClientId) {
    throw new Error('Saving an override changed the independent built-in default.');
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await reveal();
  const input = advanced.locator('input');
  if (await input.inputValue() !== wrong || await restore.isDisabled()) throw new Error('The persisted override cannot be restored through settings.');
  const language = page.getByLabel(/^默认编程语言/);
  const draftLanguage = original.settings.language === 'cpp' ? 'py' : 'cpp';
  await language.selectOption(draftLanguage);
  await restore.click();
  if (await input.inputValue() !== original.defaultClientId || await language.inputValue() !== draftLanguage || !await restore.isDisabled()) {
    throw new Error('Restore default did not preserve other unsaved settings or show the built-in value.');
  }
  let boot = await page.evaluate(() => window.dailyCF.bootstrap());
  if (boot.settings.clientId !== wrong || boot.defaultClientId !== original.defaultClientId) throw new Error('Restore default saved before confirmation.');
  await page.locator('.page-heading').getByRole('button', { name: '保存设置', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认更改 GitHub 登录配置？', exact: true });
  await confirmation.waitFor({ state: 'visible' });
  boot = await page.evaluate(() => window.dailyCF.bootstrap());
  if (boot.settings.clientId !== wrong) throw new Error('The restored default was saved before the confirmation action.');
  await confirmation.getByRole('button', { name: '确认更改并保存', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('.settings-save-bar button')?.disabled);
  boot = await page.evaluate(() => window.dailyCF.bootstrap());
  const stored = JSON.parse(fs.readFileSync(path.join(contentDirectory, 'data.json'), 'utf8'));
  if (boot.settings.clientId !== original.defaultClientId || boot.defaultClientId !== original.defaultClientId
    || stored.settings.clientId !== original.defaultClientId || boot.settings.language !== draftLanguage) {
    throw new Error('Confirmed restoration did not persist the build default and the other edited setting.');
  }
  await language.selectOption(original.settings.language);
  await page.locator('.page-heading').getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.settings-save-bar button')?.disabled);
  await advanced.locator('summary').click();
  return { ...result, passed: true, overridePersistedInIsolatedProfile: true, defaultUnchangedAfterOverride: true,
    formOnlyBeforeConfirmation: true, otherUnsavedSettingPreserved: true, confirmationRequired: true,
    confirmedDefaultPersisted: true, defaultUnchangedAfterRestore: true, originalOtherSettingsRestored: true };
}

async function verifyOAuthLayout(page) {
  const original = await page.evaluate(() => window.dailyCF.bootstrap());
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const advanced = page.locator('.advanced-settings');
  if (!(await advanced.evaluate(element => element.open))) await advanced.locator('summary').click();
  await page.evaluate(() => document.fonts.ready);
  const layout = await advanced.locator('summary').evaluate(element => {
    const title = element.querySelector('span').getBoundingClientRect();
    const caution = element.querySelector('.oauth-caution-label').getBoundingClientRect();
    return { gap: caution.left - title.right, sameRow: Math.abs(caution.top + caution.height / 2 - title.top - title.height / 2) < 2 };
  });
  if (layout.gap < 0 || layout.gap > 16 || !layout.sameRow) throw new Error('OAuth caution label is not adjacent to the advanced-settings title.');
  const control = advanced.locator('.oauth-default-control');
  const restore = control.getByRole('button', { name: '恢复默认', exact: true });
  const builtInDefaultPresent = Boolean(original.defaultClientId);
  if (builtInDefaultPresent) {
    if (await control.locator('small').count() !== 0 || !await restore.isDisabled()) throw new Error('Matching built-in default has redundant helper text or an enabled restore button.');
    await advanced.locator('input').fill('Ov23PackageLayoutFixture');
    if (await control.locator('small').count() !== 0 || await restore.isDisabled()) throw new Error('Changed Client ID has redundant helper text or a disabled restore button.');
    await restore.click();
    if (await advanced.locator('input').inputValue() !== original.settings.clientId) throw new Error('Restoration did not return to the original form value.');
  } else if (!await restore.isDisabled() || !(await control.textContent()).includes('此版本未内置 OAuth Client ID')) {
    throw new Error('The no-default state lost its disabled button or explanation.');
  }
  const unchanged = await page.evaluate(() => window.dailyCF.bootstrap());
  if (unchanged.settings.clientId !== original.settings.clientId || unchanged.defaultClientId !== original.defaultClientId) throw new Error('Presentation verification unexpectedly saved settings.');
  await page.waitForFunction(() => document.querySelector('.settings-save-bar button')?.disabled);
  return { passed: true, builtInDefaultPresent, cautionAdjacentToTitle: true, cautionGapPx: layout.gap,
    noRoutineHelperText: builtInDefaultPresent, noDefaultExplanationChecked: !builtInDefaultPresent,
    unsavedFieldFixture: builtInDefaultPresent, persistedSettingsUnchanged: true, noAuthorizationAttempt: true };
}

async function verifyAppearanceSettings(application, page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const original = await page.evaluate(() => window.dailyCF.bootstrap());
  const palettes = original.settings.palettes;
  if (!Array.isArray(palettes) || palettes.length < 1) throw new Error('Packaged settings did not expose the persisted palette list.');
  const selected = palettes.find(palette => palette.id === original.settings.paletteId);
  if (!selected) throw new Error('The selected palette is absent from the packaged settings list.');
  if (selected.id !== 'green') throw new Error('A profile without a saved palette preference did not default to green.');
  const pink = palettes.find(palette => palette.id === 'pink');
  if (!pink || pink.light.accent !== '#fb7299' || pink.dark.accent !== '#ffa8c0'
    || pink.light.primary !== '#f8bed0' || pink.dark.primary !== '#ffc4d4') {
    throw new Error('Initial pink palette does not retain the sampled text color and pale buttons.');
  }
  const samePalette = (actual, expected) => actual && actual.id === expected.id && actual.name === expected.name
    && ['light', 'dark'].every(mode => ['primary', 'accent', 'background', 'surface', 'text'].every(field => actual[mode]?.[field] === expected[mode][field]));
  const rgb = hex => {
    const raw = hex.slice(1);
    const value = raw.length === 3 ? [...raw].map(char => char + char).join('') : raw;
    return 'rgb(' + [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16)).join(', ') + ')';
  };
  const observations = [];
  const save = async () => {
    await page.locator('.page-heading').getByRole('button', { name: '保存设置', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.settings-save-bar button')?.disabled);
    await page.mouse.move(1, 1);
  };
  const mode = async theme => {
    await page.locator('.theme-options').getByRole('button', { name: { light: '浅色', dark: '深色', system: '跟随系统' }[theme], exact: true }).click();
    await save();
  };
  const check = async (palette, activeMode, stage) => {
    const colors = palette[activeMode];
    const expected = Object.fromEntries(Object.entries(colors).map(([name, color]) => [name, rgb(color)]));
    const expectedFill = palette.id === 'green' && activeMode === 'light' ? '#ddf8ea'
      : palette.id === 'pink' && activeMode === 'light' ? '#ffe6ed' : null;
    await page.mouse.move(1, 1);
    await page.waitForFunction(({ id, activeMode, expected, expectedFill, expectedFillRGB }) => {
      const root = document.documentElement;
      const primary = document.querySelector('.page-heading .button-primary');
      const panel = document.querySelector('.appearance-settings');
      const accent = document.querySelector('.appearance-group-heading button[title]');
      const activeNavigation = document.querySelector('.nav-item.active');
      return root.dataset.paletteId === id && root.dataset.theme === activeMode
        && primary && panel && accent && getComputedStyle(primary).backgroundColor === expected.primary
        && getComputedStyle(accent).color === expected.accent
        && getComputedStyle(document.body).backgroundColor === expected.background
        && getComputedStyle(document.body).color === expected.text
        && getComputedStyle(panel).backgroundColor === expected.surface
        && (!expectedFill || activeNavigation
          && getComputedStyle(root).getPropertyValue('--accent-soft').trim() === expectedFill
          && getComputedStyle(activeNavigation).backgroundColor === expectedFillRGB);
    }, { id: palette.id, activeMode, expected, expectedFill, expectedFillRGB: expectedFill ? rgb(expectedFill) : null });
    const observed = await page.evaluate(() => ({
      paletteId: document.documentElement.dataset.paletteId, mode: document.documentElement.dataset.theme,
      primary: getComputedStyle(document.querySelector('.page-heading .button-primary')).backgroundColor,
      accent: getComputedStyle(document.querySelector('.appearance-group-heading button[title]')).color,
      accentSoft: getComputedStyle(document.documentElement).getPropertyValue('--accent-soft').trim(),
      activeNavigationBackground: getComputedStyle(document.querySelector('.nav-item.active')).backgroundColor,
      background: getComputedStyle(document.body).backgroundColor,
      surface: getComputedStyle(document.querySelector('.appearance-settings')).backgroundColor,
      text: getComputedStyle(document.body).color,
    }));
    const nativeBackground = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor());
    if (rgb(nativeBackground) !== expected.background) throw new Error('Native window background did not follow the saved palette and theme.');
    observations.push({ stage, ...observed, nativeBackground });
  };
  await check(selected, 'light', 'initial selected palette');
  await page.locator('[data-palette-id="pink"]').click();
  await save();
  await check(pink, 'light', 'sampled pink accent');
  await mode('dark');
  await check(pink, 'dark', 'pink dark accent retained');
  await page.locator('[data-palette-id="green"]').click();
  await save();
  await check(selected, 'dark', 'selected palette dark');
  const beforeAdd = await page.evaluate(() => window.dailyCF.bootstrap());
  await page.getByRole('button', { name: '添加方案', exact: true }).click();
  const name = 'Package palette verification ' + manifest.version;
  await page.getByLabel('方案名称', { exact: true }).fill(name);
  const newId = await page.locator('.appearance-scheme[aria-pressed="true"]').getAttribute('data-palette-id');
  if (!newId || palettes.some(palette => palette.id === newId)) throw new Error('Add palette did not create a distinct identifier.');
  const custom = { id: newId, name,
    light: { primary: '#b8decd', accent: '#287452', background: '#f8fcfa', surface: '#ffffff', text: '#293830' },
    dark: { primary: '#c1e5d3', accent: '#b7ebcb', background: '#1c2521', surface: '#27312c', text: '#e9f5ef' } };
  const labels = { primary: '按钮底色', accent: '强调色', background: '页面背景', surface: '卡片背景', text: '正文文字' };
  for (const activeMode of ['light', 'dark']) {
    await page.locator('.palette-modes').getByRole('button', { name: activeMode === 'light' ? '浅色配色' : '深色配色', exact: true }).click();
    for (const [field, color] of Object.entries(custom[activeMode])) await page.getByLabel(labels[field], { exact: true }).fill(color);
  }
  const unsaved = await page.evaluate(() => window.dailyCF.bootstrap());
  if (JSON.stringify(unsaved.settings) !== JSON.stringify(beforeAdd.settings)) throw new Error('Editing a palette saved before explicit confirmation.');
  await save();
  let boot = await page.evaluate(() => window.dailyCF.bootstrap());
  const saved = boot.settings.palettes.find(palette => palette.id === newId);
  if (!samePalette(saved, custom) || boot.settings.paletteId !== newId
    || boot.settings.palettes.length !== palettes.length + 1) throw new Error('Named palette colors were not saved completely.');
  await check(custom, 'dark', 'named palette saved');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  boot = await page.evaluate(() => window.dailyCF.bootstrap());
  if (boot.settings.paletteId !== newId || !samePalette(boot.settings.palettes.find(palette => palette.id === newId), custom)) {
    throw new Error('Reload did not retain the named palette selection and colors.');
  }
  await check(custom, 'dark', 'named palette after reload');
  await mode('light');
  await check(custom, 'light', 'named palette light');
  await mode('system');
  const systemDark = await application.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  await check(custom, systemDark ? 'dark' : 'light', 'named palette system');
  await page.evaluate(settings => window.dailyCF.saveSettings(settings), original.settings);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const restored = await page.evaluate(() => window.dailyCF.bootstrap());
  if (JSON.stringify(restored.settings) !== JSON.stringify(original.settings)) throw new Error('Palette verification did not restore the isolated original settings.');
  await check(selected, 'light', 'original settings restored');
  return { passed: true, fixture: true, fixtureBoundary: 'Named palette created and saved only through the real UI in the verifier-owned profile; original settings restored through actual IPC.',
    initialPaletteCount: palettes.length, firstUnselectedPaletteDefault: 'green', greenLightSelectedFill: '#ddf8ea',
    sampledPinkAccent: '#fb7299', pinkLightSelectedFillUnchanged: '#ffe6ed',
    pinkButtonColorsUnchanged: true, namedPaletteAdded: true, allTenColorsSaved: true, unchangedBeforeSave: true,
    reloadPersisted: true, lightDarkAndSystemVerified: true, observations, isolatedSettingsRestored: true, noAuthorizationAttempt: true };
}

async function verifyPaletteReset(page, contentDirectory) {
  const original = await page.evaluate(() => window.dailyCF.bootstrap());
  const defaults = structuredClone(original.settings.palettes);
  if (!Array.isArray(defaults) || defaults.map(item => item.id).join(',') !== 'green,pink,blue,mono') {
    throw new Error('Fresh isolated profile did not contain the four initial palettes.');
  }
  const modified = structuredClone(defaults);
  modified[0].name = 'Edited green package fixture';
  modified[0].light.accent = '#17613b';
  const extra = { ...structuredClone(defaults[1]), id: 'package-reset-fixture', name: 'Added package fixture' };
  const fixture = { ...original.settings, palettes: [...modified, extra], paletteId: extra.id, theme: 'dark', language: 'java' };
  await page.evaluate(settings => window.dailyCF.saveSettings(settings), fixture);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const before = await page.evaluate(() => window.dailyCF.bootstrap());
  const configPath = path.join(contentDirectory, 'data.json');
  const beforeBytes = fs.readFileSync(configPath);
  const persistedUnchanged = async () => {
    const boot = await page.evaluate(() => window.dailyCF.bootstrap());
    if (JSON.stringify(boot.settings) !== JSON.stringify(before.settings) || !fs.readFileSync(configPath).equals(beforeBytes)) {
      throw new Error('Palette reset wrote configuration before Save.');
    }
  };
  const schemeIds = () => page.locator('.appearance-scheme').evaluateAll(elements => elements.map(element => element.getAttribute('data-palette-id')));
  const selectedId = () => page.locator('.appearance-scheme[aria-pressed="true"]').getAttribute('data-palette-id');
  const openConfirmation = async () => {
    await page.getByRole('button', { name: '恢复默认方案集', exact: true }).click();
    const group = page.getByRole('group', { name: '恢复默认方案集？', exact: true });
    await group.waitFor({ state: 'visible' });
    return group;
  };
  const confirmReset = async () => {
    const group = await openConfirmation();
    await group.getByRole('button', { name: '确认恢复', exact: true }).click();
    await group.waitFor({ state: 'hidden' });
  };
  const assertDefaultDraft = async () => {
    if (JSON.stringify(await schemeIds()) !== JSON.stringify(defaults.map(item => item.id))
      || await selectedId() !== 'green' || await page.getByLabel('方案名称', { exact: true }).inputValue() !== defaults[0].name) {
      throw new Error('Confirmed reset did not restore the default scheme list and select green in the form.');
    }
  };
  const canceled = await openConfirmation();
  await canceled.getByRole('button', { name: '取消', exact: true }).click();
  await canceled.waitFor({ state: 'hidden' });
  if ((await schemeIds()).length !== 5 || await selectedId() !== extra.id) throw new Error('Canceling reset changed the palette draft.');
  await persistedUnchanged();
  const language = page.getByLabel(/^默认编程语言/);
  await language.selectOption('cpp');
  await page.locator('.theme-options').getByRole('button', { name: '浅色', exact: true }).click();
  await confirmReset();
  await assertDefaultDraft();
  if (await language.inputValue() !== 'cpp' || !await page.locator('.theme-options').getByRole('button', { name: '浅色', exact: true }).evaluate(element => element.classList.contains('active'))) {
    throw new Error('Reset discarded unrelated unsaved form changes.');
  }
  await persistedUnchanged();
  const leave = async action => {
    await page.getByRole('button', { name: '最新题目', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置尚未保存', exact: true });
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('button', { name: action, exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  await leave('继续编辑');
  await assertDefaultDraft();
  await persistedUnchanged();
  await leave('放弃修改');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  if ((await schemeIds()).length !== 5 || await selectedId() !== extra.id || await language.inputValue() !== 'java') {
    throw new Error('Discarding the reset did not restore the saved user palettes and other settings.');
  }
  await persistedUnchanged();
  await confirmReset();
  await assertDefaultDraft();
  await persistedUnchanged();
  await page.locator('.page-heading').getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.settings-save-bar button')?.disabled);
  const expected = { ...before.settings, palettes: defaults, paletteId: 'green' };
  const saved = await page.evaluate(() => window.dailyCF.bootstrap());
  if (JSON.stringify(saved.settings) !== JSON.stringify(expected)
    || JSON.stringify(JSON.parse(fs.readFileSync(configPath, 'utf8')).settings) !== JSON.stringify(expected)) {
    throw new Error('Saving the reset did not replace exactly the palettes and selection.');
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const reloaded = await page.evaluate(() => window.dailyCF.bootstrap());
  if (JSON.stringify(reloaded.settings) !== JSON.stringify(expected)) throw new Error('Reload lost the saved default palettes.');
  await assertDefaultDraft();
  if (await language.inputValue() !== 'java' || !await page.locator('.theme-options').getByRole('button', { name: '深色', exact: true }).evaluate(element => element.classList.contains('active'))) {
    throw new Error('Reset changed the saved language or dark mode.');
  }
  await page.evaluate(settings => window.dailyCF.saveSettings(settings), original.settings);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const restored = await page.evaluate(() => window.dailyCF.bootstrap());
  if (JSON.stringify(restored.settings) !== JSON.stringify(original.settings)) throw new Error('Reset verification did not restore the initial isolated settings.');
  return { passed: true, fixture: true,
    fixtureBoundary: 'Modified and added schemes seeded by actual settings IPC only in the verifier-owned profile; every reset/cancel/save/discard action uses the real UI.',
    editedAndAddedSchemesSeeded: true, cancelPreservesDraft: true, confirmedDraftSelectsGreen: true,
    restoredPaletteIds: defaults.map(item => item.id), noPersistenceBeforeSave: true, unrelatedUnsavedChangesPreserved: true,
    unsavedGuardContinueVerified: true, discardRestoresSavedSchemes: true, savedExactlyPaletteFields: true,
    reloadPersisted: true, unrelatedSavedSettingsPreserved: true, isolatedOriginalSettingsRestored: true };
}

async function verifyLocalDataLocations(application, page, contentDirectory) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const paths = await page.evaluate(() => window.dailyCF.getLocalPaths());
  const configFile = path.join(contentDirectory, 'data.json');
  if (!paths || !samePath(paths.configFile, configFile) || !samePath(paths.dataDirectory, contentDirectory)) {
    throw new Error('Local locations did not identify this isolated repository profile.');
  }
  const section = page.locator('.local-data-settings');
  await section.getByRole('button', { name: '打开配置文件位置', exact: true }).waitFor({ state: 'visible' });
  const displayedPaths = await section.locator('code').allTextContents();
  if (!displayedPaths.includes(paths.configFile) || !displayedPaths.includes(paths.dataDirectory)) {
    throw new Error('Settings do not show both actual local paths.');
  }
  const original = await page.evaluate(() => window.dailyCF.bootstrap());
  const originalFile = fs.readFileSync(configFile);
  const backupFile = configFile + '.package-check-original';
  const language = page.getByLabel(/^默认编程语言/);
  const oldLanguage = await language.inputValue();
  const unsavedLanguage = oldLanguage === 'py' ? 'cpp' : 'py';
  await language.selectOption(unsavedLanguage);
  await application.evaluate(({ shell }) => {
    globalThis.__localLocationsProbe = { originalOpen: shell.openPath, originalReveal: shell.showItemInFolder,
      calls: [], error: '' };
    shell.showItemInFolder = target => { globalThis.__localLocationsProbe.calls.push({ kind: 'reveal', target }); };
    shell.openPath = async target => {
      globalThis.__localLocationsProbe.calls.push({ kind: 'open', target });
      return globalThis.__localLocationsProbe.error;
    };
  });
  let configMoved = false;
  try {
    await section.getByRole('button', { name: '打开配置文件位置', exact: true }).click();
    await section.getByRole('button', { name: '打开数据目录', exact: true }).click();
    const invalidTargetRejected = await page.evaluate(async () => {
      try { await window.dailyCF.openLocalPath('C:\\Windows'); return false; }
      catch { return true; }
    });
    fs.renameSync(configFile, backupFile);
    configMoved = true;
    await page.evaluate(() => window.dailyCF.openLocalPath('config'));
    if (fs.existsSync(configFile)) throw new Error('Opening an absent config file created or saved settings.');
    fs.renameSync(backupFile, configFile);
    configMoved = false;
    await application.evaluate(() => { globalThis.__localLocationsProbe.error = 'package-check-folder-open-error'; });
    const openErrorSurfaced = await page.evaluate(async () => {
      try { await window.dailyCF.openLocalPath('data'); return false; }
      catch (error) { return String(error).includes('package-check-folder-open-error'); }
    });
    const calls = await application.evaluate(() => globalThis.__localLocationsProbe.calls);
    const expected = [
      { kind: 'reveal', target: paths.configFile }, { kind: 'open', target: paths.dataDirectory },
      { kind: 'open', target: paths.dataDirectory }, { kind: 'open', target: paths.dataDirectory },
    ];
    if (JSON.stringify(calls) !== JSON.stringify(expected) || !invalidTargetRejected || !openErrorSurfaced) {
      throw new Error('Local location IPC did not honor fixed targets, fallback, or native error propagation.');
    }
    const after = await page.evaluate(() => window.dailyCF.bootstrap());
    if (JSON.stringify(after.settings) !== JSON.stringify(original.settings)
      || !fs.readFileSync(configFile).equals(originalFile) || await language.inputValue() !== unsavedLanguage) {
      throw new Error('Opening local locations saved, changed, or discarded unsaved settings.');
    }
    return { passed: true, fixture: true, fixtureBoundary: 'Native shell methods stubbed; missing config temporarily renamed only in verifier-owned profile.',
      actualPreloadAndMainIPC: true, actualSettingsButtons: true, actualPathsDisplayed: true,
      fixedTargetsOnly: invalidTargetRejected, missingConfigOpensDataDirectory: true, noConfigCreated: true,
      nativeOpenErrorPropagated: openErrorSurfaced, unsavedSettingsPreserved: true, savedSettingsUnchanged: true,
      explorerActuallyOpened: false, calls };
  } finally {
    if (configMoved) fs.renameSync(backupFile, configFile);
    await application.evaluate(({ shell }) => {
      shell.openPath = globalThis.__localLocationsProbe.originalOpen;
      shell.showItemInFolder = globalThis.__localLocationsProbe.originalReveal;
      delete globalThis.__localLocationsProbe;
    });
    await language.selectOption(oldLanguage);
    await page.waitForFunction(() => document.querySelector('.settings-save-bar button')?.disabled);
  }
}

async function verifyNativeCloseGuard(application, page, child) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const language = page.getByLabel(/^默认编程语言/);
  const editedLanguage = await language.inputValue() === 'py' ? 'cpp' : 'py';
  await language.selectOption(editedLanguage);
  console.log('Unsaved setting prepared in the isolated profile.');
  const dialog = page.getByRole('dialog', { name: '设置尚未保存', exact: true });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  console.log('First native close preserved the settings dialog.');
  const windowPreserved = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => !window.isDestroyed()));
  if (page.isClosed() || !windowPreserved) throw new Error('Native close did not preserve the window with unsaved settings.');
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  if (await language.inputValue() !== editedLanguage) throw new Error('Continuing after native close lost the unsaved setting.');
  console.log('Continue editing preserved the unsaved value.');

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  console.log('Second native close reached the discard confirmation.');
  await Promise.all([
    page.waitForEvent('close', { timeout: 10_000 }),
    dialog.getByRole('button', { name: '放弃修改', exact: true }).click(),
  ]);
  await waitForProcessExit(child);
  console.log('Discard closed the isolated packaged process.');
  return { nativeCloseGuardVerified: true, nativeCloseContinueVerified: true, nativeCloseDiscardVerified: true };
}

async function verifyRetainedLocalCards(application, page, contentDirectory) {
  const result = { passed: false, fixture: true, realPackagedWindow: true,
    fixtureBoundaries: ['day refresh IPC held and rejected'], realLocalViewIPC: true,
    persistedGitRead: true, noSubmissionAttempted: true };
  verificationProgress.retainedLocalCards = result;
  // Finish the new instance's ordinary startup read before installing a single
  // transport fixture; no old worker completion can pollute the new renderer.
  await page.evaluate(() => window.dailyCF.getDay());
  const local = await page.evaluate(() => window.dailyCF.getLocalLibraryView({ kind: 'day' }));
  if (!local || local.kind !== 'day' || !local.day.problems.length
    || local.revision !== gitStoreSnapshot(contentDirectory).revision) {
    throw new Error('No verified persisted local day was available for retained-content verification.');
  }
  result.revision = local.revision;
  result.date = local.day.date;
  result.problemCount = local.day.problems.length;
  await application.evaluate(({ ipcMain }) => {
    globalThis.__dailyCFRetainedCheck = { calls: 0, pending: [] };
    ipcMain.removeHandler('daily-cf:day');
    ipcMain.handle('daily-cf:day', () => {
      globalThis.__dailyCFRetainedCheck.calls++;
      return new Promise(resolve => globalThis.__dailyCFRetainedCheck.pending.push(resolve));
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const cards = page.locator('.problem-card');
  const notice = page.getByTestId('retained-content-note');
  await cards.first().waitFor({ state: 'visible' });
  if (await notice.count() !== 0) throw new Error('A redundant lower retained-content notice was shown while refreshing.');
  const ids = local.day.problems.map(problem => problem.id.toUpperCase());
  const containsExpectedCards = async () => {
    const texts = await cards.allTextContents();
    return texts.length === ids.length && ids.every(id => texts.some(text => text.toUpperCase().includes(id)));
  };
  if (!await containsExpectedCards()) throw new Error('The pending refresh did not display the persisted local problem cards.');
  result.cardsVisibleDuringRefresh = true;
  result.redundantCheckingNoticeAbsent = true;
  await application.evaluate(() => {
    for (const resolve of globalThis.__dailyCFRetainedCheck.pending.splice(0)) {
      resolve({ ok: false, error: 'Packaged verification transport failure.' });
    }
  });
  await notice.getByText('题库更新未完成，当前显示上次读取的内容。', { exact: true }).waitFor({ state: 'visible' });
  await notice.getByText('Packaged verification transport failure.', { exact: true }).waitFor({ state: 'visible' });
  if (!await containsExpectedCards() || !await notice.evaluate(element => element.classList.contains('retained-content-warning'))) {
    throw new Error('Refresh failure did not retain the local cards with an explicit warning.');
  }
  result.cardsRetainedAfterFailure = true;
  result.failureWarningVisible = true;
  result.noFreshReadyClaim = await page.locator('.library-sync-notice[data-sync-phase="ready"]').count() === 0;
  if (!result.noFreshReadyClaim) throw new Error('The rejected fixture refresh was shown as a successful update.');
  result.fixtureCalls = await application.evaluate(() => globalThis.__dailyCFRetainedCheck.calls);
  await application.evaluate(() => { delete globalThis.__dailyCFRetainedCheck; });
  result.passed = true;
  console.log('Actual persisted local cards remained visible during the held refresh and its explicit failure.');
  return result;
}

async function verifyNativeQueueClose(executable, env, profile, contentDirectory, verifyLocalPreview = false) {
  const fixtureCode = 'print("Daily CF packaged queue fixture")\n';
  const fixtureFile = path.join(profile, 'package-queue-fixture.py');
  const fixturePath = 'daily_problems/2000/01/0101/personal_submission/cf4a_package_queue_check.py';
  const fixtureDay = { date: '2000-01-01', problems: [{ id: 'cf4a', label: 'CF4A — packaged queue fixture',
    url: 'https://codeforces.com/problemset/problem/4/A', rating: 800, ratingSource: 'official', kind: 'round', hint: 'Local verification fixture.' }],
    sourceUrl: 'https://github.com/Yawn-Sean/Daily_CF_Problems', fetchedAt: new Date().toISOString() };
  fs.writeFileSync(fixtureFile, fixtureCode);
  const queueReport = { passed: false, fixture: true, realPackagedWindow: true, sameIsolatedProfile: true,
    fixtureBoundaries: ['day IPC response', 'inspect-submission-file IPC response', 'one native file-picker selection'],
    actualImportCodeIPC: true, noSubmissionAttempted: true };
  verificationProgress.queueNativeClose = queueReport;
  let queueApplication;
  let queueChild;
  try {
    // The settings-check process has exited. This is a second, sequential window.
    queueApplication = await electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env, timeout: 30_000 });
    queueChild = queueApplication.process();
    const userData = await queueApplication.evaluate(({ app }) => app.getPath('userData'));
    if (!samePath(userData, profile)) throw new Error('Queue verification did not use the isolated profile.');
    const page = await queueApplication.firstWindow();
    page.setDefaultTimeout(15_000);
    console.log('Queue-check instance launched; waiting for initial page load.');
    // firstWindow fires before createWindow's loadFile has resolved. Reloading at
    // that point aborts startup and triggers Electron's synchronous error box.
    await page.waitForLoadState('load', { timeout: 30_000 });
    await page.evaluate(() => window.dailyCF.bootstrap());
    console.log('Initial queue-check page and bootstrap ready.');
    let unexpectedDialogError;
    page.on('dialog', dialog => {
      if (dialog.type() === 'beforeunload') return;
      void dialog.dismiss().catch(error => { unexpectedDialogError = error; });
    });
    await queueApplication.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
    if (verifyLocalPreview) {
      verificationProgress.retainedLocalCards = await verifyRetainedLocalCards(queueApplication, page, contentDirectory);
    }
    await queueApplication.evaluate(({ BrowserWindow, ipcMain, dialog }, fixture) => {
      for (const window of BrowserWindow.getAllWindows()) window.hide();
      globalThis.__dailyCFQueueCheck = { dayReads: 0, inspections: 0, filePickerUsed: false };
      // These fixtures exercise the real preload/UI/native-close route without contacting GitHub.
      ipcMain.removeHandler('daily-cf:day');
      ipcMain.handle('daily-cf:day', (_event, date) => {
        globalThis.__dailyCFQueueCheck.dayReads++;
        return !date || date === fixture.day.date ? { ok: true, data: fixture.day } : { ok: false, error: 'Unexpected fixture date.' };
      });
      ipcMain.removeHandler('daily-cf:inspect-submission-file');
      ipcMain.handle('daily-cf:inspect-submission-file', (_event, input) => {
        globalThis.__dailyCFQueueCheck.inspections++;
        return input.date === fixture.day.date && input.problemId === 'cf4a' && input.author === 'package_queue_check' && input.language === 'py'
          ? { ok: true, data: { path: fixture.path, exists: false } } : { ok: false, error: 'Unexpected fixture file identity.' };
      });
      const originalPicker = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = originalPicker;
        globalThis.__dailyCFQueueCheck.filePickerUsed = true;
        return { canceled: false, filePaths: [fixture.file] };
      };
    }, { day: fixtureDay, file: fixtureFile, path: fixturePath });
    await page.reload({ waitUntil: 'domcontentloaded' });
    console.log('Queue read fixtures installed and renderer reloaded.');
    const card = page.locator('.problem-card').filter({ hasText: 'CF4A' });
    await card.getByRole('button', { name: '加入提交列表', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '加入提交列表', exact: true });
    await editor.getByLabel(/^署名 /).fill('package_queue_check');
    await editor.getByRole('button', { name: '选择代码文件', exact: true }).click();
    await editor.locator('.uploaded-file').waitFor({ state: 'visible' });
    if (await editor.locator('pre').textContent() !== fixtureCode) throw new Error('Actual importCode did not preserve the local fixture text.');
    console.log('Queue fixture imported through actual file-read IPC.');
    await editor.getByRole('button', { name: '加入列表', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    console.log('Fixture file confirmed into the session list.');
    const openQueue = () => page.locator('.topbar').getByRole('button', { name: /^提交列表/ }).click();
    await openQueue();
    const queue = page.getByRole('dialog', { name: '提交列表', exact: true });
    await queue.locator('.queue-item').waitFor({ state: 'visible' });
    if (await queue.locator('.queue-item').count() !== 1 || await queue.locator('.queue-file-path').textContent() !== fixturePath) {
      throw new Error('The prepared file was not added to the session submission list.');
    }
    await queue.locator('.composer-footer').getByRole('button', { name: '关闭', exact: true }).click();
    await queue.waitFor({ state: 'hidden' });
    await openQueue();
    await queue.locator('.queue-item').waitFor({ state: 'visible' });
    queueReport.retainedAfterListClose = await queue.locator('.queue-file-path').textContent() === fixturePath;
    if (!queueReport.retainedAfterListClose) throw new Error('Closing the list lost its session file.');
    const storedSettings = fs.readFileSync(path.join(contentDirectory, 'data.json'), 'utf8');
    queueReport.notStoredInSettings = !storedSettings.includes('package_queue_check') && !storedSettings.includes('Daily CF packaged queue fixture');
    if (!queueReport.notStoredInSettings) throw new Error('Session submission data was written into settings.');
    const confirmation = page.getByRole('dialog', { name: '提交内容尚未提交', exact: true });
    await queueApplication.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await confirmation.waitFor({ state: 'visible', timeout: 10_000 });
    queueReport.windowPreserved = await queueApplication.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => !window.isDestroyed()));
    if (page.isClosed() || !queueReport.windowPreserved) throw new Error('Native queue close did not preserve the window.');
    await confirmation.getByRole('button', { name: '继续编辑', exact: true }).click();
    await confirmation.waitFor({ state: 'hidden' });
    queueReport.continueRetainedEntry = await queue.locator('.queue-item').count() === 1
      && await queue.locator('.queue-file-path').textContent() === fixturePath;
    if (!queueReport.continueRetainedEntry) throw new Error('Continuing after native close lost the queued file.');
    queueReport.fixtureCalls = await queueApplication.evaluate(() => globalThis.__dailyCFQueueCheck);
    if (!queueReport.fixtureCalls.filePickerUsed || queueReport.fixtureCalls.inspections !== 1) throw new Error('Queue fixture did not exercise import and inspection.');
    await queueApplication.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await confirmation.waitFor({ state: 'visible', timeout: 10_000 });
    await Promise.all([page.waitForEvent('close', { timeout: 10_000 }), confirmation.getByRole('button', { name: '丢弃并离开', exact: true }).click()]);
    await waitForProcessExit(queueChild);
    if (unexpectedDialogError) throw new Error('Unexpected native dialog handling failure in queue verification.');
    queueReport.discardExited = true;
    queueReport.passed = true;
    console.log('Session list retention and native queue close verified in a second sequential isolated instance.');
    return queueReport;
  } finally {
    if (queueApplication && queueChild && queueChild.exitCode === null && queueChild.signalCode === null) {
      await queueApplication.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await waitForProcessExit(queueChild);
    }
  }
}

function gitStoreSnapshot(contentDirectory) {
  const root = path.join(contentDirectory, 'library.git');
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || !samePath(fs.realpathSync.native(root), root)) {
    throw new Error('The isolated Git store has an unsafe directory path.');
  }
  const readRegular = (filename, limit) => {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) {
      throw new Error('Unexpected local Git metadata entry.');
    }
    return fs.readFileSync(filename, 'utf8');
  };
  const marker = JSON.parse(readRegular(path.join(root, 'daily-cf-repository.json'), 16_384));
  if (marker.version !== 1 || marker.repository !== expectedRepository) throw new Error('The local Git store belongs to an unexpected repository.');
  const pointerPath = path.join(root, 'daily-cf-active.json');
  let pointer;
  let pointerPresent = false;
  try {
    pointer = JSON.parse(readRegular(pointerPath, 16_384));
    pointerPresent = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (pointerPresent && (!pointer || typeof pointer !== 'object' || pointer.version !== 1 || pointer.repository !== expectedRepository
    || typeof pointer.generation !== 'string' || !/^objects-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.git$/.test(pointer.generation)
    || typeof pointer.revision !== 'string' || !/^[a-f0-9]{40}$/.test(pointer.revision)
    || typeof pointer.branch !== 'string' || !pointer.branch || pointer.branch.length > 1024)) {
    throw new Error('The active Git generation pointer is invalid.');
  }
  const generation = pointer?.generation ?? 'objects.git';
  const gitdir = path.join(root, generation);
  const generationDirectory = fs.lstatSync(gitdir);
  if (!generationDirectory.isDirectory() || generationDirectory.isSymbolicLink() || !samePath(fs.realpathSync.native(gitdir), gitdir)) {
    throw new Error('The active Git generation is not a regular directory inside the isolated store.');
  }
  for (const segment of ['refs', path.join('refs', 'heads')]) {
    const parent = fs.lstatSync(path.join(gitdir, segment));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('The active Git snapshot has an unsafe parent.');
  }
  const revision = readRegular(path.join(gitdir, 'refs', 'heads', 'daily-cf-snapshot'), 1024).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('The local Git snapshot ref is invalid.');
  if (pointer && pointer.revision !== revision) throw new Error('The active pointer and published Git snapshot ref disagree.');
  const pending = [gitdir];
  let files = 0;
  let bytes = 0;
  let packs = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected link in the isolated Git object store.');
      if (entry.isDirectory()) pending.push(filename);
      else if (entry.isFile()) {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unexpected hard link in the isolated Git object store.');
        files++; bytes += stat.size; if (entry.name.endsWith('.pack')) packs++;
      } else throw new Error('Unexpected entry in the isolated Git object store.');
    }
  }
  if (!packs || !fs.existsSync(path.join(gitdir, 'objects')) || fs.existsSync(path.join(root, 'daily_problems'))) {
    throw new Error('The packaged library did not produce the expected bare Git object store.');
  }
  return { path: [...expectedRepository.split('/'), 'library.git', generation].join('/'), generation,
    storageFormat: pointer ? 'generation-pointer-v1' : 'legacy-objects-directory',
    pointerPath: pointer ? [...expectedRepository.split('/'), 'library.git', 'daily-cf-active.json'].join('/') : undefined,
    branch: pointer?.branch, publishedRefMatchesPointer: pointer ? true : undefined,
    sizeScope: 'active generation only', revision, files, bytes, packs, noWorkingTree: true };
}

async function verifyPackagedArchiveReuse(application, page, contentDirectory) {
  const result = { passed: false, fixture: false, realPackagedWindow: true, realPreloadAndMainIPC: true,
    actualOfficialGit: true, instrumentation: 'Transparent main IPC wrappers; original handlers and returned data unchanged.',
    readOnly: true, noSubmissionAttempted: true, deadlineMs: 240_000 };
  verificationProgress.archiveReuse = result;
  await application.evaluate(({ ipcMain }) => {
    const registry = ipcMain._invokeHandlers;
    if (!(registry instanceof Map)) throw new Error('Electron invoke registry unavailable for transparent verification.');
    const state = { originals: new Map(), calls: [] };
    globalThis.__dailyCFArchiveVerification = state;
    for (const name of ['archive-snapshot', 'month-from-snapshot', 'local-library-view', 'sync-library']) {
      const channel = `daily-cf:${name}`;
      const original = registry.get(channel);
      if (typeof original !== 'function') throw new Error(`Missing packaged handler ${channel}.`);
      state.originals.set(channel, original);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        const call = { name, startedAt: Date.now(), requestKind: args[0]?.kind, scope: args[0]?.scope,
          month: typeof args[0] === 'string' ? args[0] : args[0]?.month, requestedRevision: args[1]?.revision };
        state.calls.push(call);
        try {
          const response = await original(event, ...args);
          call.ok = response.ok;
          const data = response.data;
          call.revision = data?.revision;
          call.branch = data?.branch;
          const months = data?.months ?? data?.snapshot?.months;
          if (months) { call.monthCount = months.length; call.dayCount = months.reduce((sum, month) => sum + month.days, 0); }
          const days = Array.isArray(data) ? data : data?.index ? Object.values(data.index).flat() : undefined;
          if (days) { call.readDays = days.length; call.problemCount = days.reduce((sum, day) => sum + day.problems.length, 0); }
          return response;
        } catch (error) { call.threw = String(error); throw error; }
        finally { call.completedAt = Date.now(); call.elapsedMs = call.completedAt - call.startedAt; }
      });
    }
  });
  const calls = () => application.evaluate(() => globalThis.__dailyCFArchiveVerification.calls);
  const waitForCalls = async predicate => {
    const deadline = Date.now() + result.deadlineMs;
    while (Date.now() < deadline) {
      const current = await calls();
      if (predicate(current)) return current;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Packaged full-library IPC check exceeded its deadline.');
  };
  const cardSnapshot = async () => {
    const text = await page.locator('.problem-card').allTextContents();
    return { count: text.length, sha256: crypto.createHash('sha256').update(JSON.stringify(text)).digest('hex') };
  };
  const waitForCompleteArchive = () => page.waitForFunction(() => {
    const browser = document.querySelector('#archive-browser');
    const counts = browser?.querySelector('.archive-results-heading h2 span')?.textContent.match(/(\d+)\s*\/\s*(\d+)\s*道题/);
    const refresh = [...document.querySelectorAll('.page-heading button')].find(button => button.textContent.trim() === '刷新');
    const cards = browser?.querySelectorAll('.problem-card').length ?? 0;
    return browser && !browser.querySelector('.index-panel') && counts && Number(counts[2]) > 0 && counts[1] === counts[2]
      && cards === Number(counts[2]) && refresh && !refresh.disabled;
  }, undefined, { timeout: result.deadlineMs });
  await page.evaluate(() => {
    window.__archiveVerificationProgress = [];
    window.__archiveVerificationUnsubscribe = window.dailyCF.onLibrarySync(value => {
      window.__archiveVerificationProgress.push({ phase: value.phase, revision: value.revision });
    });
  });
  try {
    console.log('Verifying complete archive and same-revision refresh through the actual packaged UI.');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const initialStartedAt = Date.now();
    await page.getByRole('button', { name: '历史题库', exact: true }).first().click();
    await waitForCompleteArchive();
    result.unifiedArchive = {
      directEntryLoadsAll: true,
      legacyModeSwitcherAbsent: await page.locator('.archive-mode-switch').count() === 0,
      globalSearchAvailable: await page.getByRole('textbox', { name: '搜索全库题目', exact: true }).count() === 1,
    };
    if (!result.unifiedArchive.legacyModeSwitcherAbsent || !result.unifiedArchive.globalSearchAvailable) {
      throw new Error('The packaged archive still exposes the old browsing modes or lacks global search.');
    }
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('.page-heading button')].find(item => item.textContent.trim() === '刷新');
      return button && !button.disabled;
    }, undefined, { timeout: result.deadlineMs });
    const initialCalls = await waitForCalls(current => current.some(call => call.name === 'archive-snapshot' && call.ok && call.completedAt)
      && current.every(call => call.completedAt));
    const initialSnapshot = initialCalls.filter(call => call.name === 'archive-snapshot' && call.ok).at(-1);
    const initialCards = await cardSnapshot();
    const initialStore = gitStoreSnapshot(contentDirectory);
    if (!initialCards.count || initialSnapshot.revision !== initialStore.revision) {
      throw new Error('The packaged full-library display did not match its actual synchronized revision.');
    }
    const allView = initialCalls.filter(call => call.name === 'local-library-view' && call.scope === 'all' && call.ok).at(-1);
    if (allView?.problemCount && allView.revision === initialSnapshot.revision && allView.problemCount !== initialCards.count) {
      throw new Error('The packaged full-library display omitted problems returned by the actual local view.');
    }
    result.initial = { elapsedMs: Date.now() - initialStartedAt, revision: initialSnapshot.revision,
      monthCount: initialSnapshot.monthCount, dayCount: initialSnapshot.dayCount, cards: initialCards, calls: initialCalls };
    const callOffset = initialCalls.length;
    const progressOffset = await page.evaluate(() => window.__archiveVerificationProgress.length);
    const refreshStartedAt = Date.now();
    await page.locator('.page-heading').getByRole('button', { name: '刷新', exact: true }).click();
    await waitForCalls(current => current.slice(callOffset).some(call => call.name === 'archive-snapshot' && call.completedAt));
    await waitForCompleteArchive();
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('.page-heading button')].find(item => item.textContent.trim() === '刷新');
      return button && !button.disabled;
    }, undefined, { timeout: result.deadlineMs });
    const finalCalls = (await waitForCalls(current => current.slice(callOffset).every(call => call.completedAt))).slice(callOffset);
    const refreshedSnapshot = finalCalls.filter(call => call.name === 'archive-snapshot' && call.ok).at(-1);
    const finalCards = await cardSnapshot();
    const finalStore = gitStoreSnapshot(contentDirectory);
    if (!refreshedSnapshot || refreshedSnapshot.revision !== finalStore.revision || finalCalls.some(call => call.ok === false || call.threw)) {
      throw new Error('The full-library refresh did not complete against a valid actual Git snapshot.');
    }
    const sameRevision = initialSnapshot.revision === refreshedSnapshot.revision;
    const repeatedMonthReads = finalCalls.filter(call => call.name === 'month-from-snapshot').length;
    const syncProgress = await page.evaluate(offset => window.__archiveVerificationProgress.slice(offset), progressOffset);
    if (!syncProgress.some(value => value.phase === 'checking')
      || !syncProgress.some(value => value.phase === 'ready' && value.revision === refreshedSnapshot.revision)) {
      throw new Error('The actual refresh did not emit a new synchronization check and matching ready revision.');
    }
    result.refresh = { elapsedMs: Date.now() - refreshStartedAt, revision: refreshedSnapshot.revision,
      sameRevision, repeatedMonthReads, cards: finalCards, calls: finalCalls,
      newSnapshotRequestObserved: true, syncProgress, newSynchronizationCheckObserved: true };
    if (!sameRevision) {
      result.sameRevisionReuseVerified = false;
      result.reason = 'The official repository changed during verification; no same-revision result is claimed.';
    } else {
      if (repeatedMonthReads !== 0 || finalCards.count !== initialCards.count || finalCards.sha256 !== initialCards.sha256) {
        throw new Error('Refreshing the same real Git revision repeated month reads or changed the complete displayed archive.');
      }
      result.sameRevisionReuseVerified = true;
    }
    const navigationCounts = current => Object.fromEntries(['archive-snapshot', 'month-from-snapshot', 'local-library-view', 'sync-library']
      .map(name => [name, current.filter(call => call.name === name).length]));
    const beforeNavigation = navigationCounts(await calls());
    const renderedMonths = await page.locator('[data-archive-month]').evaluateAll(elements => elements.map(element => element.dataset.archiveMonth));
    const targetMonth = renderedMonths[Math.floor(renderedMonths.length / 2)];
    if (!targetMonth) throw new Error('The actual unified archive has no month navigation target.');
    await page.locator(`[data-month-jump="${targetMonth}"]`).click();
    await page.waitForFunction(month => {
      const button = document.querySelector(`[data-month-jump="${month}"]`);
      const day = document.querySelector(`[data-archive-month="${month}"] [data-problem-date]`);
      const top = day?.getBoundingClientRect().top;
      return button?.getAttribute('aria-current') === 'location' && top !== undefined && top >= 0 && top < 100;
    }, targetMonth, { timeout: 10_000 });
    await page.waitForTimeout(250);
    const afterNavigation = navigationCounts(await calls());
    const navigationCards = await cardSnapshot();
    if (JSON.stringify(beforeNavigation) !== JSON.stringify(afterNavigation)
      || navigationCards.count !== finalCards.count || navigationCards.sha256 !== finalCards.sha256) {
      throw new Error('Month navigation fetched archive data again or changed the global result set.');
    }
    result.monthNavigation = { passed: true, targetMonth, beforeIPCCounts: beforeNavigation,
      afterIPCCounts: afterNavigation, noNewLibraryIPC: true, cardsUnchanged: true, cards: navigationCards };
    await page.evaluate(async () => { window.scrollTo({ top: 0, behavior: 'instant' }); await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const captured = await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1440, 1000);
      window.webContents.setBackgroundThrottling(false);
      let timeout;
      try {
        window.showInactive();
        await new Promise(resolve => setTimeout(resolve, 250));
        const bitmap = await Promise.race([
          window.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 1000 }, { stayHidden: true, stayAwake: true }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Native archive capture exceeded 10 seconds.')), 10_000); }),
        ]);
        if (bitmap.isEmpty()) throw new Error('Native archive capture returned an empty image.');
        return { png: bitmap.toPNG().toString('base64'), size: bitmap.getSize() };
      } finally { clearTimeout(timeout); window.hide(); }
    });
    const screenshotPath = `docs/screenshots/archive-${manifest.version}-actual.png`;
    fs.writeFileSync(path.join(workspace, screenshotPath), Buffer.from(captured.png, 'base64'));
    result.screenshot = { captured: true, fixture: false, path: screenshotPath, size: captured.size,
      version: manifest.version, revision: finalStore.revision, problemCount: finalCards.count, checkedAt: new Date().toISOString() };
    result.passed = true;
    console.log(`Actual full archive refresh verified: ${result.initial.monthCount} months, ${initialCards.count} problems; same revision=${sameRevision}, repeated month IPC calls=${repeatedMonthReads}.`);
    await page.getByRole('button', { name: '最新题目', exact: true }).click();
    await page.locator('.today-heading h1').waitFor({ state: 'visible' });
    return result;
  } finally {
    await page.evaluate(() => {
      window.__archiveVerificationUnsubscribe?.();
      delete window.__archiveVerificationUnsubscribe; delete window.__archiveVerificationProgress;
    }).catch(() => {});
    await application.evaluate(({ ipcMain }) => {
      const state = globalThis.__dailyCFArchiveVerification;
      if (!state) return;
      for (const [channel, original] of state.originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original); }
      delete globalThis.__dailyCFArchiveVerification;
    }).catch(() => {});
  }
}

async function verifyGitLibrary(page, contentDirectory) {
  const result = { passed: false, repository: expectedRepository, readOnly: true, freshProfile: true,
    operations: ['getDay(undefined, true)', 'getArchiveMonths(true)', 'syncLibrary()', 'getDay(undefined, true)'],
    requestDeadlineMs: 240_000 };
  verificationProgress.remoteRefresh = result;
  async function bounded(operation, work) {
    let timer;
    try {
      return await Promise.race([work(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} exceeded the packaged-check deadline.`)), result.requestDeadlineMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  await page.evaluate(() => {
    window.__packageGitProgress = [];
    window.__packageGitUnsubscribe = window.dailyCF.onLibrarySync(progress => {
      if (window.__packageGitProgress.length < 1000) window.__packageGitProgress.push(progress);
    });
  });
  try {
    console.log('Reading the official library in a fresh isolated Git store through the packaged worker.');
    const startedAt = Date.now();
    const day = await bounded('Initial Git-backed day read', () => page.evaluate(() => window.dailyCF.getDay(undefined, true)));
    result.initialReadElapsedMs = Date.now() - startedAt;
    result.initialStore = gitStoreSnapshot(contentDirectory);
    if (result.initialStore.storageFormat !== 'generation-pointer-v1') {
      throw new Error('The new package did not publish its verified Git generation through an active pointer.');
    }
    result.date = day.date;
    result.problemCount = day.problems.length;
    result.sourceUrl = day.sourceUrl;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !day.sourceUrl.includes(`/blob/${result.initialStore.revision}/`)) {
      throw new Error('The initial day was not read from the stored immutable Git revision.');
    }
    const months = await bounded('Git-backed archive read', () => page.evaluate(() => window.dailyCF.getArchiveMonths(true)));
    const values = months.map(item => item.month).sort();
    Object.assign(result, { monthCount: values.length, firstMonth: values[0], lastMonth: values.at(-1),
      dayCount: months.reduce((total, month) => total + month.days, 0), dayMonthIncluded: values.includes(day.date.slice(0, 7)) });
    if (!values.length || !result.dayMonthIncluded || new Set(values).size !== values.length) {
      throw new Error('The Git archive did not contain a valid dynamic month directory.');
    }
    console.log('Initial Git-backed day and archive verified; checking subsequent synchronization.');
    const nextStartedAt = Date.now();
    const synchronized = await bounded('Subsequent Git synchronization', () => page.evaluate(() => window.dailyCF.syncLibrary()));
    const subsequentDay = await bounded('Subsequent Git-backed day read', () => page.evaluate(() => window.dailyCF.getDay(undefined, true)));
    result.subsequentReadElapsedMs = Date.now() - nextStartedAt;
    result.subsequentSync = synchronized;
    result.subsequentStore = gitStoreSnapshot(contentDirectory);
    result.subsequentDate = subsequentDay.date;
    result.sameRevisionAcrossReads = result.initialStore.revision === result.subsequentStore.revision;
    result.objectStoreGrowthBytes = result.subsequentStore.bytes - result.initialStore.bytes;
    if (!/^[a-f0-9]{40}$/.test(synchronized.revision) || !synchronized.branch
      || !subsequentDay.sourceUrl.includes(`/blob/${result.subsequentStore.revision}/`)) {
      throw new Error('The subsequent library read did not use a valid synchronized Git revision.');
    }
    const localViews = await bounded('Persisted local library views', () => page.evaluate(async freshDay => {
      const day = await window.dailyCF.getLocalLibraryView({ kind: 'day' });
      const archive = await window.dailyCF.getLocalLibraryView({ kind: 'archive', scope: 'month', month: freshDay.date.slice(0, 7) });
      const problem = freshDay.problems[0];
      const resources = problem ? await window.dailyCF.getLocalLibraryView({ kind: 'resources', date: freshDay.date, problemId: problem.id }) : null;
      const referencePath = resources?.kind === 'resources' ? resources.resources.references[0]?.path : undefined;
      const reference = referencePath ? await window.dailyCF.getLocalLibraryView({ kind: 'reference', path: referencePath }) : null;
      return { day, archive, resources, referencePath, reference };
    }, subsequentDay));
    const revision = result.subsequentStore.revision;
    if (!localViews.day || localViews.day.kind !== 'day' || localViews.day.revision !== revision
      || localViews.day.day.sourceUrl !== subsequentDay.sourceUrl
      || JSON.stringify(localViews.day.day.problems) !== JSON.stringify(subsequentDay.problems)
      || !localViews.archive || localViews.archive.kind !== 'archive' || localViews.archive.revision !== revision
      || localViews.archive.snapshot.revision !== revision || !localViews.archive.days.some(day => day.date === subsequentDay.date)
      || (subsequentDay.problems.length && (!localViews.resources || localViews.resources.kind !== 'resources' || localViews.resources.revision !== revision))
      || (localViews.referencePath && (!localViews.reference || localViews.reference.kind !== 'reference'
        || localViews.reference.revision !== revision || typeof localViews.reference.code !== 'string'))) {
      throw new Error('The local preview API did not return the persisted revision and matching content.');
    }
    result.localLibraryViews = { passed: true, revision, dayMatchesFreshRead: true,
      archiveMonth: localViews.archive.month, archiveDays: localViews.archive.days.length,
      resourcesRead: Boolean(localViews.resources), referenceCount: localViews.resources?.kind === 'resources' ? localViews.resources.resources.references.length : 0,
      referenceRead: Boolean(localViews.reference), referencePath: localViews.referencePath,
      referenceBytes: localViews.reference?.kind === 'reference' ? Buffer.byteLength(localViews.reference.code) : undefined,
      referenceSha256: localViews.reference?.kind === 'reference' ? crypto.createHash('sha256').update(localViews.reference.code).digest('hex') : undefined };
    const progress = await page.evaluate(() => window.__packageGitProgress);
    result.observedProgress = { phases: [...new Set(progress.map(event => event.phase))],
      readyCount: progress.filter(event => event.phase === 'ready').length,
      revisions: [...new Set(progress.filter(event => event.phase === 'ready').map(event => event.revision))] };
    if (!result.observedProgress.readyCount || result.observedProgress.phases.includes('error')) {
      throw new Error('The actual worker did not emit successful library synchronization progress.');
    }
    result.persistentPublicGitObjectsVerified = true;
    result.noLegacyHttpResponseCacheFiles = !fs.readdirSync(contentDirectory).some(name => name === 'library.json' || /^day-.*\.json$/.test(name));
    if (!result.noLegacyHttpResponseCacheFiles) throw new Error('Unexpected legacy HTTP-response files appeared beside the Git store.');
    result.passed = true;
    console.log('Packaged Git synchronization and persistent public object store verified.');
    return result;
  } finally {
    await page.evaluate(() => { window.__packageGitUnsubscribe?.(); delete window.__packageGitUnsubscribe; delete window.__packageGitProgress; }).catch(() => {});
  }
}

async function verifyPackagedLibraryRepair(page, profile, contentDirectory) {
  const result = { passed: false, fixture: true, fixtureBoundary: 'One payload byte in one pack file inside this verifier-owned temporary profile.',
    actualOfficialGit: true, actualPackagedWorker: true, readOnlyRemote: true, noUserProfileAccess: true,
    cacheWasWarmedByRealReads: true, deadlineMs: 240_000 };
  verificationProgress.libraryRepair = result;
  async function bounded(name, work) {
    let timer;
    try { return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} exceeded the repair-check deadline.`)), result.deadlineMs);
    })]); } finally { clearTimeout(timer); }
  }
  // Finish ordinary navigation-triggered synchronization before corrupting a
  // file, so only the following explicit sync is responsible for repairing it.
  const expectedDay = await bounded('Repair preflight read', () => page.evaluate(() => window.dailyCF.getDay()));
  const before = gitStoreSnapshot(contentDirectory);
  if (before.storageFormat !== 'generation-pointer-v1') throw new Error('Repair verification requires an active generation.');
  const profileRoot = fs.realpathSync.native(profile);
  const expectedContent = path.join(profileRoot, ...expectedRepository.split('/'));
  if (!samePath(expectedContent, fs.realpathSync.native(contentDirectory))) throw new Error('Repair test directory is outside its own profile.');
  const gitdir = path.join(contentDirectory, 'library.git', before.generation);
  const packDirectory = path.join(gitdir, 'objects', 'pack');
  const packName = fs.readdirSync(packDirectory).filter(name => /^pack-[0-9a-f]{40}\.pack$/.test(name)).sort()[0];
  if (!packName) throw new Error('No ordinary pack file is available for the isolated corruption test.');
  const packPath = path.resolve(packDirectory, packName);
  const relative = path.relative(profileRoot, packPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
    || !samePath(fs.realpathSync.native(packPath), packPath)) throw new Error('Refusing to modify a pack outside the owned profile.');
  const packStat = fs.lstatSync(packPath);
  if (!packStat.isFile() || packStat.isSymbolicLink() || packStat.nlink !== 1 || packStat.size < 128) {
    throw new Error('The selected corruption-test pack is not a safe regular file.');
  }
  const hashPack = () => crypto.createHash('sha256').update(fs.readFileSync(packPath)).digest('hex');
  const originalHash = hashPack();
  await page.evaluate(() => {
    window.__packageRepairProgress = [];
    window.__packageRepairUnsubscribe = window.dailyCF.onLibrarySync(value => {
      window.__packageRepairProgress.push({ phase: value.phase, revision: value.revision, message: value.message });
    });
  });
  try {
    const handle = fs.openSync(packPath, 'r+');
    const offset = 64; // Payload, after the 12-byte PACK header and before its trailing checksum.
    let originalByte;
    try {
      const opened = fs.fstatSync(handle);
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== packStat.ino || opened.dev !== packStat.dev) {
        throw new Error('The owned pack changed while opening the corruption fixture.');
      }
      const byte = Buffer.alloc(1);
      if (fs.readSync(handle, byte, 0, 1, offset) !== 1) throw new Error('Could not read the fixture byte.');
      originalByte = byte[0]; byte[0] ^= 1;
      if (fs.writeSync(handle, byte, 0, 1, offset) !== 1) throw new Error('Could not write the fixture byte.');
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    const corruptedHash = hashPack();
    result.before = before;
    result.corruption = { pathWithinOwnedProfile: relative.split(path.sep).join('/'), bytes: packStat.size,
      offset, originalByte, changedByte: originalByte ^ 1, originalSha256: originalHash, corruptedSha256: corruptedHash };
    if (originalHash === corruptedHash || fs.statSync(packPath).size !== packStat.size) throw new Error('The pack corruption fixture was not created as intended.');
    console.log('One pack payload byte changed only inside the owned temporary profile; verifying real repair after warmed reads.');
    const startedAt = Date.now();
    const synchronized = await bounded('Actual corrupted-library repair', () => page.evaluate(() => window.dailyCF.syncLibrary()));
    result.repairElapsedMs = Date.now() - startedAt;
    result.synchronized = synchronized;
    const repaired = gitStoreSnapshot(contentDirectory);
    result.after = repaired;
    if (repaired.generation === before.generation || repaired.storageFormat !== 'generation-pointer-v1'
      || repaired.revision !== synchronized.revision) throw new Error('Corruption did not publish a newly verified Git generation.');
    const progress = await page.evaluate(() => window.__packageRepairProgress);
    result.progress = progress;
    if (!progress.some(value => value.phase === 'repairing')
      || !progress.some(value => value.phase === 'ready' && value.revision === repaired.revision)) {
      throw new Error('The actual worker did not report repair followed by the newly verified snapshot.');
    }
    const contents = await bounded('Read the repaired official snapshot', () => page.evaluate(async () => {
      const day = await window.dailyCF.getDay(undefined, true);
      const archive = await window.dailyCF.getLocalLibraryView({ kind: 'archive', scope: 'all' });
      return { day, archive };
    }));
    const finalStore = gitStoreSnapshot(contentDirectory);
    const days = contents.archive?.kind === 'archive' ? Object.values(contents.archive.index ?? {}).flat() : [];
    if (!contents.day.sourceUrl.includes(`/blob/${finalStore.revision}/`) || !contents.day.problems.length
      || contents.archive?.revision !== finalStore.revision || !days.length
      || !days.every(day => day.sourceUrl.includes(`/blob/${finalStore.revision}/`))) {
      throw new Error('The repaired generation did not return a consistent real official day and complete archive.');
    }
    const sameRevision = before.revision === finalStore.revision;
    if (sameRevision && (contents.day.date !== expectedDay.date
      || JSON.stringify(contents.day.problems) !== JSON.stringify(expectedDay.problems)
      || (verificationProgress.archiveReuse?.initial?.cards?.count && days.reduce((count, day) => count + day.problems.length, 0)
        !== verificationProgress.archiveReuse.initial.cards.count))) throw new Error('Repaired same-revision content differs from the verified original.');
    result.validatedContent = { revision: finalStore.revision, sameRevision, date: contents.day.date,
      latestProblemCount: contents.day.problems.length, monthCount: contents.archive.snapshot.months.length,
      dayCount: days.length, problemCount: days.reduce((count, day) => count + day.problems.length, 0), sourceUrlsMatchRevision: true };
    result.oldCorruptedGenerationRetained = fs.existsSync(gitdir) && hashPack() === corruptedHash;
    if (!result.oldCorruptedGenerationRetained) throw new Error('The repair modified or removed the old corruption-test generation.');
    result.noClaimAboutOtherTamperVariants = true;
    result.passed = true;
    console.log('Packaged repair verified: warm caches did not hide the damaged pack; a fresh official generation was published and old data retained.');
    return result;
  } finally {
    await page.evaluate(() => {
      window.__packageRepairUnsubscribe?.(); delete window.__packageRepairUnsubscribe; delete window.__packageRepairProgress;
    }).catch(() => {});
  }
}

(async () => {
  if (presentationOnly && !localOnly) throw new Error('Presentation-only verification requires --local-only.');
  if ([oauthLayoutOnly, themeOnly, iconOnly, paletteResetOnly, bootstrapOnly, codeImportOnly].filter(Boolean).length > 1) throw new Error('Choose one presentation-only verification scope.');
  let priorReport;
  let remoteEvidence;
  if (localOnly) {
    if (verifyArchiveReuse || verifyLibraryRepair) throw new Error('Local-only mode cannot run actual archive reuse or library repair checks.');
    if (captureOnly || captureHome || resumeNativeSource || !remoteEvidenceSource) throw new Error('Local-only mode requires explicit earlier remote evidence and cannot capture or resume another run.');
    if (!['rate-limit', 'unchanged-backend', 'unchanged-github-backend', 'local-runtime-scope'].includes(remoteSkipReason)) throw new Error('Unknown remote-check skip reason.');
    remoteEvidence = JSON.parse(fs.readFileSync(path.resolve(workspace, remoteEvidenceSource), 'utf8'));
    if (!remoteEvidence.remoteRefresh?.passed || remoteEvidence.repository !== expectedRepository || !remoteEvidence.packageIdentity?.archive?.sha256) {
      throw new Error('Earlier remote evidence must identify the separate package and successful official read-only refresh.');
    }
  }
  if (resumeNativeSource) {
    priorReport = JSON.parse(fs.readFileSync(path.resolve(workspace, resumeNativeSource), 'utf8'));
    if (captureOnly || captureHome || priorReport.version !== manifest.version || priorReport.repository !== expectedRepository
      || !priorReport.isPackaged || !priorReport.fromArchive || !priorReport.isolatedProfile || !priorReport.noGitHubWrites
      || !priorReport.noDefaultAuthor || !priorReport.noHandleSubmissionAPI
      || !priorReport.clipboard?.passed || !priorReport.clipboard?.restored || !priorReport.remoteRefresh?.passed
      || !priorReport.homeScreenshot?.captured || priorReport.homeScreenshot.version !== manifest.version
      || !Number.isFinite(Date.parse(priorReport.checkedAt)) || fs.statSync(archive).mtimeMs > Date.parse(priorReport.checkedAt)) {
      throw new Error('Native-close resumption requires completed current-package prerequisite evidence and an unchanged archive.');
    }
    priorReport = { ...priorReport, passed: false, resumedNativeCloseFrom: resumeNativeSource,
      prerequisiteCheckedAt: priorReport.checkedAt, nativeCloseCheckedAt: new Date().toISOString(),
      earlierDriverError: priorReport.error, verificationMode: 'separate prerequisite and native-close runs' };
    delete priorReport.error;
  } else if (captureOnly) {
    priorReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    if (!priorReport.passed || priorReport.version !== manifest.version || priorReport.repository !== expectedRepository) {
      throw new Error('Capture-only mode requires a successful runtime report for this version and repository.');
    }
  } else {
    fs.writeFileSync(reportFile, JSON.stringify({ passed: false, state: 'running', checkedAt: new Date().toISOString(),
      version: manifest.version, repository: expectedRepository, noGitHubWrites: true }, null, 2) + '\n');
  }
  const files = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'));
  const main = asar.extractFile(archive, path.join('dist-electron', 'main.cjs')).toString('utf8');
  const packagedManifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (packagedManifest.version !== manifest.version || !main.includes('user-data-dir')) {
    throw new Error('Rebuild the current package with isolated-profile support before running this verification.');
  }
  if (files.some(name => name.startsWith('/dist-electron/') && !['/dist-electron/main.cjs', '/dist-electron/preload.cjs', '/dist-electron/library-worker.cjs'].includes(name))) {
    throw new Error('Unexpected development bundle in the packaged Electron directory.');
  }
  if (files.some(name => /(?:^|\/)(?:\.env(?:\..*)?|integration\.[cm]?js|session\.enc)$/.test(name))) {
    throw new Error('Unexpected development configuration or session file in the package.');
  }
  if (!main.includes(expectedRepository) || main.includes('Daily_CF_Problems_Client_Test')) {
    throw new Error('The packaged main process does not target the official repository.');
  }
  if (!files.some(name => name.endsWith('/dist-electron/preload.cjs'))) throw new Error('Packaged preload missing.');
  if (!files.includes('/dist-electron/library-worker.cjs')) throw new Error('Packaged Git library worker missing.');
  const worker = asar.extractFile(archive, path.join('dist-electron', 'library-worker.cjs'));
  if (!worker.includes(expectedRepository) || worker.includes('Daily_CF_Problems_Client_Test')) {
    throw new Error('The packaged Git library worker does not target the official repository.');
  }
  const packageIdentity = { recordedAt: new Date().toISOString(), archive: { path: path.relative(workspace, archive).replaceAll('\\', '/'),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') },
    executable: { path: path.relative(workspace, executable).replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') } };
  const embeddedIcons = iconOnly ? verifyEmbeddedIcons(workspace, executable, manifest.version) : undefined;
  const rendererBundle = bootstrapOnly || codeImportOnly ? verifyCurrentRendererBundle(files) : undefined;

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(temporaryRoot, 'daily-cf-package-check-'));
  const emptySearchPath = path.join(profile, 'empty-executable-search-path');
  fs.mkdirSync(emptySearchPath);
  // Only the test child's search path changes. The product must synchronize with
  // bundled JavaScript, without finding an external git executable in PATH.
  env.PATH = emptySearchPath;
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' && key !== 'PATH') delete env[key];
  const contentDirectory = path.join(profile, ...expectedRepository.split('/'));
  fs.mkdirSync(contentDirectory, { recursive: true });
  // Harmless fixtures in our own profile verify upgrade cleanup without reading user data.
  const legacyRemoteFiles = ['library.json', 'day-latest.json', 'day-2000-01-01.json'];
  for (const name of legacyRemoteFiles) fs.writeFileSync(path.join(contentDirectory, name), '{"packageVerificationFixture":true}\n');
  fs.writeFileSync(path.join(contentDirectory, 'data.json'), JSON.stringify({ settings: { language: 'py', theme: 'light', uiLanguage: 'zh-CN' } }) + '\n');
  let application;
  let child;
  let report;
  try {
    application = await electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env, timeout: 30_000 });
    child = application.process();
    const packageInfo = await application.evaluate(({ app }) => ({ isPackaged: app.isPackaged,
      fromArchive: app.getAppPath().endsWith('app.asar'), userData: app.getPath('userData') }));
    if (!samePath(packageInfo.userData, profile)) throw new Error('Packaged app did not use the isolated verification profile.');
    const page = await application.firstWindow();
    let unexpectedDialogError;
    page.on('dialog', dialog => {
      // Electron handles beforeunload through will-prevent-unload and our custom
      // settings modal. Chromium may still emit a CDP dialog event with no native
      // dialog behind it; suppress Playwright's automatic unhandled dismissal.
      if (dialog.type() === 'beforeunload') return;
      void dialog.dismiss().catch(error => { unexpectedDialogError = error; });
    });
    await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
    await page.waitForFunction(() => Boolean(window.dailyCF), { timeout: 15_000 });
    const info = await page.evaluate(async () => {
      const boot = await window.dailyCF.bootstrap();
      return { repository: boot.repository, version: boot.version, oauthConfigured: boot.auth.configured,
        secureStorage: boot.auth.secureStorage, desktopBridge: window.dailyCF.isDesktop,
        nodeIntegrationOff: typeof window.require === 'undefined',
        clipboardWriteAvailable: typeof window.dailyCF.copyText === 'function',
        uploadAvailable: typeof window.dailyCF.importCode === 'function',
        externalOpenAvailable: typeof window.dailyCF.openExternal === 'function',
        noEmbeddedStatementAPI: ['getStatement', 'getStatementInBrowser', 'cancelStatementBrowser', 'openStatementLink'].every(name => typeof window.dailyCF[name] === 'undefined'),
        remoteContributionsAvailable: typeof window.dailyCF.getContributions === 'function',
        gitLibrarySyncAvailable: typeof window.dailyCF.syncLibrary === 'function' && typeof window.dailyCF.onLibrarySync === 'function',
        localLibraryViewAvailable: typeof window.dailyCF.getLocalLibraryView === 'function',
        archiveSnapshotAvailable: typeof window.dailyCF.getArchiveSnapshot === 'function' && typeof window.dailyCF.getMonthFromSnapshot === 'function',
        inspectSubmissionFileAvailable: typeof window.dailyCF.inspectSubmissionFile === 'function',
        noPullRequestMutationAPI: ['getOpenPullRequests', 'previewSubmission', 'submit'].every(name => typeof window.dailyCF[name] === 'undefined'),
        noHandleSubmissionAPI: typeof window.dailyCF.getHandleSubmissions === 'undefined',
        noDefaultAuthor: !Object.hasOwn(boot.settings, 'author'),
        retainedLocalPreference: boot.settings.language === 'py',
        seededInterfaceLanguage: boot.settings.uiLanguage,
        systemLanguages: boot.systemLanguages,
        batchSubmissionAvailable: typeof window.dailyCF.previewBatchSubmission === 'function' && typeof window.dailyCF.submitBatch === 'function',
        freshSession: boot.auth.user === null,
        noLegacyCodeStorageAPI: ['saveDraft', 'deleteDraft', 'exportCode', 'getHistory'].every(name => typeof window.dailyCF[name] === 'undefined'),
        noDraftOrLocalHistoryState: !Object.hasOwn(boot, 'drafts') && !Object.hasOwn(boot, 'history') };
    });
    const expectedVersion = manifest.version;
    if (info.repository !== expectedRepository || info.version !== expectedVersion || !info.oauthConfigured
      || !info.desktopBridge || !info.nodeIntegrationOff || !info.uploadAvailable || !info.remoteContributionsAvailable
      || !info.clipboardWriteAvailable || !info.externalOpenAvailable || !info.noEmbeddedStatementAPI
      || !info.batchSubmissionAvailable || !info.inspectSubmissionFileAvailable || !info.noPullRequestMutationAPI || !info.freshSession
      || !info.gitLibrarySyncAvailable || !info.localLibraryViewAvailable || !info.archiveSnapshotAvailable
      || !info.noHandleSubmissionAPI || !info.noDefaultAuthor || !info.retainedLocalPreference
      || info.seededInterfaceLanguage !== 'zh-CN' || !Array.isArray(info.systemLanguages)
      || info.systemLanguages.length === 0 || !info.systemLanguages.every(value => typeof value === 'string' && value.length > 0)
      || !info.noLegacyCodeStorageAPI || !info.noDraftOrLocalHistoryState || !packageInfo.isPackaged || !packageInfo.fromArchive) {
      throw new Error('Packaged bootstrap verification failed.');
    }
    report = priorReport || { passed: true, checkedAt: new Date().toISOString(), executable: path.relative(workspace, executable).replaceAll('\\', '/'),
      noGitHubWrites: true, noTestBundleOrSession: true, isolatedProfile: true, ...info,
      isPackaged: packageInfo.isPackaged, fromArchive: packageInfo.fromArchive };
    report.packageIdentity = packageIdentity;
    if (embeddedIcons) report.embeddedIcons = embeddedIcons;
    if (rendererBundle) report.rendererBundle = rendererBundle;
    report.bundledLibraryWorker = { path: 'dist-electron/library-worker.cjs', presentInAsar: true,
      bytes: worker.length, sha256: crypto.createHash('sha256').update(worker).digest('hex') };
    report.externalGitExcludedFromSearchPath = true;
    report.legacyRemoteCacheCleanupVerified = legacyRemoteFiles.every(name => !fs.existsSync(path.join(contentDirectory, name)));
    if (!report.legacyRemoteCacheCleanupVerified) throw new Error('Packaged startup did not remove its isolated legacy remote-content fixtures.');
    verificationProgress = report;
    if (!captureOnly && !resumeNativeSource) {
      if (!presentationOnly) {
        report.clipboard = await verifyClipboard(application, page);
        console.log('Packaged bootstrap and system clipboard verified; clipboard restored or newer user content preserved.');
      }
      if (localOnly) {
        report.verificationMode = 'current-package local runtime only';
        report.remoteRepeatSkipped = true;
        report.remoteRepeatSkippedReason = remoteSkipReason;
        report.remoteRepeatSkippedRateLimit = remoteSkipReason === 'rate-limit';
        report.remoteRefresh = { executed: false, readOnly: true, reason: remoteSkipReason === 'local-runtime-scope'
          ? 'This package verification covers local runtime behavior only. Dedicated remote requests were not included; the earlier read-only evidence is historical and does not validate this build or its redesigned submission backend.'
          : remoteSkipReason !== 'rate-limit'
            ? 'The Git transport and GitHub submission backends are unchanged. Dedicated remote synchronization/read checks were not repeated; earlier evidence belongs to a separate package and is not a remote verification of this build.'
            : 'Earlier full retry reached the GitHub unauthenticated rate limit; no forced remote refresh was repeated for this build.' };
        report.priorRemoteEvidence = { source: remoteEvidenceSource, version: remoteEvidence.version,
          sameBuild: false, historicalBuildLabel: remoteEvidence.historicalBuildLabel,
          packageIdentity: remoteEvidence.packageIdentity, remoteRefresh: remoteEvidence.remoteRefresh };
        report.homeScreenshot = { captured: false, skipped: true, reason: 'No network-dependent screenshot repeated for this build; the prior-build real screenshot remains explicitly historical.' };
        report.retainedLocalCards = { executed: false, reason: 'This local-runtime verification does not seed a persisted Git library. Retained-content presentation is covered by the separately recorded focused fixture UI checks.' };
      } else {
      try {
        report.remoteRefresh = await verifyGitLibrary(page, contentDirectory);
        if (verifyArchiveReuse) report.archiveReuse = await verifyPackagedArchiveReuse(application, page, contentDirectory);
        if (verifyLibraryRepair) report.libraryRepair = await verifyPackagedLibraryRepair(page, profile, contentDirectory);
      } catch (error) {
        report.remoteRefresh = { ...report.remoteRefresh, passed: false, repository: expectedRepository, readOnly: true, error: error.message };
        throw new Error('Read-only official refresh verification failed: ' + error.message);
      }
      }
    }
    if (captureHome) {
      // Use the same isolated window and real repository data; never substitute fixtures.
      try {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator('.problem-card').first().waitFor({ state: 'visible', timeout: 45_000 });
        await page.evaluate(() => document.fonts.ready);
        const title = await page.locator('.today-heading h1').textContent();
        if (title !== '最新题目') throw new Error('The packaged homepage did not display the latest-problems heading.');
        const heading = await page.locator('.today-heading p').textContent();
        const problemCount = await page.locator('.problem-card').count();
        const screenshot = path.join(workspace, 'docs/screenshots/home.png');
        console.log('Capturing the real official homepage without taking keyboard focus.');
        const captured = await application.evaluate(async ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.setContentSize(1440, 1000);
          window.webContents.setBackgroundThrottling(false);
          let timeout;
          try {
            window.showInactive();
            await new Promise(resolve => setTimeout(resolve, 250));
            const bitmap = await Promise.race([
              window.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 1000 }, { stayHidden: true, stayAwake: true }),
              new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Native page capture exceeded 10 seconds.')), 10_000); }),
            ]);
            if (bitmap.isEmpty()) throw new Error('Native page capture returned an empty image.');
            return { png: bitmap.toPNG().toString('base64'), size: bitmap.getSize() };
          } finally {
            clearTimeout(timeout);
            window.hide();
          }
        });
        fs.writeFileSync(screenshot, Buffer.from(captured.png, 'base64'));
        report.homeScreenshot = { captured: true, fixture: false, title, checkedAt: new Date().toISOString(),
          path: 'docs/screenshots/home.png', heading, problemCount, desktopBridge: info.desktopBridge, version: info.version, size: captured.size };
      } catch (error) {
        // Network failure does not invalidate bootstrap checks or replace the previous image.
        const pageStatus = await page.locator('main').innerText().catch(() => 'Page text unavailable.');
        report.homeScreenshot = { captured: false, fixture: false, reason: error.message, pageStatus: pageStatus.slice(0, 2000) };
      }
    }
    if (presentationOnly) {
      report.verificationMode = codeImportOnly ? 'current-package renderer identity, isolated bootstrap, actual code import IPC with stubbed native picker, and clean close'
        : bootstrapOnly ? 'current-package renderer identity, isolated bootstrap and clean close only'
        : paletteResetOnly ? 'current-package isolated bootstrap and default palette set reset UI/save/discard/reload'
        : iconOnly ? 'current-package file icon resources, isolated bootstrap, native window icon and clean close'
        : themeOnly ? 'current-package isolated bootstrap, named palette settings, and local data location actions' : 'current-package isolated bootstrap and OAuth presentation only';
      if (bootstrapOnly || codeImportOnly) {
        await page.getByRole('button', { name: '最新题目', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
        const visibleVersion = await page.locator('.sidebar-version').innerText();
        if (!visibleVersion.includes(manifest.version)) throw new Error('Renderer did not show the current version after bootstrap.');
        report.bootstrapOnly = { passed: true, rendererNavigationVisible: true, rendererVersionVisible: manifest.version,
          unrelatedFeatureChecksRepeated: false };
        if (codeImportOnly) report.codeImport = await verifyActualCodeImport(application, page, profile);
      }
      else if (paletteResetOnly) report.paletteReset = await verifyPaletteReset(page, contentDirectory);
      else if (iconOnly) report.nativeWindowIcon = await verifyNativeWindowIcon(application, workspace, manifest.version);
      else if (themeOnly) {
        report.appearanceSettings = await verifyAppearanceSettings(application, page);
        report.localDataLocations = await verifyLocalDataLocations(application, page, contentDirectory);
      }
      else report.oauthLayout = await verifyOAuthLayout(page);
      report.extendedLocalChecksRepeated = false;
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await waitForProcessExit(child);
      report.cleanNativeCloseVerified = true;
    } else if (!captureOnly) {
      report.externalProblemLink = await verifyExternalProblemLink(application, page);
      report.oauthSettingsWarning = await verifyOAuthSettingsWarning(page);
      report.oauthDefaultRestore = await verifyOAuthDefaultRestore(page, contentDirectory);
      report.interfaceLanguage = await verifyInterfaceLanguage(application, page, contentDirectory);
      console.log('English settings persistence and native language verified; Chinese restored.');
      console.log('Checking native window close with unsaved settings.');
      Object.assign(report, await verifyNativeCloseGuard(application, page, child));
      report.queueNativeClose = await verifyNativeQueueClose(executable, env, profile, contentDirectory, report.remoteRefresh?.passed === true);
    }
    if (unexpectedDialogError) throw new Error('Unexpected native dialog handling failure during the isolated package check.');
  } catch (error) {
    verificationProgress.primaryError = error.message;
    throw error;
  } finally {
    // Close only the instance this script launched, before removing its own profile.
    if (application && child.exitCode === null && child.signalCode === null) {
      // A failed dirty-settings assertion must not strand the temporary test instance.
      // app.exit bypasses only this isolated instance's unsaved-settings prompt.
      try {
        await application.evaluate(({ app, BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy();
          // Return from the debugger evaluation before exiting its process.
          setImmediate(() => app.exit(0));
        });
        await waitForProcessExit(child);
      } catch (error) {
        verificationProgress.cleanupError = error.message;
        verificationProgress.temporaryProfileRemoved = false;
        if (!verificationProgress.primaryError) throw error;
      }
    }
    if (!verificationProgress.cleanupError) {
      removeOwnedProfile(profile, temporaryRoot);
      verificationProgress.temporaryProfileRemoved = !fs.existsSync(profile);
    }
  }
  report.passed = true;
  report.temporaryProfileRemoved = !fs.existsSync(profile);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
})().catch(error => {
  // A failed run must not leave a previous version's success as the latest report.
  const failure = { ...verificationProgress, passed: false, checkedAt: new Date().toISOString(), version: manifest.version,
    repository: expectedRepository, noGitHubWrites: true, error: error.message };
  fs.writeFileSync(reportFile, JSON.stringify(failure, null, 2) + '\n');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

