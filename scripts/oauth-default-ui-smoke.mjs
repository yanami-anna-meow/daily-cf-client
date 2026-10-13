// Explicit renderer fixture with simulated settings persistence; no real GitHub writes.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installClientFixture } from './ui-fixture.mjs';

const version = '0.3.11';
const packagedId = 'Ov23FixturePackagedDefault';
const mistakenId = 'Iv1FixtureMistakenCustom';
const checks = [];
const screenshots = [];
const rendererErrors = [];
let server;
let browser;
let page;
try {
  mkdirSync('test-results', { recursive: true });
  server = await createServer({ server: { host: '127.0.0.1', port: Number(process.env.UI_TEST_PORT || 45173), strictPort: true }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  const channel = process.env.UI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  await installClientFixture(page);
  await page.addInitScript(() => {
    // The real desktop persists settings. This focused fixture simulates only that storage
    // boundary; the packaged default always comes from the original bootstrap independently.
    if (!new URL(location.href).searchParams.has('persistOAuthDefault')) return;
    const api = window.dailyCF;
    const bootstrap = api.bootstrap;
    const saveSettings = api.saveSettings;
    const key = 'oauth-default-smoke-settings';
    api.bootstrap = async () => {
      const boot = await bootstrap();
      const saved = sessionStorage.getItem(key);
      return saved ? { ...boot, settings: JSON.parse(saved) } : boot;
    };
    api.saveSettings = async value => {
      const settings = await saveSettings(value);
      sessionStorage.setItem(key, JSON.stringify(settings));
      return settings;
    };
  });
  const base = `http://127.0.0.1:${address.port}/`;
  const advanced = page.locator('.advanced-settings');
  const clientId = page.getByLabel('OAuth Client ID');
  const reset = () => advanced.locator('.oauth-default-control').getByRole('button', { name: /^(恢复默认|Reset to default|Restore default)$/ });
  const confirmation = () => page.getByRole('dialog', { name: '确认更改 GitHub 登录配置？', exact: true });
  const saves = () => page.evaluate(() => window.__uiTest.saveSettingsRequests.length);
  const boot = () => page.evaluate(() => window.dailyCF.bootstrap());
  const save = () => page.locator('.page-heading').getByRole('button', { name: '保存设置', exact: true });
  async function openSettings(english = false) {
    await page.getByRole('button', { name: english ? 'Settings' : '设置', exact: true }).click();
    await advanced.locator('summary').click();
    await clientId.waitFor();
  }
  async function settled() {
    await page.waitForFunction(() => !document.querySelector('.settings-form-fields')?.disabled);
  }
  async function capture(name, target = advanced) {
    if (await page.locator('.toast button').count()) await page.locator('.toast button').click();
    if (target === advanced) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    const overflow = await page.evaluate(() => [...document.querySelectorAll('html, .settings-main, .advanced-settings, .oauth-settings-warning, .modal, .modal-body')].filter(element => element.getClientRects().length && element.scrollWidth > element.clientWidth + 1).map(element => element.className || element.tagName));
    assert.deepEqual(overflow, [], `${name}: no horizontal overflow`);
    const path = `test-results/oauth-default-${name}-${version}-fixture.png`;
    await target.screenshot({ path, animations: 'disabled' });
    screenshots.push({ path, fixture: true });
  }

  await page.goto(`${base}?${new URLSearchParams({ localeFixture: '1', uiLanguage: 'zh-CN', oauthClientId: mistakenId, defaultClientId: packagedId, persistOAuthDefault: '1' })}`, { waitUntil: 'networkidle' });
  await openSettings();
  assert.equal(await clientId.inputValue(), mistakenId);
  assert.equal((await boot()).defaultClientId, packagedId);
  assert.equal(await advanced.locator('.oauth-default-control > small').count(), 0);
  await page.getByLabel('默认编程语言').selectOption('py');
  await reset().click();
  assert.equal(await clientId.inputValue(), packagedId);
  assert.equal(await page.getByLabel('默认编程语言').inputValue(), 'py');
  assert.equal(await saves(), 0);
  assert.equal((await boot()).settings.clientId, mistakenId, 'Restore changes the form only.');
  assert(await reset().isDisabled());
  assert.equal(await advanced.locator('.oauth-default-control > small').count(), 0);
  assert(await page.locator('.settings-save-bar').getByRole('button', { name: '保存设置', exact: true }).isEnabled());
  await capture('restored-unsaved-zh-1440');
  checks.push('Restoring a mistaken saved ID copies the separate packaged default into the form, retains another dirty preference, enables Save, disables redundant restore and makes no persistence request.');

  await save().click();
  await confirmation().waitFor();
  assert.deepEqual(await confirmation().locator('.oauth-change-values dd').allTextContents(), [mistakenId, packagedId]);
  await capture('save-confirmation-zh-1440', confirmation());
  await confirmation().getByRole('button', { name: '取消', exact: true }).click();
  await settled();
  assert.equal(await saves(), 0);
  assert.equal(await clientId.inputValue(), packagedId);
  assert.equal((await boot()).settings.clientId, mistakenId);
  await page.getByRole('button', { name: '提交记录', exact: true }).click();
  const leave = page.getByRole('dialog', { name: '设置尚未保存', exact: true });
  await leave.waitFor();
  await leave.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await clientId.inputValue(), packagedId);
  await save().click();
  await confirmation().getByRole('button', { name: '确认更改并保存', exact: true }).click();
  await settled();
  assert.equal(await saves(), 1);
  const saved = await boot();
  assert.equal(saved.settings.clientId, packagedId);
  assert.equal(saved.settings.language, 'py');
  assert.equal(saved.defaultClientId, packagedId);
  await page.reload({ waitUntil: 'networkidle' });
  await openSettings();
  assert.equal(await clientId.inputValue(), packagedId);
  assert.equal(await page.getByLabel('默认编程语言').inputValue(), 'py');
  assert.equal((await boot()).defaultClientId, packagedId);
  assert(await reset().isDisabled());
  assert(await page.locator('.settings-save-bar').getByRole('button', { name: '保存设置', exact: true }).isDisabled());
  checks.push('Restore follows OAuth confirmation and unsaved-leave protection; cancellation preserves the draft without saving, explicit confirmation persists both edits once, and reload keeps the installed default independent and redundant restore disabled.');

  await page.getByLabel('界面语言').selectOption('en');
  await page.getByRole('group', { name: '外观主题', exact: true }).getByRole('button', { name: '深色', exact: true }).click();
  await save().click();
  await page.waitForFunction(() => document.documentElement.lang === 'en' && document.documentElement.dataset.theme === 'dark');
  await page.setViewportSize({ width: 900, height: 650 });
  await clientId.fill('Iv1UnsavedEnglishMistake');
  await reset().click();
  assert.equal(await clientId.inputValue(), packagedId);
  assert(await reset().isDisabled());
  await capture('restored-en-dark-900');
  checks.push('English restore uses the same installed default, and the complete warning and restore action remain readable without horizontal overflow at 900px in dark mode.');

  await page.goto(`${base}?${new URLSearchParams({ localeFixture: '1', uiLanguage: 'zh-CN', oauthClientId: mistakenId, defaultClientId: '' })}`, { waitUntil: 'networkidle' });
  await openSettings();
  assert.equal((await boot()).defaultClientId, '');
  assert(await reset().isDisabled());
  assert(await advanced.getByText('此版本未内置 OAuth Client ID，无法恢复默认。可手动填写，或使用个人访问令牌登录。', { exact: true }).isVisible());
  await reset().evaluate(element => element.click());
  assert.equal(await clientId.inputValue(), mistakenId);
  assert.equal(await saves(), 0);
  assert.equal((await boot()).settings.clientId, mistakenId);
  await capture('unavailable-zh-900');
  checks.push('A build without an embedded ID explains why restore is unavailable, leaves the existing custom ID intact even on attempted activation and sends no save request.');

  assert.deepEqual(rendererErrors, []);
  const report = { passed: true, fixture: true, version, completedAt: new Date().toISOString(), checks, screenshots, rendererErrors };
  writeFileSync(`test-results/oauth-default-ui-${version}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = { passed: false, fixture: true, version, checks, screenshots, rendererErrors, error: String(error) };
  if (page && !page.isClosed()) {
    await page.screenshot({ path: `test-results/oauth-default-ui-failure-${version}-fixture.png`, animations: 'disabled' }).catch(() => {});
    report.dialogs = await page.getByRole('dialog').allTextContents();
  }
  writeFileSync(`test-results/oauth-default-ui-${version}-failure.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.error(JSON.stringify(report));
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
