// Continuous-archive navigation and real browser geometry with a large fixture.
// One Edge page, no account credentials, GitHub writes or live repository reads.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installClientFixture } from './ui-fixture.mjs';

const report = { version: '0.3.8', fixture: true, passed: false, checks: [], screenshots: [], rendererErrors: [], measurements: {} };
let server, browser, page;
mkdirSync('test-results', { recursive: true });
mkdirSync('docs/screenshots', { recursive: true });
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 45173, strictPort: true }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.UI_BROWSER_CHANNEL || 'msedge' });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => report.rendererErrors.push(error.message));
  await installClientFixture(page);
  await page.goto('http://127.0.0.1:45173/?localeFixture=1', { waitUntil: 'networkidle' });
  await page.locator('.problem-card').first().waitFor();
  await page.locator('.library-sync-notice[data-sync-phase="ready"]').waitFor();
  await page.evaluate(() => {
    const fixture = window.__uiTest;
    const months = [...Array.from({ length: 24 }, (_, index) => new Date(Date.UTC(2050, 11 - index, 1)).toISOString().slice(0, 7)), '2024-02'];
    fixture.archiveMonths = [{ month: '2051-01', days: 0 }, ...months.map(month => ({ month, days: 24 }))];
    fixture.monthOverrides = { '2051-01': [] };
    let number = 0;
    for (const month of months) {
      fixture.monthOverrides[month] = Array.from({ length: 24 }, (_, index) => {
        const date = `${month}-${String(index + 1).padStart(2, '0')}`;
        const count = [1, 3, 4][index % 3];
        const day = { date, sourceUrl: 'https://github.com/Yawn-Sean/Daily_CF_Problems', fetchedAt: '2026-10-10T00:00:00Z',
          problems: Array.from({ length: count }, (_, problemIndex) => {
            const id = 30000 + number++;
            return { id: `cf${id}a`, label: `${index === 0 && ['2050-12', '2024-02'].includes(month) ? 'Shared marker' : 'Archive problem'} ${id}`,
              url: `https://codeforces.com/contest/${id}/problem/A`, rating: 1000 + (problemIndex % 3) * 500,
              ratingSource: 'official', kind: 'round', hint: 'Fixture hint' };
          }) };
        fixture.dayOverrides[date] = structuredClone(day);
        return day;
      });
    }
    fixture.navigationFixtureCount = number;
  });
  const requestCounts = () => page.evaluate(() => ({ snapshots: window.__uiTest.archiveSnapshotRequests.length,
    months: window.__uiTest.snapshotMonthRequests.length, days: window.__uiTest.dayRequests.length }));
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const cards = page.locator('.archive-days .problem-card');
  const search = page.getByRole('textbox', { name: '搜索全库题目', exact: true });
  const jump = month => page.locator(`button[data-month-jump="${month}"]`);
  const daySection = date => page.locator(`.archive-day[data-problem-date="${date}"]`);
  const snapshot = async name => {
    const file = `docs/screenshots/${name}-0.3.8-fixture.png`;
    await page.screenshot({ path: file, animations: 'disabled' }); report.screenshots.push(file);
  };
  const aligned = async date => {
    await page.waitForFunction(date => {
      const element = document.querySelector(`.archive-day[data-problem-date="${date}"]`);
      if (!element) return false;
      const top = element.getBoundingClientRect().top;
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      return top >= 0 && (top < 120 || (atBottom && top < window.innerHeight - 60));
    }, date);
    await frame();
    return daySection(date).evaluate(element => element.getBoundingClientRect().top);
  };
  const started = performance.now();
  await page.getByRole('navigation').getByRole('button', { name: '历史题库', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.archive-days .problem-card').length === window.__uiTest.navigationFixtureCount
    && !document.querySelector('.index-panel') && document.querySelector('.library-sync-notice')?.getAttribute('data-sync-phase') === 'ready');
  report.measurements.initialFixtureLoadMs = Math.round(performance.now() - started);
  const total = await cards.count();
  assert.equal(total, 1600);
  assert.equal(await page.locator('.archive-mode-switch').count(), 0);
  assert.equal(await page.locator('button[data-month-jump]').count(), 26);
  assert.equal(await daySection('2050-12-01').locator('.problem-card').count(), 1);
  assert.equal(await daySection('2050-12-02').locator('.problem-card').count(), 3);
  assert.equal(await daySection('2050-12-03').locator('.problem-card').count(), 4);
  const initialRequests = await requestCounts();
  assert.equal(initialRequests.snapshots, 1);
  assert.equal(initialRequests.months, 26);
  await snapshot('archive-continuous-full');
  report.checks.push('Entry loads one full snapshot: 26 real fixture month entries, 1,600 problems across 600 days, future dates, an empty month, and daily counts of 1, 3 and 4.');

  const jumpStart = performance.now();
  await jump('2024-02').click();
  report.measurements.earlyMonthTop = await aligned('2024-02-24');
  report.measurements.farMonthJumpMs = Math.round(performance.now() - jumpStart);
  assert.equal(await cards.count(), total);
  assert.equal(await jump('2024-02').getAttribute('aria-current'), 'location');
  assert.deepEqual(await requestCounts(), initialRequests);
  await snapshot('archive-month-jump');
  await jump('2050-12').click();
  await aligned('2050-12-24');
  assert.equal(await jump('2050-12').getAttribute('aria-current'), 'location');
  assert.deepEqual(await requestCounts(), initialRequests);
  report.checks.push('Jumping across 26 years keeps every problem mounted, aligns the target day, highlights the reading month and issues no snapshot, month or day requests.');

  // Change the reading position independently of the month buttons.
  await daySection('2049-07-24').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.waitForFunction(() => document.querySelector('button[data-month-jump="2049-07"]')?.getAttribute('aria-current') === 'location');
  assert.deepEqual(await requestCounts(), initialRequests);
  report.checks.push('The month highlight follows scrolling even when no month button is clicked.');

  await page.getByLabel('选择题目日期', { exact: true }).fill('2024-02-02');
  await page.getByLabel('选择题目日期', { exact: true }).press('Enter');
  await aligned('2024-02-02');
  assert.equal(await cards.count(), total);
  assert.deepEqual(await requestCounts(), initialRequests);
  const selectedCard = daySection('2024-02-02').locator('.problem-card').first();
  const cardTop = await selectedCard.evaluate(element => element.getBoundingClientRect().top);
  await selectedCard.getByRole('button', { name: '查看题目', exact: true }).click();
  await page.locator('.detail-heading').waitFor();
  await page.getByRole('button', { name: '返回历史题库', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.archive-days .problem-card').length === 1600 && !document.querySelector('.index-panel'));
  await page.waitForFunction(({ top }) => {
    const card = document.querySelector('.archive-day[data-problem-date="2024-02-02"] .problem-card');
    return card && Math.abs(card.getBoundingClientRect().top - top) < 5;
  }, { top: cardTop });
  report.checks.push('Date navigation keeps the entire archive, and returning from a far-away problem detail restores the same card position.');

  const beforeFiltering = await requestCounts();
  await search.fill('Shared marker');
  await page.waitForFunction(() => document.querySelectorAll('.archive-days .problem-card').length === 2);
  assert.equal(await page.locator('.archive-month').count(), 2);
  await jump('2024-02').click();
  await aligned('2024-02-01');
  assert.equal(await search.inputValue(), 'Shared marker');
  assert.equal(await cards.count(), 2);
  await jump('2050-11').click();
  assert.equal(await cards.count(), 2);
  assert.equal(await search.inputValue(), 'Shared marker');
  assert.deepEqual(await requestCounts(), beforeFiltering);
  await snapshot('archive-filtered-month-jump');
  report.checks.push('Search applies to the whole archive; month jumps preserve the search, retain matches in other months, and never load or substitute a selected-month view.');

  await page.getByRole('button', { name: '清空搜索', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.archive-days .problem-card').length === 1600);
  await page.setViewportSize({ width: 900, height: 650 });
  await jump('2049-01').click();
  await aligned('2049-01-24');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('html, main, .archive-layout, .months-panel, .archive-main')]
    .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className || element.tagName)), []);
  assert.deepEqual(await page.locator('[data-month-jump]').evaluateAll(buttons => buttons.filter(button => {
    const label = button.querySelector('span').getBoundingClientRect();
    const count = button.querySelector('small').getBoundingClientRect();
    return count.left < label.right + 2 || button.scrollWidth > button.clientWidth + 1;
  }).map(button => button.dataset.monthJump)), [], 'Month labels and counts must fit with separation in a narrow window.');
  await snapshot('archive-continuous-900');
  report.checks.push('A 900px window retains month navigation and correctly aligns distant targets without horizontal overflow.');
  assert.deepEqual(report.rendererErrors, []);
  report.passed = true;
} catch (error) {
  report.error = String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/archive-navigation-ui-failure-0.3.8.png', animations: 'disabled' }).catch(() => {});
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync('test-results/archive-navigation-ui-0.3.8.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, measurements: report.measurements, error: report.error }));
  await browser?.close();
  await server?.close();
}
