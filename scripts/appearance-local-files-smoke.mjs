// Focused 0.3.16 renderer checks. One Edge page; all OS open calls are fixture-only.
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
  server = await createServer({ server: { host: '127.0.0.1', port: Number(process.env.UI_TEST_PORT || 45173), strictPort: true }, logLevel: 'error' });
  await server.listen(); const address = server.httpServer.address(); assert(address && typeof address !== 'string');
  const channel = process.env.UI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  await installClientFixture(page);
  await page.addInitScript(() => {
    const f = window.__uiTest; f.contributionRows = []; f.contributionIncomplete = false; f.contributionFilesTruncated = false;
    f.latestDay.problems = f.latestDay.problems.slice(0, 3);
    f.localPaths.dataDirectory = 'C:\\Users\\ui_tester\\AppData\\Roaming\\daily-cf-client\\A deliberately long profile directory with spaces\\用于检查中英文路径换行的目录\\' + 'long-folder-name-'.repeat(8);
    f.localPaths.configFile = `${f.localPaths.dataDirectory}\\settings.json`;
  });
  await page.emulateMedia({ colorScheme: 'light' });
  const url = params => `http://127.0.0.1:${address.port}/?localeFixture=1&validateSettings=1&${params}`;
  const local = () => page.locator('.local-data-settings');
  const settings = async () => { await page.getByRole('button', { name: label('设置', 'Settings'), exact: true }).click(); await local().waitFor(); };
  const home = async () => { await page.getByRole('navigation').getByRole('button', { name: label('最新题目', 'Latest problems'), exact: true }).click(); await page.locator('.problem-card').first().waitFor(); };
  const saved = () => page.evaluate(async () => (await window.dailyCF.bootstrap()).settings);
  const saveCount = () => page.evaluate(() => window.__uiTest.saveSettingsRequests.length);
  const scheme = id => page.getByRole('group', { name: label('配色方案', 'Color scheme'), exact: true }).locator(`button[data-palette-id="${id}"]`);
  async function save() {
    const before = await saveCount(); await page.locator('.page-heading').getByRole('button', { name: label('保存设置', 'Save settings'), exact: true }).click();
    await page.waitForFunction(before => window.__uiTest.saveSettingsRequests.length === before + 1 && !document.querySelector('.settings-form-fields')?.disabled, before);
  }
  async function verifyHome(id, accent, primary) {
    await page.mouse.move(0, 0);
    await page.waitForFunction(({ id, accent, primary }) => {
      const root = document.documentElement, css = getComputedStyle(root), rgb = value => { const style = document.createElement('span').style; style.color = value; return style.color; };
      const nav = document.querySelector('nav .nav-item.active'), actions = [...document.querySelectorAll('.problem-card-footer .text-button')], button = document.querySelector('.topbar-actions .button-primary');
      return root.dataset.paletteId === id && css.getPropertyValue('--accent').trim() === accent && css.getPropertyValue('--primary-bg').trim() === primary && nav && getComputedStyle(nav).color === rgb(accent) && actions.length && actions.every(el => getComputedStyle(el).color === rgb(accent)) && button && getComputedStyle(button).backgroundColor === rgb(primary);
    }, { id, accent, primary });
  }
  async function layout(name) {
    const overflow = await page.evaluate(() => [...document.querySelectorAll('html, .settings-main, .settings-section, .local-data-row, .local-data-row code')].filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map(el => el.className || el.tagName));
    assert.deepEqual(overflow, [], `${name}: no horizontal overflow`);
  }
  async function capture(name, target = page) {
    if (await page.locator('.toast button').count()) await page.locator('.toast button').click();
    await page.mouse.move(0, 0); await layout(name);
    const path = `test-results/appearance-${name}-${version}-fixture.png`; await target.screenshot({ path, animations: 'disabled' }); screenshots.push({ path, fixture: true, viewport: page.viewportSize() });
  }

  await page.goto(url('uiLanguage=zh-CN&persistSettings=appearance-local-files&localPathsFailure=1'), { waitUntil: 'networkidle' });
  await verifyHome('green', '#287950', '#c4e3cc'); await capture('home-default-green-light-1440');
  assert.equal((await saved()).paletteId, undefined, 'Missing stored palette selection exercises application default.');
  checks.push('Fresh settings with no palette selection render green; initial accents and pale green button match the green scheme.');

  await settings(); await local().getByRole('alert').filter({ hasText: 'Fixture file locations unavailable' }).waitFor();
  assert.equal(await local().getByRole('button', { name: '打开数据目录', exact: true }).count(), 0);
  const readsBefore = await page.evaluate(() => window.__uiTest.localPathsRequests);
  await page.evaluate(() => { window.__uiTest.localPathsFailure = false; }); await local().getByRole('button', { name: '重试', exact: true }).click();
  await local().getByRole('button', { name: '打开数据目录', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__uiTest.localPathsRequests), readsBefore + 1); assert.equal(await local().getByRole('alert').count(), 0);
  checks.push('An initial file-location failure is inline, exposes no stale open buttons, and Retry obtains current paths successfully.');

  const beforePink = await saveCount(); await scheme('pink').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.paletteId), 'green', 'Draft palette choice waits for Save.');
  await save(); assert.equal(await saveCount(), beforePink + 1); await home(); await verifyHome('pink', '#fb7299', '#f8bed0');
  await capture('home-pink-light-1440'); await capture('card-actions-pink-light', page.locator('.problem-card').first());
  await page.reload({ waitUntil: 'networkidle' }); await verifyHome('pink', '#fb7299', '#f8bed0'); assert.equal((await saved()).paletteId, 'pink');
  checks.push('Choosing and saving pink renders exact #fb7299 on actual card actions and active navigation, keeps button #f8bed0, and retains the user choice after reload.');

  await settings(); await page.evaluate(() => { window.__uiTest.localPathsFailure = false; });
  // Reload preserves query error injection, so exercise the existing retry before actions.
  if (await local().getByRole('button', { name: '重试', exact: true }).count()) await local().getByRole('button', { name: '重试', exact: true }).click();
  const configButton = local().getByRole('button', { name: '打开配置文件位置', exact: true });
  const dataButton = local().getByRole('button', { name: '打开数据目录', exact: true }); await configButton.waitFor();
  const savedBeforeOpen = await saved(), savesBeforeOpen = await saveCount();
  await page.locator('.palette-editor').getByRole('textbox', { name: '方案名称', exact: true }).fill('尚未保存的粉色名称');
  await page.evaluate(() => { window.__uiTest.localPathOpenDelay = 400; });
  await configButton.evaluate(el => { el.click(); el.click(); });
  assert.equal(await dataButton.isDisabled(), true); await configButton.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.local-data-row button')?.disabled);
  assert.deepEqual(await page.evaluate(() => window.__uiTest.localPathOpenRequests), ['config']);
  await page.evaluate(() => { window.__uiTest.localPathOpenDelay = 0; window.__uiTest.localPathOpenFailure = true; });
  await dataButton.click(); await local().getByRole('alert').filter({ hasText: 'Fixture file manager failed' }).waitFor();
  await page.evaluate(() => { window.__uiTest.localPathOpenFailure = false; }); await dataButton.click();
  await page.waitForFunction(() => !document.querySelector('.local-data-row button')?.disabled && !document.querySelector('.local-data-settings [role="alert"]'));
  assert.deepEqual(await page.evaluate(() => window.__uiTest.localPathOpenRequests), ['config', 'data', 'data']);
  assert.equal(await saveCount(), savesBeforeOpen); assert.deepEqual(await saved(), savedBeforeOpen);
  assert.equal(await page.locator('.palette-editor').getByRole('textbox', { name: '方案名称', exact: true }).inputValue(), '尚未保存的粉色名称');
  checks.push('Configuration and data buttons send only their fixed targets; rapid repeated clicks produce one request, opening disables both buttons, and failed OS opens can retry. No action saves or discards pending settings.');

  for (const language of ['zh-CN', 'en']) for (const width of [1440, 900]) {
    locale = language; await page.setViewportSize({ width, height: 1050 });
    await page.goto(url(`uiLanguage=${language}`), { waitUntil: 'networkidle' }); await settings();
    await local().getByRole('button', { name: label('打开数据目录', 'Open data directory'), exact: true }).waitFor();
    const paths = await page.evaluate(() => window.__uiTest.localPaths); assert.deepEqual(await local().locator('code').allTextContents(), [paths.configFile, paths.dataDirectory]);
    await capture(`local-files-${language}-${width}`, local());
  }
  checks.push('Chinese and English local-file sections show exact paths and labeled actions at 1440px and 900px; long mixed-script paths wrap without horizontal overflow.');

  for (const language of ['zh-CN', 'en']) {
    locale = language; await page.goto(url(`uiLanguage=${language}&nonDesktop=1`), { waitUntil: 'networkidle' }); await settings();
    await local().getByText(label('请在桌面客户端中查看本地文件。', 'Open the desktop app to view local files.'), { exact: true }).waitFor();
    assert.equal(await local().getByRole('button').count(), 0); assert.equal(await page.evaluate(() => window.__uiTest.localPathsRequests), 0);
  }
  checks.push('Browser preview explains desktop-only access in both languages and invokes neither path lookup nor file-manager actions.');
  assert.deepEqual(rendererErrors, []);
  const result = { passed: true, fixture: true, version, completedAt: new Date().toISOString(), boundary: 'Real renderer and settingsInput with fixture sessionStorage; file manager calls are recorded, not executed.', checks, screenshots, rendererErrors };
  writeFileSync(`test-results/appearance-local-files-${version}.json`, `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const failure = { passed: false, fixture: true, version, checks, screenshots, rendererErrors, error: String(error) };
  if (page && !page.isClosed()) await page.screenshot({ path: `test-results/appearance-local-files-failure-${version}-fixture.png`, animations: 'disabled' }).catch(() => {});
  writeFileSync(`test-results/appearance-local-files-${version}-failure.json`, `${JSON.stringify(failure, null, 2)}\n`); console.error(JSON.stringify(failure)); throw error;
} finally { await browser?.close(); await server?.close(); }
