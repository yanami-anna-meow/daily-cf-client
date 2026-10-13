// One Edge page, deterministic pending reads; no account or network access.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installClientFixture } from './ui-fixture.mjs';

const report = { version: '0.3.8', fixture: true, passed: false, checks: [], rendererErrors: [] };
let server, browser, page;
mkdirSync('test-results', { recursive: true });
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 45173, strictPort: true }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.UI_BROWSER_CHANNEL || 'msedge' });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => report.rendererErrors.push(error.message));
  await installClientFixture(page);
  const nav = page.getByRole('navigation', { name: '主导航', exact: true });
  const date = page.getByLabel('选择题目日期', { exact: true });
  const search = page.getByLabel('搜索全库题目', { exact: true });
  const note = page.locator('.archive-navigation-note');
  const jump = month => page.locator(`button[data-month-jump="${month}"]`);
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const counts = () => page.evaluate(() => ({ snapshot: window.__uiTest.archiveSnapshotRequests.length, months: window.__uiTest.snapshotMonthRequests.length }));
  async function setup(hold = true) {
    await page.goto('http://127.0.0.1:45173/?localeFixture=1', { waitUntil: 'networkidle' });
    await page.locator('.library-sync-notice[data-sync-phase="ready"]').waitFor();
    await page.evaluate(hold => {
      const fixture = window.__uiTest;
      const months = ['2040-03', '2040-02', '2040-01'];
      fixture.archiveMonths = months.map(month => ({ month, days: 10 }));
      fixture.monthOverrides = {};
      for (const [monthIndex, month] of months.entries()) {
        fixture.monthOverrides[month] = Array.from({ length: 10 }, (_, dayIndex) => {
          const date = `${month}-${String(dayIndex + 1).padStart(2, '0')}`;
          const day = fixture.makeLibraryDay(date, `Kept problem ${date}`, `cf${8700 + monthIndex * 10 + dayIndex}a`);
          fixture.dayOverrides[date] = structuredClone(day); return day;
        });
      }
      if (hold) fixture.libraryRules.push({ method: 'month', key: '2040-01', defer: true, tag: 'last-month' });
    }, hold);
    await nav.getByRole('button', { name: '历史题库', exact: true }).click();
    if (hold) {
      await page.waitForFunction(() => window.__uiTest.libraryRequests.some(request => request.tag === 'last-month' && request.pending));
      await page.waitForFunction(() => document.querySelectorAll('.archive-days .problem-card').length === 20);
    } else await ready();
    await frames();
  }
  async function ready() {
    await page.waitForFunction(() => document.querySelectorAll('.archive-days .problem-card').length === 30 && !document.querySelector('.index-panel'));
    await frames();
  }
  async function release() {
    await page.evaluate(() => window.__uiTest.releaseLibrary('last-month'));
    await ready();
  }
  async function expectWaiting() {
    await note.filter({ hasText: '正在等待 2040-01 的题目加载' }).waitFor();
  }
  async function expectJanuaryOutOfView() {
    assert((await page.locator('.archive-day[data-problem-date="2040-01-10"]').boundingBox()).y > 1000,
      'The late January result must not pull the reader away from the loaded months.');
    assert.notEqual(await jump('2040-01').getAttribute('aria-current'), 'location');
    assert.equal(await note.count(), 0);
  }

  await setup();
  const firstCounts = await counts();
  await jump('2040-01').click(); await expectWaiting();
  assert.deepEqual(await counts(), firstCounts, 'Waiting navigation does not issue another read.');
  await release();
  await page.waitForFunction(() => {
    const section = document.querySelector('.archive-day[data-problem-date="2040-01-10"]');
    return section && Math.abs(section.getBoundingClientRect().top - 24) < 5;
  });
  assert.equal(await jump('2040-01').getAttribute('aria-current'), 'location');
  assert.equal(await page.locator('.archive-days .problem-card').count(), 30);
  assert.deepEqual(await counts(), firstCounts);
  report.checks.push('A not-yet-loaded month shows a waiting message, then aligns its first matching day after release without an extra request or hiding other months.');

  await setup();
  await jump('2040-01').click(); await expectWaiting();
  await page.mouse.move(1150, 600); await page.mouse.wheel(0, 500);
  await page.waitForFunction(() => !document.querySelector('.archive-navigation-note'));
  await release(); await expectJanuaryOutOfView();
  report.checks.push('A real wheel scroll cancels a waiting month jump; releasing the pending read does not move the reader to the old target.');

  await setup();
  await jump('2040-01').click(); await expectWaiting();
  await search.fill('Kept'); // The eventual target still matches this filter.
  await page.waitForFunction(() => !document.querySelector('.archive-navigation-note'));
  await release(); await expectJanuaryOutOfView();
  assert.equal(await search.inputValue(), 'Kept');
  report.checks.push('Changing filters cancels pending navigation even when the delayed target still matches; all matching months stay in the list.');

  await setup(false);
  const beforeDate = await counts();
  await date.fill('2040-01-05');
  // Dispatch the actual wheel intent before the 350ms input debounce expires.
  await page.mouse.move(1150, 600); await page.mouse.wheel(0, 450);
  await page.waitForTimeout(450);
  await date.evaluate(element => element.blur());
  await frames();
  await expectJanuaryOutOfView();
  assert.deepEqual(await counts(), beforeDate);
  assert.equal(await date.inputValue(), '2040-01-05', 'Cancelling a jump does not silently rewrite the entered date.');
  report.checks.push('Scrolling during the date-input debounce cancels the delayed jump; a later blur does not resurrect it and the input remains intact.');

  await setup();
  await jump('2040-01').click(); await expectWaiting();
  await jump('2040-02').click();
  await page.waitForFunction(() => document.querySelector('button[data-month-jump="2040-02"]')?.getAttribute('aria-current') === 'location');
  await release();
  await expectJanuaryOutOfView();
  assert.equal(await jump('2040-02').getAttribute('aria-current'), 'location');
  report.checks.push('Selecting a second, already-loaded month replaces the waiting target; the late first target cannot undo the newer navigation.');

  await setup();
  await jump('2040-01').click(); await expectWaiting();
  await page.getByRole('button', { name: '停止加载', exact: true }).click();
  await note.filter({ hasText: '2040-01 尚未加载，请完成题库加载后重试。' }).waitFor();
  assert.equal(await note.locator('.spin').count(), 0);
  await page.evaluate(() => window.__uiTest.releaseLibrary('last-month'));
  await frames();
  assert.equal(await page.locator('.archive-days .problem-card').count(), 20);
  assert.equal(await page.locator('.archive-day[data-problem-date="2040-01-10"]').count(), 0);
  report.checks.push('Stopping a load turns a pending jump into a clear non-loading message; a late cancelled response neither appends content nor triggers a jump.');

  assert.deepEqual(report.rendererErrors, []);
  report.passed = true;
} catch (error) {
  report.error = String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/archive-navigation-race-ui-failure-0.3.8.png', animations: 'disabled' }).catch(() => {});
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync('test-results/archive-navigation-race-ui-0.3.8.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, error: report.error }));
  await browser?.close(); await server?.close();
}
