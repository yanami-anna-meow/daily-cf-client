// Focused restore-default-schemes checks with one Edge page and isolated fixture persistence.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installClientFixture } from './ui-fixture.mjs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const checks = [], screenshots = [], rendererErrors = [];
let server, browser, page, locale = 'zh-CN';
const label = (zh, en) => locale === 'en' ? en : zh;
try {
  mkdirSync('test-results', { recursive: true });
  server = await createServer({ server: { host: '127.0.0.1', port: 45173, strictPort: true }, logLevel: 'error' }); await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  await installClientFixture(page); await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => { const f = window.__uiTest; f.contributionRows = []; f.contributionIncomplete = false; f.contributionFilesTruncated = false; f.latestDay.problems = f.latestDay.problems.slice(0, 3); });
  const panel = () => page.locator('.appearance-settings');
  const schemes = () => page.getByRole('group', { name: label('配色方案', 'Color scheme'), exact: true });
  const resetButton = () => panel().getByRole('button', { name: label('恢复默认方案集', 'Restore default schemes'), exact: true });
  const confirmation = () => panel().getByRole('group', { name: label('恢复默认方案集？', 'Restore default color schemes?'), exact: true });
  const deletion = () => panel().getByRole('group', { name: label('删除配色方案？', 'Delete color scheme?'), exact: true });
  const cancel = group => group.getByRole('button', { name: label('取消', 'Cancel'), exact: true });
  const remove = () => panel().getByRole('button', { name: label('删除方案', 'Delete scheme'), exact: true });
  const saved = () => page.evaluate(async () => (await window.dailyCF.bootstrap()).settings);
  const saves = () => page.evaluate(() => window.__uiTest.saveSettingsRequests.length);
  const visibleState = () => page.evaluate(() => ({ paletteId: document.documentElement.dataset.paletteId, theme: document.documentElement.dataset.theme, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }));
  const draftIds = () => schemes().getByRole('button').evaluateAll(buttons => buttons.map(button => button.dataset.paletteId));
  const selectedId = () => schemes().locator('[aria-pressed="true"]').getAttribute('data-palette-id');
  const unrelated = settings => { const { palettes, paletteId, ...rest } = settings; return rest; };
  async function settings() { await page.getByRole('button', { name: label('设置', 'Settings'), exact: true }).click(); await schemes().waitFor(); }
  async function openReset() { await resetButton().click(); await confirmation().waitFor(); await page.waitForFunction(() => document.activeElement?.textContent === (document.documentElement.lang === 'en' ? 'Cancel' : '取消')); }
  async function confirmReset() { await confirmation().getByRole('button', { name: label('确认恢复', 'Restore schemes'), exact: true }).click(); await confirmation().waitFor({ state: 'detached' }); }
  async function save() {
    const before = await saves(); await page.locator('.page-heading').getByRole('button', { name: label('保存设置', 'Save settings'), exact: true }).click();
    await page.waitForFunction(before => window.__uiTest.saveSettingsRequests.length === before + 1 && !document.querySelector('.settings-form-fields')?.disabled, before);
  }
  async function capture(name, target) {
    const overflow = await page.evaluate(() => [...document.querySelectorAll('html,.appearance-settings,.appearance-group-heading,.appearance-scheme-actions,.palette-reset-confirm,.appearance-schemes,.palette-reset-confirm .confirm-actions')].filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map(el => el.className || el.tagName));
    assert.deepEqual(overflow, [], `${name} has no horizontal overflow`);
    const path = `test-results/appearance-restore-${name}-${version}-fixture.png`; await target.screenshot({ path, animations: 'disabled' }); screenshots.push(path); console.log(`Screenshot: ${path}`);
  }

  for (const language of ['zh-CN', 'en']) {
    locale = language; await page.setViewportSize({ width: 1440, height: 1200 });
    await page.goto(`http://127.0.0.1:45173/?localeFixture=1&uiLanguage=${language}&persistSettings=restore-defaults-${language}&validateSettings=1`, { waitUntil: 'networkidle' });
    const defaults = await page.evaluate(async language => {
      const defaults = (await import('/shared/appearance.ts')).createDefaultPalettes(language);
      const base = (await window.dailyCF.bootstrap()).settings;
      const changed = structuredClone(defaults[0]); changed.name = language === 'en' ? 'Edited original' : '修改过的原方案'; changed.light.accent = '#444444';
      const custom = { ...structuredClone(defaults[2]), id: 'fixture-custom', name: language === 'en' ? 'My blue' : '我的蓝色' };
      await window.dailyCF.saveSettings({ ...base, clientId: 'fixture-oauth-client', language: 'py', theme: 'system', forkRepository: 'ui-tester/renamed-fork', prTitleTemplate: 'Fixture {{date}}', prBodyTemplate: 'Fixture {{notes}}', palettes: [changed, custom], paletteId: custom.id });
      return defaults;
    }, language);
    await page.reload({ waitUntil: 'networkidle' }); await settings();
    const baseline = await saved(), baselineState = await visibleState(), before = await saves();
    assert.equal(baseline.paletteId, 'fixture-custom'); assert.equal(baseline.theme, 'system');
    await capture(`${language}-toolbar-1440`, panel().locator('.appearance-group-heading'));
    await openReset(); await capture(`${language}-confirmation-1440`, confirmation());
    assert.equal(await resetButton().getAttribute('aria-expanded'), 'true');
    await cancel(confirmation()).click(); assert.equal(await confirmation().count(), 0); assert(await resetButton().evaluate(el => el === document.activeElement));
    await openReset(); await page.keyboard.press('Escape'); assert.equal(await confirmation().count(), 0); assert(await resetButton().evaluate(el => el === document.activeElement));
    assert.deepEqual(await saved(), baseline); assert.equal(await saves(), before); assert.deepEqual(await visibleState(), baselineState);
    checks.push(`${language}: Cancel and Escape dismiss restoration without changes or writes and return focus to the restore button; initial focus goes to Cancel.`);

    await remove().click(); await deletion().waitFor(); await openReset(); assert.equal(await deletion().count(), 0);
    await remove().click(); await deletion().waitFor(); assert.equal(await confirmation().count(), 0); await cancel(deletion()).click();
    assert.deepEqual(await draftIds(), ['green', 'fixture-custom']); assert.equal(await saves(), before);
    checks.push(`${language}: Reset and single-scheme deletion confirmations are mutually exclusive and switching or cancelling neither mutates the schemes nor saves settings.`);

    await openReset(); await confirmReset(); assert.deepEqual(await draftIds(), ['green', 'pink', 'blue', 'mono']); assert.equal(await selectedId(), 'green');
    assert.deepEqual(await saved(), baseline); assert.equal(await saves(), before); assert.deepEqual(await visibleState(), baselineState);
    await page.getByRole('navigation', { name: label('主导航', 'Main navigation'), exact: true }).getByRole('button', { name: label('最新题目', 'Latest problems'), exact: true }).click();
    const leave = page.getByRole('dialog', { name: label('设置尚未保存', 'Unsaved settings'), exact: true });
    await leave.getByRole('button', { name: label('放弃修改', 'Discard changes'), exact: true }).click(); await settings();
    assert.deepEqual(await draftIds(), ['green', 'fixture-custom']); assert.equal(await selectedId(), 'fixture-custom'); assert.deepEqual(await saved(), baseline); assert.equal(await saves(), before);
    checks.push(`${language}: Confirm restores the four schemes only in the settings draft; the applied theme and persistence remain unchanged until Save. Discard restores the original customized list and selection.`);

    await page.setViewportSize({ width: 900, height: 1200 }); await capture(`${language}-toolbar-900`, panel().locator('.appearance-group-heading'));
    await openReset(); await capture(`${language}-confirmation-900`, confirmation()); await confirmReset(); await save();
    const restored = await saved(); assert.deepEqual(restored.palettes, defaults); assert.equal(restored.paletteId, 'green'); assert.deepEqual(unrelated(restored), unrelated(baseline));
    await page.waitForFunction(() => document.documentElement.dataset.paletteId === 'green');
    await page.reload({ waitUntil: 'networkidle' }); assert.deepEqual(await saved(), restored); await settings(); assert.deepEqual(await draftIds(), ['green', 'pink', 'blue', 'mono']); assert.equal(await selectedId(), 'green');
    assert.deepEqual(await schemes().locator('.appearance-scheme-label > span').allTextContents(), defaults.map(palette => palette.name));
    checks.push(`${language}: Save and reload retain the complete defaults in the displayed language and selected green; system appearance, OAuth ID, programming language, chosen fork, PR templates and interface language remain exact.`);
  }
  assert.deepEqual(rendererErrors, []);
  const report = { passed: true, fixture: true, version, boundary: 'Actual renderer and settingsInput; persistence is isolated fixture sessionStorage, not native disk.', checks, screenshots, rendererErrors };
  writeFileSync(`test-results/restore-palette-defaults-${version}.json`, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: `test-results/restore-palette-defaults-failure-${version}.png`, animations: 'disabled' }).catch(() => {});
  const failure = { passed: false, fixture: true, version, checks, screenshots, rendererErrors, error: String(error) };
  writeFileSync(`test-results/restore-palette-defaults-${version}-failure.json`, `${JSON.stringify(failure, null, 2)}\n`); console.error(JSON.stringify(failure)); throw error;
} finally { await browser?.close(); await server?.close(); }

