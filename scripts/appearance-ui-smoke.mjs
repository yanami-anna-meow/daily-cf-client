// Renderer fixture: real settingsInput validation, simulated sessionStorage persistence.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installClientFixture } from './ui-fixture.mjs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const checks = [], screenshots = [], paletteReadings = [], rendererErrors = [];
const custom = {
  light: { primary: '#80c9cf', accent: '#217078', background: '#f1fbfa', surface: '#ffffff', text: '#173e3f' },
  dark: { primary: '#f4d19a', accent: '#f0b960', background: '#181f24', surface: '#22313a', text: '#edf4f8' },
};
let server, browser, page, english = false;
try {
  mkdirSync('test-results', { recursive: true });
  server = await createServer({ server: { host: '127.0.0.1', port: Number(process.env.UI_TEST_PORT || 45173), strictPort: true }, logLevel: 'error' });
  await server.listen(); const address = server.httpServer.address(); assert(address && typeof address !== 'string');
  const channel = process.env.UI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  await installClientFixture(page);
  await page.addInitScript(() => { const f = window.__uiTest; f.contributionRows = []; f.contributionIncomplete = false; f.contributionFilesTruncated = false; f.latestDay.problems = f.latestDay.problems.slice(0, 3); });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`http://127.0.0.1:${address.port}/?localeFixture=1&uiLanguage=zh-CN&persistSettings=appearance&validateSettings=1`, { waitUntil: 'networkidle' });
  const label = (zh, en) => english ? en : zh;
  const group = () => page.getByRole('group', { name: label('配色方案', 'Color scheme'), exact: true });
  const card = id => group().locator(`button[data-palette-id="${id}"]`);
  const selected = () => group().locator('button[aria-pressed="true"]').getAttribute('data-palette-id');
  const editor = page.locator('.palette-editor');
  const nameInput = () => editor.getByRole('textbox', { name: label('方案名称', 'Scheme name'), exact: true });
  const saved = () => page.evaluate(async () => (await window.dailyCF.bootstrap()).settings);
  const saves = () => page.evaluate(() => window.__uiTest.saveSettingsRequests.length);
  const state = () => page.evaluate(() => ({ id: document.documentElement.dataset.paletteId, mode: document.documentElement.dataset.theme }));
  const theme = mode => page.getByRole('group', { name: label('外观主题', 'Appearance theme'), exact: true }).getByRole('button', { name: { light: label('浅色', 'Light'), dark: label('深色', 'Dark'), system: label('跟随系统', 'System') }[mode], exact: true });
  async function settings() { await page.getByRole('button', { name: label('设置', 'Settings'), exact: true }).click(); await group().waitFor(); }
  async function home() { await page.getByRole('navigation').getByRole('button', { name: label('最新题目', 'Latest problems'), exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.problem-card[data-contribution-state="none"]').length === 3); }
  async function save() {
    const count = await saves(); await page.locator('.page-heading').getByRole('button', { name: label('保存设置', 'Save settings'), exact: true }).click();
    await page.waitForFunction(before => window.__uiTest.saveSettingsRequests.length === before + 1 && !document.querySelector('.settings-form-fields')?.disabled, count);
  }
  async function waitAppearance(id, mode) { await page.waitForFunction(({ id, mode }) => document.documentElement.dataset.paletteId === id && document.documentElement.dataset.theme === mode, { id, mode }); }
  async function verifyColors(id, mode, bases) {
    await waitAppearance(id, mode);
    const variables = await page.evaluate(() => Object.fromEntries([...document.documentElement.style].filter(key => key.startsWith('--')).map(key => [key, getComputedStyle(document.documentElement).getPropertyValue(key).trim()])));
    for (const [key, css] of Object.entries({ primary: '--primary-bg', background: '--bg', surface: '--panel', text: '--text' })) assert.equal(variables[css], bases[key]);
    const expected = await page.evaluate(async ({ colors, mode }) => (await import('/shared/appearance.ts')).themeVariables(colors, mode), { colors: bases, mode });
    for (const [key, value] of Object.entries(expected)) assert.equal(variables[key], value, `Unified derivation of ${key}`);
    return variables;
  }
  async function verifyHomeAccents() {
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => {
      const root = getComputedStyle(document.documentElement), normalized = value => { const style = document.createElement('span').style; style.color = value; return style.color; };
      const actions = [...document.querySelectorAll('.problem-card-footer .text-button')], nav = document.querySelector('nav .nav-item.active'), primary = document.querySelector('.topbar-actions .button-primary');
      return actions.length > 0 && actions.every(el => getComputedStyle(el).color === normalized(root.getPropertyValue('--accent').trim())) && nav && getComputedStyle(nav).backgroundColor === normalized(root.getPropertyValue('--accent-soft').trim()) && getComputedStyle(nav).color === normalized(root.getPropertyValue('--accent').trim()) && primary && getComputedStyle(primary).backgroundColor === normalized(root.getPropertyValue('--primary-bg').trim());
    });
  }
  async function capture(name, target = page) {
    if (await page.locator('.toast button').count()) await page.locator('.toast button').click();
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => { const b = document.querySelector('.topbar-actions .button-primary'); const style = document.createElement('span').style; style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--primary-bg').trim(); return !b || getComputedStyle(b).backgroundColor === style.backgroundColor; });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('html, .settings-main, .settings-section, .appearance-schemes, .palette-editor, .modal')].filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map(el => el.className || el.tagName));
    assert.deepEqual(overflow, [], `${name} must not overflow horizontally.`);
    const path = `test-results/appearance-${name}-${version}-fixture.png`; await target.screenshot({ path, animations: 'disabled' }); screenshots.push({ path, fixture: true, viewport: page.viewportSize() });
  }
  async function editMode(mode) { await editor.getByRole('group', { name: label('编辑明暗配色', 'Edit light and dark colors'), exact: true }).getByRole('button', { name: mode === 'light' ? label('浅色配色', 'Light colors') : label('深色配色', 'Dark colors'), exact: true }).click(); }
  async function verifyThumbnails(mode) {
    const palettes = (await saved()).palettes;
    await page.waitForFunction(({ mode, palettes }) => palettes.every(palette => {
      const card = document.querySelector(`.appearance-schemes button[data-palette-id="${palette.id}"]`);
      return card?.style.getPropertyValue('--preview-bg') === palette[mode].background && card?.style.getPropertyValue('--preview-panel') === palette[mode].surface;
    }), { mode, palettes });
  }
  async function fillColors(mode, colors) { await editMode(mode); const names = { primary: '按钮底色', accent: '强调色', background: '页面背景', surface: '卡片背景', text: '正文文字' }; for (const [key, value] of Object.entries(colors)) await editor.getByRole('textbox', { name: names[key], exact: true }).fill(value); }
  async function addNamed(name) { await page.getByRole('button', { name: '添加方案', exact: true }).click(); await nameInput().fill(name); const id = await selected(); assert(id); return id; }

  for (const id of ['pink', 'green', 'blue', 'mono']) for (const mode of ['light', 'dark']) {
    await settings(); const before = await state(); await card(id).click(); await theme(mode).click();
    assert.equal(await card(id).getAttribute('aria-pressed'), 'true'); assert.deepEqual(await state(), before, 'Draft choices do not apply before saving.');
    await save(); const model = await saved(); assert.equal(model.paletteId, id); assert.equal(model.theme, mode);
    const variables = await verifyColors(id, mode, model.palettes.find(p => p.id === id)[mode]); paletteReadings.push({ id, mode, variables });
    await home(); await verifyHomeAccents();
    if (id === 'pink') {
      assert.equal(variables['--accent'], mode === 'light' ? '#fb7299' : '#ffa8c0', 'Pink emphasis retains the selected color independently from its pale button background.');
      await capture(`home-pink-${mode}-1440`); await capture(`card-actions-pink-${mode}`, page.locator('.problem-card').first());
    }
  }
  for (const mode of ['light', 'dark']) assert.equal(new Set(paletteReadings.filter(r => r.mode === mode).map(r => r.variables['--primary-bg'])).size, 4);
  checks.push('The four initial entries save and render in both modes; pink emphasis is vivid while primary buttons remain pale, and actual card actions/navigation use the independent accent variables.');

  await settings(); const baseline = await saved(); const draftCalls = await saves();
  await card('pink').click(); await theme('light').click(); await nameInput().fill('Unsaved name');
  const leave = page.getByRole('dialog', { name: '设置尚未保存', exact: true });
  await page.getByRole('navigation').getByRole('button', { name: '最新题目', exact: true }).click(); await leave.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await nameInput().inputValue(), 'Unsaved name'); assert.equal(await selected(), 'pink'); assert.deepEqual(await saved(), baseline); assert.equal(await saves(), draftCalls);
  await page.getByRole('navigation').getByRole('button', { name: '最新题目', exact: true }).click(); await leave.getByRole('button', { name: '放弃修改', exact: true }).click();
  await home(); await settings(); assert.equal(await selected(), 'mono'); assert.equal(await card('pink').innerText(), '粉色'); assert.equal(await theme('dark').getAttribute('aria-pressed'), 'true');
  checks.push('Continue editing preserves an unsaved name, selection and display mode without writing; Discard restores the saved names, list and appearance.');

  await card('pink').click(); await nameInput().fill('Edited pink'); await fillColors('light', custom.light); await fillColors('dark', custom.dark);
  assert.equal(await editor.locator('.palette-preview').evaluate(el => el.style.getPropertyValue('--primary-bg')), custom.dark.primary);
  assert.deepEqual(await state(), { id: 'mono', mode: 'dark' }); await theme('system').click(); await save();
  const editedSeed = await verifyColors('pink', 'light', custom.light);
  await editMode('light'); await editor.getByRole('textbox', { name: '按钮底色', exact: true }).fill('#efd5ac'); await save();
  const buttonChanged = await verifyColors('pink', 'light', { ...custom.light, primary: '#efd5ac' });
  for (const key of ['--accent', '--accent-hover', '--accent-soft', '--accent-border', '--focus-ring', '--focus-shadow']) assert.equal(buttonChanged[key], editedSeed[key], `${key} must not depend on the button background.`);
  assert.notEqual(buttonChanged['--primary-bg'], editedSeed['--primary-bg']); await home(); await verifyHomeAccents(); await settings(); await editMode('light');
  await editor.getByRole('textbox', { name: '强调色', exact: true }).fill('#a32a59'); await save();
  const accentChanged = await verifyColors('pink', 'light', { ...custom.light, primary: '#efd5ac', accent: '#a32a59' });
  for (const key of ['--primary-bg', '--primary-hover', '--primary-border', '--on-primary']) assert.equal(accentChanged[key], buttonChanged[key], `${key} must not depend on the accent.`);
  assert.notEqual(accentChanged['--accent'], buttonChanged['--accent']); await home(); await verifyHomeAccents(); await settings(); await fillColors('light', custom.light); await save();
  checks.push('Changing only button background preserves emphasis text, navigation fill and focus colors; changing only accent preserves primary-button background, hover, border and text. Actual card actions stay synchronized after both saves.');
  const firstId = await addNamed('Sea glass'); await save(); assert.deepEqual(await verifyColors(firstId, 'light', custom.light), editedSeed, 'Same colors in an initial entry and its clone must produce identical CSS variables.');
  const secondId = await addNamed('Warm sand'); await editMode('light'); await editor.getByRole('textbox', { name: '按钮底色', exact: true }).fill('#efd5ac'); await save(); assert.notEqual(firstId, secondId);
  await card(firstId).click(); await save(); await page.reload({ waitUntil: 'networkidle' }); await waitAppearance(firstId, 'light');
  const reloaded = await saved(); assert.equal(reloaded.palettes.length, 6); assert.equal(reloaded.palettes.find(p => p.id === firstId).name, 'Sea glass'); assert.equal(reloaded.palettes.find(p => p.id === secondId).name, 'Warm sand');
  assert.deepEqual(reloaded.palettes.find(p => p.id === firstId).light, custom.light); assert.deepEqual(reloaded.palettes.find(p => p.id === firstId).dark, custom.dark); assert.equal(reloaded.palettes.find(p => p.id === secondId).light.primary, '#efd5ac'); await verifyColors(firstId, 'light', custom.light);
  checks.push('All ten light/dark color values save and survive a real reload; two named copies retain independent colors, identical copies render like their editable source, and the selected ID is restored.');

  await settings(); await editMode('light'); await verifyThumbnails('light'); await page.setViewportSize({ width: 1440, height: 1550 }); await page.locator('.appearance-settings').scrollIntoViewIfNeeded(); await capture('settings-chinese-light-1440', page.locator('.appearance-settings'));
  await page.emulateMedia({ colorScheme: 'dark' }); await verifyColors(firstId, 'dark', custom.dark); await verifyThumbnails('dark');
  assert.equal(await editor.getByRole('button', { name: '浅色配色', exact: true }).getAttribute('aria-pressed'), 'true', 'OS mode updates the thumbnails without changing the active editor tab.');
  await editMode('dark');
  assert.equal((await saved()).theme, 'system'); assert.equal((await saved()).paletteId, firstId); await page.emulateMedia({ colorScheme: 'light' }); await verifyColors(firstId, 'light', custom.light);
  await verifyThumbnails('light'); assert.equal(await editor.getByRole('button', { name: '深色配色', exact: true }).getAttribute('aria-pressed'), 'true');
  checks.push('System mode retains the selected named entry and active editor tab while switching page colors and all scheme thumbnails to the correct independent light/dark colors.');

  await editMode('light');
  for (const [name, value] of [['按钮底色', custom.light.primary], ['强调色', custom.light.accent]]) {
    const field = editor.getByRole('textbox', { name, exact: true }); await field.fill('#oops'); assert.equal(await field.getAttribute('aria-invalid'), 'true');
    const beforeInvalid = await saved(); const invalidCalls = await saves(); await save(); await page.getByRole('alert').filter({ hasText: '配色方案颜色设置不正确' }).waitFor();
    assert.equal(await saves(), invalidCalls + 1); assert.equal(await field.inputValue(), '#oops'); assert.deepEqual(await saved(), beforeInvalid); await verifyColors(firstId, 'light', custom.light);
    await field.fill(value); await save();
  }
  await page.getByLabel('界面语言').selectOption('en'); await save(); english = true; await page.waitForFunction(() => document.documentElement.lang === 'en'); await page.setViewportSize({ width: 900, height: 1400 });
  const names = (await saved()).palettes.map(p => p.name);
  for (const mode of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: mode }); await verifyColors(firstId, mode, custom[mode]); await editMode(mode); assert.deepEqual(await group().locator('.appearance-scheme-label > span').allTextContents(), names);
    for (const [field, name] of Object.entries({ primary: 'Button background', accent: 'Accent color', background: 'Page background', surface: 'Card background', text: 'Body text' })) {
      assert.equal(await editor.getByRole('textbox', { name, exact: true }).inputValue(), custom[mode][field]); assert.equal(await editor.getByLabel(`Color picker: ${name}`, { exact: true }).inputValue(), custom[mode][field]);
    }
    await page.locator('.appearance-settings').scrollIntoViewIfNeeded(); await capture(`settings-english-${mode}-900`, page.locator('.appearance-settings'));
  }
  checks.push('English controls remain readable without horizontal overflow at 900px in both modes, while saved palette names remain unchanged user data.');

  const remove = () => page.locator('.palette-actions').getByRole('button', { name: 'Delete scheme', exact: true });
  const deletion = page.getByRole('group', { name: 'Delete color scheme?', exact: true });
  await remove().click(); await deletion.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await selected(), firstId); assert.equal(await group().getByRole('button').count(), 6);
  while (await group().getByRole('button').count() > 1) {
    const deleting = await selected(); const count = await group().getByRole('button').count(); await remove().click(); await deletion.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
    const fallback = await selected(); assert(fallback && fallback !== deleting); assert.equal(await group().getByRole('button').count(), count - 1); await save(); assert.equal((await saved()).paletteId, fallback); assert.equal((await saved()).palettes.length, count - 1);
  }
  assert(await remove().isDisabled()); const last = await saved(); const lastCalls = await saves(); await remove().evaluate(el => el.click()); assert.equal(await deletion.count(), 0); assert.deepEqual(await saved(), last); assert.equal(await saves(), lastCalls);
  checks.push('Actual settingsInput rejects invalid hex without losing the draft or saved colors; retry succeeds, deletion can be cancelled, selected deletion saves a valid fallback, and the last palette cannot be deleted.');

  assert.deepEqual(rendererErrors, []);
  const result = { passed: true, fixture: true, version, completedAt: new Date().toISOString(), persistenceBoundary: 'Successful writes pass actual settingsInput and persist only in fixture sessionStorage. Reload checks renderer behavior, not native filesystem persistence.', checks, paletteReadings, screenshots, rendererErrors };
  writeFileSync(`test-results/appearance-ui-${version}.json`, `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const failure = { passed: false, fixture: true, version, completedChecks: checks.length, checks, screenshots, rendererErrors, error: String(error) };
  if (page && !page.isClosed()) { await page.screenshot({ path: `test-results/appearance-ui-failure-${version}-fixture.png`, animations: 'disabled' }).catch(() => {}); failure.dialogs = await page.getByRole('dialog').allTextContents(); }
  writeFileSync(`test-results/appearance-ui-${version}-failure.json`, `${JSON.stringify(failure, null, 2)}\n`); console.error(JSON.stringify(failure)); throw error;
} finally { await browser?.close(); await server?.close(); }
