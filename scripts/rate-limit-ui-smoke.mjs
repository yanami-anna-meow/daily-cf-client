// Focused renderer verification using only the shared in-memory ClientAPI fixture.
// No credentials, requests to GitHub, or persistent application data are used.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installClientFixture } from './ui-fixture.mjs';

const report = { passed: false, fixture: true, checks: [], screenshots: [], rendererErrors: [] };
let server;
let browser;
let page;
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  const channel = process.env.UI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on('pageerror', error => report.rendererErrors.push(error.message));
  await installClientFixture(page);
  mkdirSync('test-results', { recursive: true });
  mkdirSync('docs/screenshots', { recursive: true });

  async function checkOverflow(label) {
    const overflow = await page.evaluate(() => [...document.querySelectorAll('html, main, .archive-main, .index-panel, .months-panel, .rate-limit-notice')]
      .filter(element => element.getClientRects().length && element.scrollWidth > element.clientWidth + 1)
      .map(element => ({ element: element.className || element.tagName, width: element.clientWidth, content: element.scrollWidth })));
    assert.deepEqual(overflow, [], label);
  }
  async function screenshot(name) {
    if (await page.locator('.toast button').isVisible()) await page.locator('.toast button').click();
    const path = `docs/screenshots/${name}-0.2.10-fixture.png`;
    await page.screenshot({ path, animations: 'disabled' });
    report.screenshots.push({ path, fixture: true });
  }
  async function errorRule(method, key, message, structured = true, waitMs = 3000) {
    await page.evaluate(({ method, key, message, structured, waitMs }) => {
      window.__uiTest.libraryRules.push({ method, key, error: message, persistent: true,
        ...(structured ? { errorCode: 'github_rate_limited', rateLimit: { retryAt: Date.now() + waitMs, resource: 'core', kind: 'primary', authenticated: false } } : {}) });
    }, { method, key, message, structured, waitMs });
  }
  async function clearRules() { await page.evaluate(() => { window.__uiTest.libraryRules = []; }); }
  async function waitForRetry() {
    await page.waitForFunction(() => { const button = document.querySelector('.rate-limit-actions button:last-child'); return button && !button.disabled; });
  }

  for (const language of ['zh-CN', 'en']) {
    const en = language === 'en';
    const text = {
      archive: en ? 'Problem archive' : '历史题库', latest: en ? 'Latest problems' : '最新题目',
      all: en ? 'Search all problems' : '全库检索', month: en ? 'Browse by month' : '按月浏览',
      stopped: en ? 'Archive loading stopped' : '全库加载已停止', ready: en ? 'Full archive ready' : '全库题目已就绪',
      reloadAll: en ? 'Reload full archive' : '重新加载全库', reload: en ? 'Reload' : '重新加载',
      failedLatest: en ? 'Could not load problems' : '题库加载失败',
      notice: en ? 'GitHub requests are temporarily limited' : 'GitHub 请求暂时受限',
      login: en ? 'Sign in to GitHub' : '登录 GitHub', close: en ? 'Close' : '关闭',
      refreshArchive: en ? 'Refresh archive' : '刷新题库', refreshLatest: en ? 'Refresh' : '刷新',
    };
    const message = en
      ? 'The GitHub guest API request allowance is temporarily exhausted. Further requests have stopped. Sign in to GitHub and retry, or try again after 18:30:00.'
      : 'GitHub 访客请求额度暂时用尽，已停止继续请求。请登录 GitHub 后重试，或在 18:30:00 后重试。';
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`http://127.0.0.1:${address.port}/?localeFixture=1&uiLanguage=${language}`, { waitUntil: 'networkidle' });
    await page.locator('.problem-card').first().waitFor();
    await page.evaluate(() => {
      const fixture = window.__uiTest;
      fixture.switchAccount(null);
      fixture.archiveMonths = ['2024-03', '2024-02', '2024-01'].map(month => ({ month, days: 1 }));
      fixture.monthOverrides = Object.fromEntries(fixture.archiveMonths.map(({ month }, index) => [month, [fixture.makeLibraryDay(`${month}-05`, `Loaded month ${month}`, `cf${8100 + index}a`)]]));
    });
    await page.getByRole('navigation').getByRole('button', { name: text.archive, exact: true }).click();
    await page.getByRole('heading', { name: 'Loaded month 2024-03', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__uiTest.archiveSnapshotRequests.length), 0, 'Monthly browsing uses the ordinary directory API.');
    await errorRule('month', '2024-02', message);
    await page.getByRole('button', { name: text.all, exact: true }).click();
    const index = page.locator('.index-panel');
    await index.getByText(text.stopped, { exact: true }).waitFor();
    const notice = page.locator('.rate-limit-notice');
    await notice.getByText(text.notice, { exact: true }).waitFor();
    assert.match(await notice.textContent(), /\d{1,2}:\d{2}:\d{2}/);
    assert.match(await notice.textContent(), en ? /guest API request allowance/ : /访客请求额度/);
    assert(await notice.getByRole('button', { name: text.reload, exact: true }).isDisabled());
    assert(await index.getByRole('button', { name: text.reloadAll, exact: true }).isDisabled());
    assert(await page.locator('.page-heading').getByRole('button', { name: text.refreshArchive, exact: true }).isDisabled());
    const firstAttempt = await page.evaluate(() => ({ snapshots: window.__uiTest.archiveSnapshotRequests, months: window.__uiTest.snapshotMonthRequests }));
    assert.equal(firstAttempt.snapshots.length, 1);
    assert.deepEqual(firstAttempt.months.map(item => item.month), ['2024-03', '2024-02']);
    assert(firstAttempt.months.every(item => item.snapshot.revision === firstAttempt.snapshots[0].revision));
    assert.equal(await page.locator('.problem-card').count(), 1, 'Completed month results remain visible after throttling.');
    assert.equal(await page.locator('.index-panel .spin, .library-refresh-progress, main .skeleton').count(), 0);
    assert.equal(await page.getByRole('button', { name: en ? 'Stop loading' : '停止加载', exact: true }).count(), 0);
    await notice.getByRole('button', { name: text.login, exact: true }).click();
    await page.getByRole('dialog', { name: text.login, exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: text.close, exact: true }).click();
    assert.equal(await page.evaluate(() => window.__uiTest.snapshotMonthRequests.length), 2, 'Opening and dismissing sign-in cannot restart library requests.');
    await checkOverflow(`${language} stopped full library desktop`);
    await screenshot(en ? 'rate-limit-library-english' : 'rate-limit-library');
    await page.setViewportSize({ width: 900, height: 650 });
    await checkOverflow(`${language} stopped full library at 900px`);
    await notice.scrollIntoViewIfNeeded();
    await screenshot(en ? 'rate-limit-library-english-900' : 'rate-limit-library-900');
    assert.equal(await page.evaluate(() => window.__uiTest.snapshotMonthRequests.length), 2, 'Stopped rendering must not start a later month.');
    await waitForRetry();
    assert(await index.getByRole('button', { name: text.reloadAll, exact: true }).isEnabled());
    assert(await page.locator('.page-heading').getByRole('button', { name: text.refreshArchive, exact: true }).isEnabled());
    assert.equal(await page.evaluate(() => window.__uiTest.snapshotMonthRequests.length), 2, 'Expiration enables retry without automatically making another request.');
    report.checks.push(`${language}: one snapshot serves monthly reads; a second-month rate error stops immediately and retains the first month. The translated notice shows recovery time, opens sign-in, disables retry until ready, and never requests a later month automatically.`);

    await clearRules();
    await page.evaluate(() => { window.__uiTest.libraryRules.push({ method: 'months', key: 'directory', tag: 'retry-directory', defer: true }); });
    await notice.getByRole('button', { name: text.reload, exact: true }).click();
    await page.waitForFunction(() => window.__uiTest.libraryRequests.some(request => request.tag === 'retry-directory' && request.pending));
    assert.equal(await page.locator('.problem-card').count(), 0, 'Retry clears the previous partial index before loading.');
    assert.equal(await page.evaluate(() => window.__uiTest.archiveSnapshotRequests.length), 2);
    await page.evaluate(() => window.__uiTest.releaseLibrary('retry-directory'));
    await index.getByText(text.ready, { exact: true }).waitFor();
    const retryReads = await page.evaluate(() => window.__uiTest.snapshotMonthRequests.slice(2));
    assert.deepEqual(retryReads.map(item => item.month), ['2024-03', '2024-02', '2024-01']);
    assert(retryReads.every(item => item.snapshot.revision !== firstAttempt.snapshots[0].revision));
    assert.equal(new Set(retryReads.map(item => item.snapshot.revision)).size, 1);
    assert.equal(await page.locator('.problem-card').count(), 3);
    assert.equal(await page.locator('.index-failures').count(), 0);
    report.checks.push(`${language}: explicit retry requests a fresh snapshot, clears the partial result, rereads all months from the start, and restores the complete index.`);

    await errorRule('day', 'latest', message, true, 1800000);
    await page.getByRole('navigation').getByRole('button', { name: text.latest, exact: true }).click();
    await notice.getByText(text.notice, { exact: true }).waitFor();
    assert.match(await notice.textContent(), en ? /guest API request allowance/ : /访客请求额度/);
    assert.equal(await page.locator('.problem-card, main .skeleton, main .spin').count(), 0);
    assert(await notice.getByRole('button', { name: text.reload, exact: true }).isDisabled());
    assert(await page.locator('.today-heading').getByRole('button', { name: text.refreshLatest, exact: true }).isDisabled());
    await checkOverflow(`${language} latest rate error at 900px`);
    await screenshot(en ? 'rate-limit-latest-english-900' : 'rate-limit-latest-900');
    await clearRules();
    const latestBeforeSignIn = await page.evaluate(() => window.__uiTest.dayRequests.length);
    await page.evaluate(() => window.__uiTest.switchAccount('ui_tester'));
    await waitForRetry();
    assert(await page.locator('.today-heading').getByRole('button', { name: text.refreshLatest, exact: true }).isEnabled());
    assert.equal(await page.evaluate(() => window.__uiTest.dayRequests.length), latestBeforeSignIn, 'Account recovery enables retry without requesting latest again automatically.');
    assert.equal(await notice.getByRole('button', { name: text.login, exact: true }).count(), 0);
    await notice.getByRole('button', { name: text.reload, exact: true }).click();
    await page.locator('.problem-card').first().waitFor();
    await page.evaluate(() => window.__uiTest.switchAccount(null));
    report.checks.push(`${language}: a latest-day rate error clears loading and stale cards; signing in enables recovery before the guest reset time, without an automatic request, and explicit retry succeeds.`);

    await errorRule('months', 'directory', message);
    await page.getByRole('navigation').getByRole('button', { name: text.archive, exact: true }).click();
    await notice.getByText(text.notice, { exact: true }).waitFor();
    await page.getByRole('button', { name: text.all, exact: true }).click();
    await index.getByText(text.stopped, { exact: true }).waitFor();
    const beforeDirectoryFailure = await page.evaluate(() => window.__uiTest.snapshotMonthRequests.length);
    await page.getByRole('button', { name: text.month, exact: true }).click();
    await notice.getByText(text.notice, { exact: true }).waitFor();
    assert.equal(await page.locator('main .spin, main .skeleton').count(), 0);
    assert.equal(await page.locator('.months-list button, .problem-card').count(), 0);
    assert.equal(await page.evaluate(() => window.__uiTest.snapshotMonthRequests.length), beforeDirectoryFailure);
    await checkOverflow(`${language} monthly directory rate error at 900px`);
    await screenshot(en ? 'rate-limit-directory-english-900' : 'rate-limit-directory-900');
    await clearRules();
    await waitForRetry();
    await notice.getByRole('button', { name: text.reload, exact: true }).click();
    await page.getByRole('heading', { name: 'Loaded month 2024-03', exact: true }).waitFor();
    report.checks.push(`${language}: snapshot and monthly-directory rate errors exit loading without further month reads; the directory remains empty until an explicit successful retry.`);
  }
  assert.deepEqual(report.rendererErrors, []);
  report.passed = true;
} catch (error) {
  report.error = String(error);
  if (page && !page.isClosed()) {
    report.location = page.url();
    report.body = await page.locator('body').innerText().catch(() => '');
    await page.screenshot({ path: 'test-results/rate-limit-ui-failure-0.2.10.png', animations: 'disabled' }).catch(() => {});
  }
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync('test-results/rate-limit-ui-0.2.10.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, screenshots: report.screenshots.length, error: report.error }));
  await browser?.close();
  await server?.close();
}
