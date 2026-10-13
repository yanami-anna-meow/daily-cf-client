// Repository-sync renderer checks. The ClientAPI below is an explicit fixture;
// real Git transport is verified separately and no GitHub requests occur here.
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
  const notice = page.locator('.library-sync-notice');
  const nav = page.getByRole('navigation');
  const latestRefresh = page.locator('.today-heading').getByRole('button', { name: '刷新', exact: true });
  async function phase(value) { await page.locator(`.library-sync-notice[data-sync-phase="${value}"]`).waitFor(); }
  async function ready() { await phase('ready'); }
  async function rule(value) { await page.evaluate(next => window.__uiTest.syncRules.push(next), value); }
  async function waitPending(tag) { await page.waitForFunction(tag => window.__uiTest.syncRequests.some(request => request.tag === tag && request.pending), tag); }
  async function release(tag) {
    await page.evaluate(tag => window.__uiTest.releaseSync(tag), tag);
    await page.waitForFunction(tag => window.__uiTest.syncRequests.some(request => request.tag === tag && request.completed), tag);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function noOverflow(context) {
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('html, main, .library-sync-notice, .library-sync-content')]
      .filter(element => element.getClientRects().length && element.scrollWidth > element.clientWidth + 1)
      .map(element => element.className || element.tagName)), [], context);
  }
  async function screenshot(name) {
    if (await page.locator('.toast button').isVisible()) await page.locator('.toast button').click();
    const path = `docs/screenshots/${name}-0.3.0-fixture.png`;
    await page.screenshot({ path, animations: 'disabled' });
    report.screenshots.push({ path, fixture: true });
  }
  async function requests() { return page.evaluate(() => structuredClone(window.__uiTest.syncRequests)); }

  await page.goto(`http://127.0.0.1:${address.port}/?localeFixture=1&holdStartupSync=1`, { waitUntil: 'networkidle' });
  await phase('downloading');
  const progress = notice.getByRole('progressbar', { name: '题库更新进度', exact: true });
  assert.equal(await progress.getAttribute('value'), '262144');
  assert.equal(await progress.getAttribute('max'), '1048576');
  assert.match(await notice.textContent(), /256 KB \/ 1 MB/);
  assert(await latestRefresh.isDisabled());
  assert.equal(await page.getByTestId('library-sync-refresh').count(), 0, 'Latest uses its heading refresh, with no duplicate strip action.');
  assert((await requests()).every(request => request.source === 'getDay'), 'Startup content reads perform their own sync, without extra explicit calls.');
  await screenshot('library-first-download');
  await page.evaluate(() => window.__uiTest.emitSync({ phase: 'downloading', completed: 524288, unit: 'bytes' }));
  assert.equal(await progress.getAttribute('value'), null, 'Unknown download totals use an indeterminate progress element.');
  assert.match(await notice.textContent(), /512 KB/);
  await page.evaluate(() => window.__uiTest.emitSync({ phase: 'indexing', completed: 12, total: 40, unit: 'objects' }));
  await phase('indexing');
  assert.equal(await progress.getAttribute('value'), '12');
  await page.evaluate(() => {
    window.__uiTest.syncRules = [];
    while (window.__uiTest.syncRequests.some(request => request.tag === 'startup-sync' && request.pending)) window.__uiTest.releaseSync('startup-sync');
  });
  await ready();
  await page.locator('.problem-card').first().waitFor();
  assert.equal(await notice.getByRole('progressbar').count(), 0);
  assert.equal(await notice.locator('time').count(), 1);
  assert(await latestRefresh.isEnabled());
  report.checks.push('Startup synchronizes through content reads only; first-download byte totals, unknown totals and indexing objects render accurately, ready displays the update time, and loading disables duplicate refresh actions.');

  let start = (await requests()).length;
  await nav.getByRole('button', { name: '历史题库', exact: true }).click();
  await page.locator('.problem-card').first().waitFor(); await ready();
  assert.deepEqual((await requests()).slice(start).map(request => request.source), ['getArchiveSnapshot']);
  let snapshots = await page.evaluate(() => window.__uiTest.archiveSnapshotRequests.length);
  start = (await requests()).length;
  await page.getByRole('button', { name: '全库检索', exact: true }).click();
  await page.getByText('全库题目已就绪', { exact: true }).waitFor();
  assert.deepEqual((await requests()).slice(start).map(request => request.source), ['getArchiveSnapshot']);
  assert.equal(await page.evaluate(() => window.__uiTest.archiveSnapshotRequests.length), snapshots + 1);
  assert.equal(await page.getByTestId('library-sync-refresh').count(), 0);
  start = (await requests()).length;
  await page.locator('.page-heading').getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByText('全库题目已就绪', { exact: true }).waitFor(); await ready();
  assert.deepEqual((await requests()).slice(start).map(request => request.source), ['getArchiveSnapshot']);
  report.checks.push('Monthly entry, all-month entry and archive refresh each synchronize once through a snapshot; reading the months in that snapshot adds no duplicate syncLibrary calls.');

  await page.evaluate(() => window.__uiTest.switchAccount(null));
  start = (await requests()).length;
  await nav.getByRole('button', { name: '提交记录', exact: true }).click();
  await page.getByRole('heading', { name: '登录 GitHub，查看你的提交', exact: true }).waitFor(); await ready();
  assert.deepEqual((await requests()).slice(start).map(request => request.source), ['syncLibrary']);
  const historyRefresh = page.locator('.page-heading').getByRole('button', { name: '刷新', exact: true });
  assert(await historyRefresh.isEnabled(), 'Signed-out contribution pages still offer repository refresh.');
  start = (await requests()).length;
  await historyRefresh.click(); await ready();
  assert.deepEqual((await requests()).slice(start).map(request => request.source), ['syncLibrary']);
  assert.equal(await page.getByTestId('library-sync-refresh').count(), 0);
  start = (await requests()).length;
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('默认编程语言').waitFor(); await ready();
  assert.deepEqual((await requests()).slice(start).map(request => request.source), ['syncLibrary']);
  assert(await page.getByTestId('library-sync-refresh').isVisible());
  await rule({ source: 'syncLibrary', silent: true, error: 'Fixture worker connection interrupted' });
  await page.getByTestId('library-sync-refresh').click();
  await phase('error');
  assert.match(await notice.textContent(), /Fixture worker connection interrupted/);
  assert(await page.getByTestId('library-sync-refresh').isEnabled());
  await screenshot('library-sync-failure');
  await page.getByTestId('library-sync-refresh').click(); await ready();
  report.checks.push('History and Settings entry explicitly synchronize once; signed-out history refresh remains available, Settings has one strip action, IPC failures without worker events remain visible, and retry recovers.');

  // An earlier explicit IPC call may reject after a newer content page has
  // already received authoritative worker progress. Never invent stale events.
  await nav.getByRole('button', { name: '最新题目', exact: true }).click(); await ready();
  await rule({ source: 'syncLibrary', defer: true, tag: 'older-settings', error: 'Obsolete settings IPC failure' });
  await page.getByRole('button', { name: '设置', exact: true }).click(); await waitPending('older-settings');
  await phase('checking');
  assert(await page.getByTestId('library-sync-refresh').isDisabled());
  await nav.getByRole('button', { name: '最新题目', exact: true }).click();
  await page.locator('.problem-card').first().waitFor(); await ready();
  await release('older-settings');
  assert.equal(await notice.getAttribute('data-sync-phase'), 'ready');
  assert.doesNotMatch(await notice.textContent(), /Obsolete settings/);
  await rule({ source: 'syncLibrary', defer: true, tag: 'older-after-terminal', error: 'Already reported worker failure' });
  await page.getByRole('button', { name: '设置', exact: true }).click(); await waitPending('older-after-terminal');
  await page.evaluate(() => window.__uiTest.emitSync({ phase: 'error', completed: 0, unit: 'objects', message: 'Already reported worker failure' }));
  await phase('error');
  await rule({ source: 'getDay', defer: true, tag: 'newer-checking' });
  await nav.getByRole('button', { name: '最新题目', exact: true }).click(); await waitPending('newer-checking'); await phase('checking');
  await release('older-after-terminal');
  assert.equal(await notice.getAttribute('data-sync-phase'), 'checking');
  assert.doesNotMatch(await notice.textContent(), /Already reported/);
  await release('newer-checking'); await ready();
  report.checks.push('Navigation remains available during synchronization. A late Settings IPC rejection cannot replace a newer Latest ready state, or replace a newer checking state after an earlier terminal worker event.');

  await rule({ source: 'getDay', error: 'Fixture Git sync failed' });
  await latestRefresh.click(); await phase('error');
  await page.getByRole('heading', { name: '题库加载失败', exact: true }).waitFor();
  assert.equal(await page.locator('.problem-card').count(), 0, 'A failed content sync cannot keep stale problem cards visible.');
  await latestRefresh.click(); await page.locator('.problem-card').first().waitFor(); await ready();
  await page.locator('.problem-card').first().getByRole('button', { name: '查看题目', exact: true }).click();
  await page.locator('.detail-heading').waitFor(); await ready();
  await page.getByRole('tab', { name: /^参考代码/ }).click();
  await page.locator('.reference-list button').first().click();
  await page.locator('.code-view').waitFor();
  await page.evaluate(() => {
    const fixture = window.__uiTest;
    fixture.deletedOriginal = structuredClone(fixture.latestDay);
    fixture.dayOverrides[fixture.latestDay.date] = { ...fixture.latestDay, problems: [] };
  });
  await page.getByTestId('library-sync-refresh').click();
  await page.getByRole('heading', { name: '题目读取失败', exact: true }).waitFor();
  await ready();
  assert.equal(await page.locator('.detail-heading, .detail-submit-actions, .resource-panel, .code-view').count(), 0);
  assert.match(await page.locator('main').textContent(), /仓库中已找不到这道题/);
  assert(await page.getByRole('button', { name: '返回题目列表', exact: true }).isEnabled());
  await screenshot('library-deleted-problem');
  await page.evaluate(() => { window.__uiTest.dayOverrides[window.__uiTest.deletedOriginal.date] = window.__uiTest.deletedOriginal; });
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await page.locator('.detail-heading').waitFor(); await ready();
  assert.equal(await page.locator('.detail-submit-actions').count(), 1);
  report.checks.push('Content sync failures clear stale cards. If a refreshed day no longer contains the selected problem, the old details, reference code and submission action disappear; navigation remains usable and restoring the problem allows explicit retry.');

  await page.goto(`http://127.0.0.1:${address.port}/?localeFixture=1&uiLanguage=en`, { waitUntil: 'networkidle' });
  await page.locator('.problem-card').first().waitFor(); await ready();
  await page.setViewportSize({ width: 900, height: 650 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await rule({ source: 'syncLibrary', defer: true, tag: 'english-download', progress: [{ phase: 'downloading', completed: 1048576, unit: 'bytes' }] });
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await waitPending('english-download');
  await phase('downloading');
  const englishProgress = notice.getByRole('progressbar', { name: 'Library update progress', exact: true });
  assert.equal(await englishProgress.getAttribute('value'), null);
  assert.match(await notice.textContent(), /Downloading/);
  await noOverflow('English unknown-size download at 900px in dark mode');
  await screenshot('library-sync-english-dark-900');
  await release('english-download'); await ready();
  assert.match(await notice.textContent(), /Library up to date/);
  await noOverflow('English completed sync at 900px');
  report.checks.push('The English compact sync strip remains readable at 900px in dark mode, translates download/ready states, renders unknown-size progress without a percentage, and has no horizontal overflow.');
  assert.deepEqual(report.rendererErrors, []);
  report.passed = true;
} catch (error) {
  report.error = String(error);
  if (page && !page.isClosed()) {
    report.body = await page.locator('body').innerText().catch(() => '');
    report.requests = await page.evaluate(() => window.__uiTest?.syncRequests || []).catch(() => []);
    await page.screenshot({ path: 'test-results/library-sync-ui-failure-0.3.0.png', animations: 'disabled' }).catch(() => {});
  }
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync('test-results/library-sync-ui-0.3.0.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, screenshots: report.screenshots.length, error: report.error }));
  await browser?.close();
  await server?.close();
}
