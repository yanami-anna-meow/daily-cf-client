// Explicit in-memory renderer fixture; no credentials or real GitHub writes.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installClientFixture } from './ui-fixture.mjs';

const version = '0.3.9';
const checks = [];
const screenshots = [];
const rendererErrors = [];
let server;
let browser;
let page;
let locale = 'zh-CN';
const labels = {
  'zh-CN': { settings: '设置', save: '保存设置', leave: '设置尚未保存', saveLeave: '保存并离开', keep: '继续编辑', history: '提交记录', title: '确认更改 GitHub 登录配置？', back: '取消', confirm: '确认更改并保存', caution: '谨慎修改', warning: '修改此项会影响 GitHub 授权登录', empty: '未配置' },
  en: { settings: 'Settings', save: 'Save settings', leave: 'Unsaved settings', saveLeave: 'Save and leave', keep: 'Keep editing', history: 'Contributions', title: 'Change GitHub sign-in settings?', back: 'Cancel', confirm: 'Confirm change and save', caution: 'Change with care', warning: 'Changing this affects GitHub sign-in', empty: 'Not configured' },
};
const words = () => labels[locale];
const previousId = 'Ov23FixtureTrustedAppA';
const nextId = 'Iv1FixtureTrustedAppB';
const retryId = 'Ov23FixtureRetryAppC';
const nativeId = 'Iv1FixtureNativeAppD';

