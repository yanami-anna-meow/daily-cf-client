// Deterministic stale-while-revalidate UI checks. Uses one Edge page and an
// explicit ClientAPI fixture; no credentials or live GitHub writes are involved.
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
  server = await createServer({ server: { host: '127.0.0.1', port: Number(process.env.UI_TEST_PORT || 45173), strictPort: false }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/`;
  const channel = process.env.UI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on('pageerror', error => report.rendererErrors.push(error.message));
  await installClientFixture(page);
  mkdirSync('test-results', { recursive: true }); mkdirSync('docs/screenshots', { recursive: true });
  const nav = page.getByRole('navigation', { name: '主导航' });
  const cards = page.locator('.problem-card');
  const retained = page.getByTestId('retained-content-note');
  const latestRefresh = page.locator('.today-heading').getByRole('button', { name: '刷新', exact: true });
  const archiveRefresh = page.locator('.page-heading').getByRole('button', { name: '刷新', exact: true });
  async function frames() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  async function libraryRule(rule) { await page.evaluate(value => window.__uiTest.libraryRules.push(value), rule); }
  async function syncRule(rule) { await page.evaluate(value => window.__uiTest.syncRules.push(value), rule); }
  async function pending(tag, sync = false) { await page.waitForFunction(({ tag, sync }) => window.__uiTest[sync ? 'syncRequests' : 'libraryRequests'].some(request => request.tag === tag && request.pending), { tag, sync }); }
  async function release(tag, sync = false) {
    await page.evaluate(({ tag, sync }) => window.__uiTest[sync ? 'releaseSync' : 'releaseLibrary'](tag), { tag, sync });
    await page.waitForFunction(({ tag, sync }) => window.__uiTest[sync ? 'syncRequests' : 'libraryRequests'].some(request => request.tag === tag && request.completed), { tag, sync });
    await frames();
  }
  async function title(name) { await page.getByRole('heading', { name, exact: true }).waitFor(); }
  async function archiveReady(expectedCards) {
    // A missing panel alone is insufficient: it is also hidden while a retained
    // snapshot is being checked. Require the request and usable final UI too.
    await page.waitForFunction(expected => {
      const fixture = window.__uiTest;
      const sync = fixture.syncRequests.filter(request => request.source === 'getArchiveSnapshot').at(-1);
      const directory = fixture.libraryRequests.filter(request => request.method === 'months').at(-1);
      const month = fixture.libraryRequests.filter(request => request.method === 'month').at(-1);
      const refresh = [...document.querySelectorAll('.page-heading button')].find(button => /^(刷新|Refresh)$/.test(button.textContent.trim()));
      return sync?.completed && directory?.completed && (!month || month.completed) && refresh && !refresh.disabled
        && document.querySelector('#archive-browser')
        && !document.querySelector('.index-panel, .library-refresh-progress, .retained-content-warning')
        && document.querySelectorAll('.problem-card').length === expected;
    }, expectedCards);
    assert.equal(await page.locator('.archive-toolbar').evaluate(element => element.firstElementChild?.classList.contains('search-field')), true, 'Ready filters start with the search field, without an empty status wrapper.');
    const gap = await page.locator('.archive-toolbar').evaluate(element => element.querySelector('.search-field').getBoundingClientRect().top - element.getBoundingClientRect().top);
    assert(gap <= 26, `Removing the completed panel must not reserve blank space; actual inner gap: ${gap}px.`);
  }
  async function shot(name) {
    const path = `docs/screenshots/${name}-0.3.8-fixture.png`;
    await page.screenshot({ path, animations: 'disabled' }); report.screenshots.push({ path, fixture: true });
  }
  async function noOverflow(context) {
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('html, main, .retained-content-note, .reference-viewer')].filter(element => element.getClientRects().length && element.scrollWidth > element.clientWidth + 1).map(element => element.className || element.tagName)), [], context);
  }
  async function oneArchiveUpdateNotice() {
    assert.equal(await retained.count(), 0, 'No duplicate retained-content notice is mounted while updating.');
    assert.equal(await page.locator('.library-sync-notice').count(), 1);
    assert.equal(await page.locator('.library-sync-notice').getAttribute('data-sync-phase'), 'checking');
    assert.match(await page.locator('.library-sync-notice').textContent(), /正在更新题库…/);
    assert.equal(await page.locator('.archive-mode-switch').count(), 0, 'The unified archive does not expose a separate month/all mode switch.');
  }

  await page.goto(`${base}?localeFixture=1&localStartup=1&holdStartupSync=1`, { waitUntil: 'networkidle' });
  await pending('startup-sync', true); await title('Local snapshot shown while checking');
  assert.equal(await cards.count(), 1);
  assert.equal(await retained.count(), 0, 'Loading does not render a second retained-content notice.');
  assert(await latestRefresh.isDisabled());
  await shot('retained-startup');
  await page.evaluate(() => { window.__uiTest.syncRules = []; while (window.__uiTest.syncRequests.some(request => request.tag === 'startup-sync' && request.pending)) window.__uiTest.releaseSync('startup-sync'); });
  await title('远端题目标题：原文保持');
  assert.equal(await page.getByRole('heading', { name: 'Local snapshot shown while checking', exact: true }).count(), 0);
  await latestRefresh.waitFor();
  report.checks.push('Startup renders a verified existing local snapshot while Git is updating, uses the single global progress notice without a repeated lower notice, then replaces it with the fresh result.');

  await libraryRule({ method: 'day', key: 'latest', defer: true, tag: 'latest-held' });
  await latestRefresh.click(); await pending('latest-held');
  assert.equal(await cards.count(), 17); await title('远端题目标题：原文保持');
  assert.equal(await retained.count(), 0, 'Loading does not render a second retained-content notice.');
  await release('latest-held');
  await syncRule({ source: 'getDay', error: 'Fixture offline while checking' });
  await latestRefresh.click();
  await retained.filter({ hasText: 'Fixture offline while checking' }).waitFor();
  assert.match(await retained.textContent(), /题库更新未完成，当前显示上次读取的内容。/);
  assert(await retained.getByRole('button', { name: '重试', exact: true }).isEnabled());
  assert.equal(await cards.count(), 17); await title('远端题目标题：原文保持');
  await shot('retained-offline');
  await page.evaluate(() => { window.__uiTest.latestDay = window.__uiTest.makeLibraryDay('2044-03-04', 'Newest replacement', 'cf8444a'); });
  await retained.getByRole('button', { name: '重试', exact: true }).click(); await title('Newest replacement');
  assert.equal(await cards.count(), 1); assert.equal(await retained.count(), 0);
  assert.equal(await page.getByRole('heading', { name: '远端题目标题：原文保持', exact: true }).count(), 0);
  report.checks.push('Same-view refresh keeps prior cards readable; network failures retain them with a visible stale warning, and successful retry atomically replaces the old date and cards.');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await syncRule({ source: 'getDay', defer: true, tag: 'return-latest' });
  await nav.getByRole('button', { name: '最新题目', exact: true }).click(); await pending('return-latest', true);
  await title('Newest replacement'); assert.equal(await retained.count(), 0, 'Loading does not render a second retained-content notice.');
  await release('return-latest', true);
  report.checks.push('Navigating away and back restores the matching in-memory view immediately while still performing a fresh repository check.');

  await page.goto(`${base}?localeFixture=1&lateLocalStartup=1&holdStartupSync=1`, { waitUntil: 'networkidle' });
  await pending('late-local-startup'); await pending('startup-sync', true);
  await page.evaluate(() => { window.__uiTest.syncRules = []; while (window.__uiTest.syncRequests.some(request => request.tag === 'startup-sync' && request.pending)) window.__uiTest.releaseSync('startup-sync'); });
  await title('远端题目标题：原文保持');
  await release('late-local-startup');
  assert.equal(await page.getByRole('heading', { name: 'Obsolete delayed local preview', exact: true }).count(), 0);
  assert.equal(await cards.count(), 17);
  report.checks.push('A delayed local preview cannot overwrite a fresh completed response.');

  await page.goto(`${base}?localeFixture=1&lateLocalStartup=1&holdStartupSync=1`, { waitUntil: 'networkidle' });
  await pending('late-local-startup'); await pending('startup-sync', true);
  await syncRule({ source: 'getArchiveSnapshot', defer: true, tag: 'initial-archive-check' });
  await nav.getByRole('button', { name: '历史题库', exact: true }).click();
  await pending('initial-archive-check', true); await page.getByRole('heading', { name: '历史题库', exact: true }).waitFor();
  await oneArchiveUpdateNotice(); await shot('library-archive-initial-update');
  await release('initial-archive-check', true); await archiveReady(35);
  await release('late-local-startup');
  await page.evaluate(() => { window.__uiTest.syncRules = []; while (window.__uiTest.syncRequests.some(request => request.tag === 'startup-sync' && request.pending)) window.__uiTest.releaseSync('startup-sync'); });
  await frames();
  assert.equal(await page.getByRole('heading', { name: 'Obsolete delayed local preview', exact: true }).count(), 0);
  assert.equal(await page.locator('.today-heading').count(), 0);
  report.checks.push('Leaving a view cancels its display generation: neither a late local preview nor the late fresh response can replace the currently selected page.');

  await page.goto(`${base}?localeFixture=1`, { waitUntil: 'networkidle' });
  await title('远端题目标题：原文保持');
  await page.evaluate(() => {
    const fixture = window.__uiTest;
    fixture.archiveMonths = [{ month: '2040-03', days: 1 }, { month: '2040-02', days: 1 }];
    fixture.monthOverrides['2040-03'] = [fixture.makeLibraryDay('2040-03-05', 'March previous', 'cf8400a')];
    fixture.monthOverrides['2040-02'] = [fixture.makeLibraryDay('2040-02-05', 'February previous', 'cf8401a')];
  });
  await libraryRule({ method: 'month', key: '2040-03', defer: true, tag: 'first-all-build' });
  await nav.getByRole('button', { name: '历史题库', exact: true }).click(); await pending('first-all-build');
  assert(await page.locator('.index-panel').isVisible(), 'The actual first load keeps its status and stop action visible.');
  assert.deepEqual(await page.getByRole('progressbar', { name: '全库加载进度', exact: true }).evaluate(element => ({ value: element.value, max: element.max })), { value: 0, max: 2 });
  assert.equal(await cards.count(), 0);
  await shot('all-library-first-build');
  await release('first-all-build'); await archiveReady(2);
  assert.equal(await cards.count(), 2);
  assert.equal(await page.getByRole('progressbar', { name: '全库加载进度', exact: true }).count(), 0, 'A completed archive does not keep a fake loading progress bar.');
  await shot('all-library-complete');
  report.checks.push('Entering the archive directly builds every month with progress; after successful completion the entire status panel disappears, filters start directly with search without a blank gap, and all expected cards remain searchable.');

  const beforeJump = await page.evaluate(() => ({ months: window.__uiTest.snapshotMonthRequests.length, snapshots: window.__uiTest.archiveSnapshotRequests.length,
    monthReads: window.__uiTest.libraryRequests.filter(request => request.method === 'month').length, syncs: window.__uiTest.syncRequests.length }));
  const februaryJump = page.locator('button[data-month-jump="2040-02"]');
  const marchJump = page.locator('button[data-month-jump="2040-03"]');
  await februaryJump.click();
  await page.waitForFunction(() => document.querySelector('button[data-month-jump="2040-02"]')?.getAttribute('aria-current') === 'location');
  assert.equal(await cards.count(), 2, 'Month navigation scrolls without hiding other months.');
  assert.equal(await page.locator('.archive-month[data-archive-month="2040-03"] .problem-card').count(), 1);
  assert.equal(await page.locator('.archive-month[data-archive-month="2040-02"] .problem-card').count(), 1);
  const dateInput = page.getByLabel('选择题目日期', { exact: true });
  await dateInput.fill('2040-03-05'); await dateInput.press('Enter');
  await page.waitForFunction(() => document.querySelector('button[data-month-jump="2040-03"]')?.getAttribute('aria-current') === 'location');
  assert.equal(await page.locator('.archive-day-located[data-problem-date="2040-03-05"]').count(), 1);
  assert.equal(await cards.count(), 2, 'Date navigation keeps the entire archive visible.');
  await page.getByLabel('搜索全库题目').fill('February');
  await title('February previous'); assert.equal(await cards.count(), 1, 'Search remains global after selecting a different month or date.');
  await page.getByLabel('搜索全库题目').fill(''); await archiveReady(2);
  await marchJump.click(); await frames();
  const afterJump = await page.evaluate(() => ({ months: window.__uiTest.snapshotMonthRequests.length, snapshots: window.__uiTest.archiveSnapshotRequests.length,
    monthReads: window.__uiTest.libraryRequests.filter(request => request.method === 'month').length, syncs: window.__uiTest.syncRequests.length }));
  assert.deepEqual(afterJump, beforeJump, 'Month/date navigation and global filters never reread the snapshot or any month.');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await syncRule({ source: 'getArchiveSnapshot', defer: true, tag: 'archive-reentry-check' });
  await nav.getByRole('button', { name: '历史题库', exact: true }).click(); await pending('archive-reentry-check', true);
  await title('March previous'); await title('February previous');
  await oneArchiveUpdateNotice(); await shot('library-archive-reentry-update');
  await release('archive-reentry-check', true); await archiveReady(2);
  report.checks.push('The unified archive highlights the selected month; month/date navigation only scrolls, keeps other months visible, and issues zero snapshot/month requests. Filters remain global and re-entry restores the full view beneath one update notice.');

  for (const trigger of ['refresh', 'reentry']) {
    if (trigger === 'reentry') await page.getByRole('button', { name: '设置', exact: true }).click();
    const before = await page.evaluate(() => ({ months: window.__uiTest.snapshotMonthRequests.length, snapshots: window.__uiTest.archiveSnapshotRequests.length, revision: window.__uiTest.archiveSnapshotRequests.at(-1).revision }));
    const tag = `same-sha-${trigger}`;
    await syncRule({ source: 'getArchiveSnapshot', defer: true, tag });
    if (trigger === 'refresh') await archiveRefresh.click(); else await nav.getByRole('button', { name: '历史题库', exact: true }).click();
    await pending(tag, true); await title('March previous'); await title('February previous');
    assert.equal(await page.locator('.index-panel, .library-refresh-progress').count(), 0, 'Rechecking a complete view only uses the global synchronization status.');
    assert.equal(await retained.count(), 0);
    assert.equal(await page.getByRole('progressbar', { name: '全库加载进度', exact: true }).count(), 0);
    assert.match(await page.locator('.library-sync-notice').textContent(), /正在更新题库/);
    assert(await page.getByLabel('搜索全库题目').isEnabled());
    await page.getByLabel('搜索全库题目').fill('March'); assert.equal(await cards.count(), 1);
    await page.getByLabel('搜索全库题目').fill(''); assert.equal(await cards.count(), 2);
    if (trigger === 'refresh') await shot('all-library-checking-same-version');
    await release(tag, true); await archiveReady(2);
    const after = await page.evaluate(() => ({ months: window.__uiTest.snapshotMonthRequests.length, snapshots: window.__uiTest.archiveSnapshotRequests.length, revision: window.__uiTest.archiveSnapshotRequests.at(-1).revision }));
    assert.equal(after.snapshots, before.snapshots + 1, 'Manual refresh and re-entry still check the remote snapshot.');
    assert.equal(after.revision, before.revision);
    assert.equal(after.months, before.months, 'An unchanged complete Git revision does not request or parse any months again.');
    assert.equal(await page.getByRole('progressbar', { name: '全库加载进度', exact: true }).count(), 0);
  }
  report.checks.push('Manual refresh and returning to a completed full archive each check the remote snapshot once, request zero months for the unchanged revision, and keep filters and cards usable without a duplicate indexing panel or fake progress.');
  await page.evaluate(() => {
    const fixture = window.__uiTest;
    fixture.monthOverrides['2040-03'] = [fixture.makeLibraryDay('2040-03-05', 'March next', 'cf8400a')];
    fixture.monthOverrides['2040-02'] = [fixture.makeLibraryDay('2040-02-05', 'February next', 'cf8401a')];
    fixture.libraryRules.push({ method: 'month', key: '2040-02', defer: true, tag: 'all-last-month' });
  });
  await archiveRefresh.click(); await pending('all-last-month');
  await title('March previous'); await title('February previous');
  assert.equal(await page.getByRole('heading', { name: 'March next', exact: true }).count(), 0, 'Do not mix new and old months while a complete existing all-library snapshot is being refreshed.');
  assert.deepEqual(await page.getByRole('progressbar', { name: '全库加载进度', exact: true }).evaluate(element => ({ value: element.value, max: element.max })), { value: 1, max: 2 }, 'Refresh progress describes newly read months, independently of the retained old result count.');
  await page.waitForTimeout(350);
  await shot('retained-all-library');
  await release('all-last-month'); await title('March next'); await title('February next');
  assert.equal(await page.getByRole('heading', { name: /previous$/ }).count(), 0);
  await page.evaluate(() => {
    const fixture = window.__uiTest;
    fixture.monthOverrides['2040-02'][0].problems[0].label = 'February after failed update';
    fixture.libraryRules.push({ method: 'month', key: '2040-02', error: 'Fixture changed archive read failure' });
  });
  await archiveRefresh.click(); await retained.filter({ hasText: 'Fixture changed archive read failure' }).waitFor();
  await title('March next'); await title('February next');
  assert.equal(await page.getByRole('heading', { name: 'February after failed update', exact: true }).count(), 0);
  assert.equal(await page.getByRole('progressbar', { name: '全库加载进度', exact: true }).count(), 0);
  await page.getByText('全库加载未完成', { exact: true }).waitFor();
  assert(await page.locator('.index-panel').isVisible(), 'A failed update retains its error and retry panel.');
  await shot('all-library-changed-version-failure');
  await retained.getByRole('button', { name: '重试', exact: true }).click(); await title('February after failed update');
  await archiveReady(2);
  report.checks.push('A changed revision still builds a new full snapshot atomically; a failed month keeps the prior complete view, stops progress, and shows a working retry that publishes the new result only after success.');
  await page.evaluate(() => { window.__uiTest.monthOverrides['2040-03'][0].problems[0].label = 'March after stopped update'; });
  await libraryRule({ method: 'month', key: '2040-02', defer: true, tag: 'changed-archive-stop' });
  await archiveRefresh.click(); await pending('changed-archive-stop');
  await page.getByRole('button', { name: '停止加载', exact: true }).click();
  await page.getByText('全库加载已停止', { exact: true }).waitFor(); await title('March next'); await title('February after failed update');
  assert(await page.locator('.index-panel').isVisible(), 'A stopped update retains its status and restart action.');
  assert.equal(await page.getByRole('progressbar', { name: '全库加载进度', exact: true }).count(), 0);
  await release('changed-archive-stop');
  assert.equal(await page.getByRole('heading', { name: 'March after stopped update', exact: true }).count(), 0);
  await page.getByRole('button', { name: '重新加载全库', exact: true }).click(); await title('March after stopped update');
  await archiveReady(2);
  report.checks.push('Stopping a genuinely changed archive load keeps the prior complete view, removes progress, ignores its late response, and can rebuild successfully on retry.');
  await page.evaluate(() => { const fixture = window.__uiTest; fixture.archiveMonths = [{ month: '2040-02', days: 1 }]; fixture.monthOverrides['2040-02'] = []; });
  await archiveRefresh.click(); await archiveReady(0);
  assert.equal(await cards.count(), 0, 'A successful empty result removes previous cards rather than being mistaken for a cache miss.');
  await page.evaluate(() => { window.__uiTest.archiveMonths = []; });
  await archiveRefresh.click(); await archiveReady(0);
  assert.equal(await page.getByText('仓库中暂无历史题单', { exact: true }).count(), 1, 'A successfully empty repository has one empty state and no duplicate status panel.');
  await shot('all-library-empty');
  assert.equal(await page.locator('.months-list button[data-month-jump]').count(), 0);
  assert.equal(await cards.count(), 0);
  report.checks.push('An all-library refresh preserves its complete previous snapshot until all months finish, then swaps atomically; successful deletions, empty months, and an empty repository remove obsolete cards and directory entries without a duplicate status panel.');

  await page.goto(`${base}?localeFixture=1`, { waitUntil: 'networkidle' });
  await title('远端题目标题：原文保持');
  await libraryRule({ method: 'day', key: '2024-03-05', defer: true, tag: 'detail-first-check' });
  await cards.first().getByRole('button', { name: '查看题目', exact: true }).click(); await pending('detail-first-check');
  await page.locator('.detail-heading').waitFor();
  assert.match(await page.locator('.detail-heading').textContent(), /远端题目标题：原文保持/);
  assert.equal(await retained.count(), 0, 'Loading does not render a second retained-content notice.');
  await release('detail-first-check');
  await page.getByRole('tab', { name: '题解', exact: true }).click();
  await page.locator('.markdown-body').waitFor();
  await page.evaluate(() => { window.__uiTest.resourceRevision = 'Fresh editorial revision'; });
  await libraryRule({ method: 'resources', key: '2024-03-05:cf1234a', defer: true, tag: 'resources-held' });
  await page.getByRole('tab', { name: '题解', exact: true }).click(); await pending('resources-held');
  assert(await page.locator('.markdown-body').isVisible());
  assert.doesNotMatch(await page.locator('.markdown-body').textContent(), /Fresh editorial revision/);
  assert.equal(await retained.count(), 0, 'Editorial loading does not repeat the global update notice.');
  await release('resources-held');
  await page.locator('.markdown-body').filter({ hasText: 'Fresh editorial revision' }).waitFor();
  await libraryRule({ method: 'resources', key: '2024-03-05:cf1234a', error: 'Fixture editorial offline' });
  await page.getByRole('tab', { name: '题解', exact: true }).click();
  await retained.filter({ hasText: 'Fixture editorial offline' }).waitFor();
  assert(await page.locator('.markdown-body').filter({ hasText: 'Fresh editorial revision' }).isVisible());
  report.checks.push('Opening a detail keeps the selected card information visible during verification; editorial refresh keeps readable text, swaps its fresh revision, and retains it with a warning if the update fails.');

  await page.getByRole('tab', { name: /^参考代码/ }).click();
  const aliceFile = page.getByRole('button', { name: 'cf1234a_alice.cpp C++', exact: true });
  const bobFile = page.getByRole('button', { name: 'cf1234a_bob.cpp C++', exact: true });
  await aliceFile.click(); await page.locator('.code-view').waitFor();
  const alice = await page.evaluate(() => window.__uiTest.referenceCodes['cf1234a_alice.cpp']);
  assert.equal(await page.locator('.code-view').textContent(), alice);
  await libraryRule({ method: 'reference', key: 'cf1234a_alice.cpp', defer: true, tag: 'reference-held' });
  await aliceFile.click(); await pending('reference-held');
  assert.equal(await page.locator('.code-view').textContent(), alice);
  assert.equal(await retained.count(), 0, 'Reference loading does not repeat the global update notice.');
  await shot('retained-reference');
  await release('reference-held');
  await libraryRule({ method: 'reference', key: 'cf1234a_alice.cpp', error: 'Fixture reference offline' });
  await aliceFile.click(); await retained.filter({ hasText: 'Fixture reference offline' }).waitFor();
  assert.equal(await page.locator('.code-view').textContent(), alice);
  await aliceFile.click();
  await libraryRule({ method: 'reference', key: 'cf1234a_bob.cpp', defer: true, tag: 'different-reference' });
  await bobFile.click(); await pending('different-reference');
  assert.equal(await page.locator('.code-view').count(), 0, 'Selecting another pending file must not leave the previous source under its new filename.');
  await aliceFile.click(); await page.locator('.code-view').waitFor();
  await release('different-reference');
  assert.equal(await page.locator('.code-view').textContent(), alice, 'An earlier file read cannot replace the currently selected reference.');
  await libraryRule({ method: 'reference', key: 'cf1234a_alice.cpp', error: 'Fixture confirmed reference deletion', errorCode: 'library_content_missing' });
  await aliceFile.click();
  await page.locator('.reference-viewer .inline-error').filter({ hasText: 'Fixture confirmed reference deletion' }).waitFor();
  assert.equal(await page.locator('.code-view').count(), 0);
  await libraryRule({ method: 'reference', key: 'cf1234a_alice.cpp', error: 'Fixture retry after deletion is offline' });
  await aliceFile.click();
  await page.locator('.reference-viewer .inline-error').filter({ hasText: 'Fixture retry after deletion is offline' }).waitFor();
  assert.equal(await page.locator('.code-view').count(), 0, 'A later network failure cannot resurrect source whose deletion was confirmed.');
  report.checks.push('Reference reload preserves highlighted source and failed refreshes remain readable. Different-file selection does not relabel old code, late file responses are ignored, and confirmed file deletion remains cleared even when a later retry fails.');

  await page.getByLabel('参考代码语言筛选').selectOption('Python');
  assert.equal(await page.locator('.reference-list button').count(), 1);
  await page.evaluate(() => {
    const references = Object.keys(window.__uiTest.referenceCodes).filter(name => name.endsWith('.cpp')).map(name => ({ name, path: name, language: 'C++', url: `https://github.com/example/example/blob/main/${name}` }));
    window.__uiTest.libraryRules.push({ method: 'resources', key: '2024-03-05:cf1234a', defer: true, tag: 'last-python-deleted', response: { editorial: null, editorialUrl: null, references } });
  });
  await page.getByRole('tab', { name: /^参考代码/ }).click(); await pending('last-python-deleted');
  assert.equal(await page.getByLabel('参考代码语言筛选').inputValue(), 'Python');
  assert.equal(await page.locator('.reference-list button').count(), 1, 'The retained resource list keeps its valid Python filter while checking.');
  await release('last-python-deleted');
  assert.equal(await page.getByLabel('参考代码语言筛选').inputValue(), 'all');
  assert.equal(await page.locator('.reference-list button').count(), 2);
  assert.equal(await page.getByRole('button', { name: 'cf1234a_charlie.py Python', exact: true }).count(), 0);
  assert(await aliceFile.isVisible()); assert(await bobFile.isVisible());
  report.checks.push('When a successful resource refresh deletes the last file in the selected language, the filter switches to all languages and keeps the remaining C++ references visible.');

  await libraryRule({ method: 'resources', key: '2024-03-05:cf1234a', response: { editorial: null, editorialUrl: null, references: [] } });
  await page.getByRole('tab', { name: /^参考代码/ }).click();
  await page.getByRole('heading', { name: '暂无参考代码', exact: true }).waitFor();
  assert.equal(await page.locator('.reference-list button, .code-view').count(), 0);
  await page.evaluate(() => { window.__uiTest.dayOverrides['2024-03-05'] = { ...window.__uiTest.latestDay, problems: [] }; });
  await page.getByTestId('library-sync-refresh').click();
  await page.getByRole('heading', { name: '题目读取失败', exact: true }).waitFor();
  assert.equal(await page.locator('.detail-heading, .detail-submit-actions, .resource-panel, .code-view').count(), 0);
  await shot('retained-confirmed-deletion');
  await libraryRule({ method: 'day', key: '2024-03-05', error: 'Fixture detail retry after deletion is offline' });
  await page.getByTestId('library-sync-refresh').click();
  await page.getByText('Fixture detail retry after deletion is offline', { exact: true }).waitFor();
  assert.equal(await page.locator('.detail-heading, .detail-submit-actions, .resource-panel, .code-view').count(), 0, 'An offline retry must not restore the original selected card after its problem was confirmed deleted.');
  report.checks.push('Fresh empty resource lists remove old files and source; a successfully confirmed deleted problem clears its retained detail, resources and submission action, and a later failed retry cannot resurrect them.');

  await page.goto(`${base}?localeFixture=1&uiLanguage=en&localStartup=1&holdStartupSync=1`, { waitUntil: 'networkidle' });
  await page.setViewportSize({ width: 900, height: 650 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await pending('startup-sync', true); await title('Local snapshot shown while checking');
  await page.evaluate(() => window.__uiTest.emitSync({ phase: 'checking', completed: 0, unit: 'objects' }));
  assert.equal(await retained.count(), 0);
  assert.match(await page.locator('.library-sync-notice').textContent(), /Updating the problem library…/);
  await noOverflow('English retained-content state at 900px in dark mode');
  await shot('retained-english-dark-900');
  await page.evaluate(() => { window.__uiTest.syncRules = []; while (window.__uiTest.syncRequests.some(request => request.tag === 'startup-sync' && request.pending)) window.__uiTest.releaseSync('startup-sync'); });
  await title('远端题目标题：原文保持');
  await syncRule({ source: 'getDay', error: 'Fixture offline in English' });
  await page.locator('.today-heading').getByRole('button', { name: 'Refresh', exact: true }).click();
  await retained.filter({ hasText: 'Fixture offline in English' }).waitFor();
  assert.doesNotMatch(await retained.first().textContent(), /[\u3400-\u9fff]/);
  assert.match(await retained.first().textContent(), /Problem library update incomplete\. Showing previously loaded content\./);
  assert.equal(await cards.count(), 17); await noOverflow('English offline retained-content warning');
  await page.getByRole('navigation').getByRole('button', { name: 'Problem archive', exact: true }).click();
  await archiveReady(35);
  await shot('all-library-complete-english-dark-900');
  const englishMonthReads = await page.evaluate(() => window.__uiTest.snapshotMonthRequests.length);
  await syncRule({ source: 'getArchiveSnapshot', defer: true, tag: 'english-full-check' });
  await page.locator('.page-heading').getByRole('button', { name: 'Refresh', exact: true }).click(); await pending('english-full-check', true);
  assert.equal(await page.locator('.index-panel, .library-refresh-progress').count(), 0);
  assert.match(await page.locator('.library-sync-notice').textContent(), /Updating the problem library…/);
  await noOverflow('English unchanged full-library check at 900px'); await shot('all-library-checking-english-dark-900');
  await release('english-full-check', true); await archiveReady(35);
  assert.equal(await page.evaluate(() => window.__uiTest.snapshotMonthRequests.length), englishMonthReads);
  report.checks.push('English update/failure wording and the unchanged full-archive check remain readable at 900px in dark mode, with one global checking message, zero month reads, and no horizontal overflow.');
  assert.deepEqual(report.rendererErrors, []);
  report.passed = true;
} catch (error) {
  report.error = String(error);
  if (page && !page.isClosed()) {
    report.body = await page.locator('body').innerText().catch(() => '');
    report.requests = await page.evaluate(() => ({ library: window.__uiTest?.libraryRequests.slice(-35), sync: window.__uiTest?.syncRequests.slice(-15), local: window.__uiTest?.localViewRequests.slice(-15) })).catch(() => ({}));
    await page.screenshot({ path: 'test-results/retained-library-ui-failure-0.3.8.png', animations: 'disabled' }).catch(() => {});
  }
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync('test-results/retained-library-ui-0.3.8.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, screenshots: report.screenshots.length, error: report.error }));
  await browser?.close(); await server?.close();
}
