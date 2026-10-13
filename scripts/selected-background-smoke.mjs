// One-page renderer check for selected surfaces; --preview only injects candidate CSS.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installClientFixture } from './ui-fixture.mjs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const preview = process.argv.includes('--preview'), readings = [], screenshots = [], rendererErrors = [];
const selectedFills = { green: { light: '#ddf8ea', dark: '#314838' }, pink: { light: '#ffe6ed', dark: '#493037' }, blue: { light: '#e6f1ff', dark: '#2d3c50' }, mono: { light: '#f2f2f2', dark: '#383838' } };
let server, browser, page;
try {
  mkdirSync('test-results', { recursive: true });
  server = await createServer({ server: { host: '127.0.0.1', port: 45173, strictPort: true }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  await installClientFixture(page);
  await page.addInitScript(() => { const f = window.__uiTest; f.contributionRows = []; f.contributionIncomplete = false; f.contributionFilesTruncated = false; f.latestDay.problems = f.latestDay.problems.slice(0, 3); });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('http://127.0.0.1:45173/?localeFixture=1&uiLanguage=zh-CN&validateSettings=1', { waitUntil: 'networkidle' });
  const nav = page.getByRole('navigation', { name: '主导航', exact: true });
  async function archive() {
    await nav.getByRole('button', { name: '历史题库', exact: true }).click(); await nav.locator('.nav-item.active').filter({ hasText: '历史题库' }).waitFor(); await page.mouse.move(1400, 1000);
    await page.waitForFunction(() => { const css = getComputedStyle(document.documentElement), active = document.querySelector('nav[aria-label="主导航"] .nav-item.active'), rgb = value => { const style = document.createElement('span').style; style.color = value; return style.color; }; return active && getComputedStyle(active).color === rgb(css.getPropertyValue('--accent').trim()) && getComputedStyle(active).backgroundColor === rgb(css.getPropertyValue('--accent-soft').trim()); });
  }
  async function capture(name) {
    const path = `test-results/appearance-nav-${name}-${version}-fixture.png`;
    await nav.screenshot({ path, animations: 'disabled' }); screenshots.push(path);
  }
  await archive();
  if (preview) {
    // The old value is pinned only for comparison; no application settings change.
    await page.evaluate(() => document.documentElement.style.setProperty('--accent-soft', '#e6fff2'));
    await capture('green-light-before');
    await page.evaluate(() => document.documentElement.style.setProperty('--accent-soft', '#d5f0e3'));
    await capture('green-light-candidate');
    await page.evaluate(() => document.documentElement.style.setProperty('--accent-soft', '#ddf8ea'));
    await capture('green-light-candidate-soft');
  } else {
    const initialPalettes = await page.evaluate(async () => (await import('/shared/appearance.ts')).createDefaultPalettes('zh-CN'));
    for (const palette of initialPalettes) for (const mode of ['light', 'dark']) {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('group', { name: '配色方案', exact: true }).locator(`button[data-palette-id="${palette.id}"]`).click();
      await page.getByRole('group', { name: '外观主题', exact: true }).getByRole('button', { name: mode === 'light' ? '浅色' : '深色', exact: true }).click();
      const save = page.locator('.page-heading').getByRole('button', { name: '保存设置', exact: true });
      if (await save.isEnabled()) { const before = await page.evaluate(() => window.__uiTest.saveSettingsRequests.length); await save.click(); await page.waitForFunction(before => window.__uiTest.saveSettingsRequests.length > before && !document.querySelector('.settings-form-fields')?.disabled, before); }
      await archive();
      const reading = await page.evaluate(async ({ palette, mode }) => {
        const css = getComputedStyle(document.documentElement), rgb = value => { const style = document.createElement('span').style; style.color = value; return style.color; };
        const actual = Object.fromEntries(['--accent', '--accent-soft', '--primary-bg', '--sidebar', '--panel', '--bg', '--text'].map(key => [key, css.getPropertyValue(key).trim()]));
        const active = document.querySelector('nav[aria-label="主导航"] .nav-item.active');
        const module = await import('/shared/appearance.ts');
        return { palette: palette.id, mode, actual, expected: module.themeVariables(palette[mode], mode), selectedContrast: module.contrastRatio(actual['--accent-soft'], actual['--sidebar']), navColor: getComputedStyle(active).color, navBackground: getComputedStyle(active).backgroundColor, expectedNavColor: rgb(palette[mode].accent), expectedNavBackground: rgb(actual['--accent-soft']), overflow: [...document.querySelectorAll('html, .sidebar, nav[aria-label="主导航"], .nav-item')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className || el.tagName) };
      }, { palette, mode });
      for (const [field, property] of Object.entries({ accent: '--accent', primary: '--primary-bg', background: '--bg', surface: '--panel', text: '--text' })) assert.equal(reading.actual[property], palette[mode][field]);
      assert.equal(reading.actual['--accent-soft'], reading.expected['--accent-soft']);
      assert.equal(reading.actual['--accent-soft'], selectedFills[palette.id][mode], 'Seven existing selected fills remain exact; only light green changes.');
      assert.equal(reading.navColor, reading.expectedNavColor); assert.equal(reading.navBackground, reading.expectedNavBackground); assert.deepEqual(reading.overflow, []);
      if (palette.id === 'green' && mode === 'light') assert(reading.selectedContrast >= 1.10, 'Green selected background must be visibly separated from the sidebar.');
      delete reading.expected; readings.push(reading); await capture(`${palette.id}-${mode}-final`);
      if (palette.id === 'green' && mode === 'light') {
        await page.evaluate(() => document.documentElement.style.setProperty('--accent-soft', '#e6fff2'));
        await capture('green-light-before');
        await page.evaluate(value => document.documentElement.style.setProperty('--accent-soft', value), reading.actual['--accent-soft']);
      }
    }
  }
  assert.deepEqual(rendererErrors, []);
  const result = { passed: true, fixture: true, preview, version, readings, screenshots, rendererErrors };
  writeFileSync(`test-results/selected-background-${version}${preview ? '-preview' : ''}.json`, `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); await server?.close(); }