try {
  mkdirSync('test-results', { recursive: true });
  server = await createServer({ server: { host: '127.0.0.1', port: Number(process.env.UI_TEST_PORT || 45173), strictPort: true }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  const channel = process.env.UI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  // The entire check, including both locales and sizes, uses this one page.
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  await installClientFixture(page);
  await page.goto(`http://127.0.0.1:${address.port}/?localeFixture=1&uiLanguage=zh-CN`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '最新题目', exact: true }).waitFor();
  await page.evaluate(() => {
    const original = window.dailyCF.saveSettings;
    const pending = new Map();
    window.__oauthTest = {
      calls: [], hold: false,
      release(id) { const resolve = pending.get(id); if (!resolve) throw new Error(`Missing pending save ${id}`); pending.delete(id); resolve(); },
    };
    window.dailyCF.saveSettings = async value => {
      const id = window.__oauthTest.calls.length + 1;
      const call = { id, value: structuredClone(value), pending: window.__oauthTest.hold, completed: false };
      window.__oauthTest.calls.push(call);
      if (call.pending) await new Promise(resolve => pending.set(id, resolve));
      call.pending = false;
      try { return await original(value); }
      finally { call.completed = true; }
    };
  });
  const advanced = page.locator('.advanced-settings');
  const clientId = page.getByLabel('OAuth Client ID');
  const dialog = () => page.getByRole('dialog', { name: words().title, exact: true });
  const leaveDialog = () => page.getByRole('dialog', { name: words().leave, exact: true });
  const saveButton = () => page.locator('.page-heading').getByRole('button', { name: words().save, exact: true });
  const calls = () => page.evaluate(() => window.__oauthTest.calls.length);
  const stored = () => page.evaluate(() => window.__uiTest.savedSettings);
  async function settled() {
    await page.waitForFunction(() => !document.querySelector('.settings-form-fields')?.disabled);
  }
  async function openSettings() {
    await page.getByRole('button', { name: words().settings, exact: true }).click();
    await page.getByRole('heading', { name: words().settings, exact: true }).waitFor();
    if (!await advanced.evaluate(element => element.open)) await advanced.locator('summary').click();
    await clientId.waitFor();
  }
  async function requestSave() {
    await saveButton().click();
    await dialog().waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1, 'OAuth confirmation is the sole active dialog.');
  }
  async function cancelConfirmation(escape = false) {
    if (escape) await page.keyboard.press('Escape');
    else await dialog().getByRole('button', { name: words().back, exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    await settled();
  }
  async function confirmSave(double = false) {
    const button = dialog().getByRole('button', { name: locale === 'en' ? /^Confirm change(?: and save|, save and leave)$/ : /^确认更改并保存(?:离开)?$/ });
    if (double) await button.evaluate(element => { element.click(); element.click(); });
    else await button.click();
    await dialog().waitFor({ state: 'hidden' });
  }
  async function ordinarySave() {
    const before = await calls();
    await saveButton().click();
    await page.waitForFunction(count => window.__oauthTest.calls.length === count + 1 && window.__oauthTest.calls.at(-1).completed, before);
    await settled();
    assert.equal(await dialog().count(), 0, 'An unchanged OAuth ID must not produce confirmation.');
  }
  async function blockedUnload() {
    const before = await page.evaluate(() => window.__uiTest.windowTransitions.length);
    assert(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))));
    await page.waitForFunction(count => window.__uiTest.windowTransitions.length === count + 1, before);
    assert.equal(await page.evaluate(() => window.__uiTest.windowTransitions.at(-1)), false);
  }
  async function assertLayout(context) {
    const overflow = await page.evaluate(() => [...document.querySelectorAll('html, .settings-main, .oauth-settings-warning, .oauth-change-values, .modal, .modal-body')].filter(element => element.getClientRects().length && element.scrollWidth > element.clientWidth + 1).map(element => ({ name: element.className || element.tagName, width: element.clientWidth, content: element.scrollWidth })));
    assert.deepEqual(overflow, [], `${context} has no horizontal overflow.`);
  }
  async function capture(name, target = page) {
    if (await page.locator('.toast button').count()) await page.locator('.toast button').click();
    if (target === advanced) {
      // Let the sticky save bar return below the last settings section.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    await assertLayout(name);
    const path = `test-results/oauth-settings-${name}-${version}-fixture.png`;
    await target.screenshot({ path, animations: 'disabled' });
    screenshots.push({ path, fixture: true });
  }
  async function assertValues(previous, next) {
    assert.deepEqual(await dialog().locator('.oauth-change-values dd').allTextContents(), [previous || words().empty, next || words().empty]);
  }

  await page.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await advanced.evaluate(element => element.open), false);
  assert(await advanced.locator('summary').getByText(words().caution, { exact: true }).isVisible());
  assert.equal(await clientId.isVisible(), false);
  await advanced.scrollIntoViewIfNeeded();
  await capture('zh-collapsed-desktop', advanced);
  await advanced.locator('summary').click();
  assert(await advanced.locator('.oauth-settings-warning').getByText(words().warning, { exact: true }).isVisible());
  assert.equal(await clientId.getAttribute('aria-describedby'), 'oauth-settings-warning');
  assert.match(await advanced.locator('.oauth-settings-warning').textContent(), /空的 Client ID.*浏览器授权登录不可用/);
  assert.match(await advanced.locator('.oauth-settings-warning').textContent(), /已有登录不会因此自动退出/);
  await advanced.scrollIntoViewIfNeeded();
  await capture('zh-warning-desktop', advanced);
  checks.push('The collapsed advanced setting warns to change with care; expanding it permanently explains incorrect/empty IDs, trusted app identity and the existing-session caveat, and the input references the warning accessibly.');

  await clientId.fill(previousId);
  await saveButton().evaluate(element => { element.click(); element.click(); });
  await dialog().waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1);
  assert.equal(await calls(), 0);
  await assertValues('', previousId);
  await capture('zh-confirm-desktop', dialog());
  await cancelConfirmation();
  assert.equal(await calls(), 0);
  assert.equal(await clientId.inputValue(), previousId);
  assert(await page.locator('.settings-save-bar').getByRole('button', { name: words().save, exact: true }).isEnabled());
  await requestSave();
  await cancelConfirmation(true);
  assert.equal(await calls(), 0);
  assert.equal(await clientId.inputValue(), previousId);
  checks.push('Both Cancel and Escape cancel without any settings API request, preserve the draft and dirty state, and repeated same-tick Save clicks open only one confirmation.');

  await requestSave();
  await blockedUnload();
  assert(await dialog().isVisible());
  assert.equal(await leaveDialog().count(), 0);
  await page.evaluate(() => { window.__oauthTest.hold = true; });
  await confirmSave(true);
  await page.waitForFunction(() => window.__oauthTest.calls.length === 1 && window.__oauthTest.calls[0].pending);
  assert(await saveButton().isDisabled());
  assert(await clientId.isDisabled());
  await blockedUnload();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await saveButton().evaluate(element => element.click());
  assert.equal(await calls(), 1);
  await page.evaluate(() => { window.__oauthTest.hold = false; window.__oauthTest.release(1); });
  await settled();
  assert.equal((await stored()).clientId, previousId);
  assert.equal(await calls(), 1);
  assert(await page.locator('.connected-account').getByText('@ui_tester', { exact: false }).isVisible());
  checks.push('Explicit confirmation sends one save despite duplicate confirmation; fields lock while the API is pending, beforeunload during confirmation or saving resolves false, and success neither leaves Settings nor signs out the current user.');

  await ordinarySave();
  await page.getByLabel('默认编程语言').selectOption('py');
  await ordinarySave();
  assert.equal((await stored()).language, 'py');
  await page.getByRole('group', { name: '外观主题', exact: true }).getByRole('button', { name: '深色', exact: true }).click();
  await ordinarySave();
  await page.setViewportSize({ width: 900, height: 650 });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await advanced.scrollIntoViewIfNeeded();
  await capture('zh-warning-dark-900', advanced);
  await clientId.fill('');
  await requestSave();
  await assertValues(previousId, '');
  assert(await dialog().getByText('保存空值后，本次运行将无法通过浏览器授权登录。', { exact: true }).isVisible());
  await capture('zh-clear-confirm-dark-900', dialog());
  await confirmSave();
  await settled();
  assert.equal((await stored()).clientId, '');
  checks.push('Unchanged IDs and unrelated language/theme saves have no extra confirmation; clearing an existing ID explicitly shows old/new values and warns that browser sign-in will be disabled before saving the empty string.');

  await clientId.fill(nextId);
  const leaveStart = await calls();
  await page.getByRole('button', { name: words().history, exact: true }).click();
  await leaveDialog().waitFor();
  await leaveDialog().getByRole('button', { name: words().saveLeave, exact: true }).click();
  await dialog().waitFor();
  assert.equal(await leaveDialog().count(), 0, 'The unsaved-settings dialog yields to OAuth confirmation.');
  await assertValues('', nextId);
  await cancelConfirmation();
  await leaveDialog().waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1);
  assert.equal(await calls(), leaveStart);
  assert.equal(await clientId.inputValue(), nextId);
  await capture('zh-save-leave-cancelled-dark-900', leaveDialog());
  await leaveDialog().getByRole('button', { name: words().keep, exact: true }).click();
  await page.getByRole('button', { name: words().history, exact: true }).click();
  await leaveDialog().getByRole('button', { name: words().saveLeave, exact: true }).click();
  await dialog().waitFor();
  await confirmSave();
  await page.getByRole('heading', { name: words().history, exact: true }).waitFor();
  assert.equal(await calls(), leaveStart + 1);
  assert.equal((await stored()).clientId, nextId);
  checks.push('Save and leave temporarily replaces the unsaved-settings dialog; cancelling restores that dialog and draft without saving, while confirming saves exactly once and reaches the originally requested page.');

  await openSettings();
  await clientId.fill(retryId);
  await page.evaluate(() => { window.__uiTest.saveSettingsFailure = true; });
  const failureStart = await calls();
  await page.getByRole('button', { name: words().history, exact: true }).click();
  await leaveDialog().getByRole('button', { name: words().saveLeave, exact: true }).click();
  await dialog().waitFor();
  await assertValues(nextId, retryId);
  await confirmSave(true);
  await page.getByRole('alert').filter({ hasText: 'Fixture settings save failure' }).waitFor();
  await leaveDialog().waitFor();
  await settled();
  assert.equal(await calls(), failureStart + 1);
  assert.equal((await stored()).clientId, nextId);
  assert.equal(await clientId.inputValue(), retryId);
  await page.evaluate(() => { window.__uiTest.saveSettingsFailure = false; });
  await leaveDialog().getByRole('button', { name: words().saveLeave, exact: true }).click();
  await dialog().waitFor();
  await assertValues(nextId, retryId);
  await confirmSave(true);
  await page.getByRole('heading', { name: words().history, exact: true }).waitFor();
  assert.equal(await calls(), failureStart + 2);
  assert.equal((await stored()).clientId, retryId);
  checks.push('A rejected save keeps the old saved ID, the edited draft and the pending destination; retry confirms the same old/new pair, invokes the API once per attempt and navigates only after success.');

  await openSettings();
  await clientId.fill(nativeId);
  const nativeStart = await calls();
  assert(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))));
  await leaveDialog().getByRole('button', { name: words().saveLeave, exact: true }).click();
  await dialog().waitFor();
  await blockedUnload();
  await confirmSave();
  await settled();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await calls(), nativeStart + 1);
  assert.equal((await stored()).clientId, nativeId);
  assert(await page.getByRole('heading', { name: words().settings, exact: true }).isVisible());
  assert((await page.evaluate(() => window.__uiTest.windowTransitions)).every(value => value === false), 'A second native close consumes the old intent instead of replaying resolve(true).');
  await clientId.fill('Iv1CancelledNativeDraft');
  assert(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))));
  await leaveDialog().getByRole('button', { name: words().saveLeave, exact: true }).click();
  await dialog().waitFor();
  await blockedUnload();
  await cancelConfirmation(true);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await calls(), nativeStart + 1);
  assert.equal(await clientId.inputValue(), 'Iv1CancelledNativeDraft');
  await clientId.fill(nativeId);
  checks.push('During native Save and leave, a repeated close/reload resolves false and consumes the previous window intent: confirming saves once but stays in Settings; cancelling also stays, preserves the draft and never replays resolve(true).');

  await page.getByLabel('界面语言').selectOption('en');
  await page.getByRole('group', { name: '外观主题', exact: true }).getByRole('button', { name: '浅色', exact: true }).click();
  await ordinarySave();
  locale = 'en';
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  for (const [width, height, theme] of [[1440, 1050, 'light'], [900, 650, 'dark']]) {
    await page.setViewportSize({ width, height });
    if (theme === 'dark') {
      await page.getByRole('group', { name: 'Appearance theme', exact: true }).getByRole('button', { name: 'Dark', exact: true }).click();
      await ordinarySave();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    }
    assert(await advanced.locator('summary').getByText(words().caution, { exact: true }).isVisible());
    assert(await advanced.locator('.oauth-settings-warning').getByText(words().warning, { exact: true }).isVisible());
    assert.match(await advanced.locator('.oauth-settings-warning').textContent(), /current session will remain signed in/);
    await advanced.scrollIntoViewIfNeeded();
    await capture(`en-warning-${theme}-${width}`, advanced);
    await clientId.fill('Ov23EnglishConfirmationDraft');
    const before = await calls();
    await requestSave();
    await assertValues(nativeId, 'Ov23EnglishConfirmationDraft');
    for (const name of [words().back, words().confirm]) {
      const button = dialog().getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1);
    }
    await capture(`en-confirm-${theme}-${width}`, dialog());
    await cancelConfirmation(theme === 'dark');
    assert.equal(await calls(), before);
    assert.equal(await clientId.inputValue(), 'Ov23EnglishConfirmationDraft');
    await clientId.fill(nativeId);
  }
  checks.push('Chinese and English warning/confirmation surfaces remain readable at 1440px light and 900px dark with no horizontal overflow; English old/new values are accurate, buttons stay reachable and both cancellation routes preserve the draft without saving.');
  assert.deepEqual(rendererErrors, []);
  assert((await page.evaluate(() => window.__uiTest.windowTransitions)).every(value => value === false));
  const result = { passed: true, fixture: true, version, completedAt: new Date().toISOString(), checks, rendererErrors, screenshots, saves: await page.evaluate(() => window.__oauthTest.calls), windowTransitions: await page.evaluate(() => window.__uiTest.windowTransitions) };
  writeFileSync(`test-results/oauth-settings-ui-${version}.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const failure = { passed: false, fixture: true, version, checks, error: String(error), rendererErrors, screenshots };
  if (page && !page.isClosed()) {
    await page.screenshot({ path: `test-results/oauth-settings-ui-failure-${version}-fixture.png`, animations: 'disabled' }).catch(() => {});
    Object.assign(failure, { dialogs: await page.getByRole('dialog').allTextContents(), saves: await page.evaluate(() => window.__oauthTest?.calls), windowTransitions: await page.evaluate(() => window.__uiTest?.windowTransitions) });
  }
  writeFileSync(`test-results/oauth-settings-ui-${version}-failure.json`, `${JSON.stringify(failure, null, 2)}\n`);
  console.error(JSON.stringify(failure));
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
