// Related PR list integration checks: actual components, one page, no external writes.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installClientFixture } from './ui-fixture.mjs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const checks = [], screenshots = [], rendererErrors = [];
let server, browser, page, locale = 'zh-CN';
const label = (zh, en) => locale === 'en' ? en : zh;
const expectedNumbers = [306, 305, 999, 310];
const expectedDates = [['2023-12-12'], ['2024-03-05', '2024-03-04', '2024-02-01'], ['2024-04-07'], ['2024-03-05']];
try {
  mkdirSync('test-results', { recursive: true });
  server = await createServer({ server: { host: '127.0.0.1', port: 45173, strictPort: true }, logLevel: 'error' }); await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => rendererErrors.push(error.message)); await installClientFixture(page); await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    const fixture = window.__uiTest;
    const solution = (date, author = 'alice', language = 'cpp', problemId = 'cf1234a') => ({ date, problemId, language, path: `daily_problems/${date.slice(0,4)}/${date.slice(5,7)}/${date.slice(5,7)}${date.slice(8)}/personal_submission/${problemId}_${author}.${language}` });
    const record = (number, state, createdAt, problems) => ({ id: `related-${number}`, number, state, title: `Fixture PR ${number}`, url: `https://github.com/Yawn-Sean/Daily_CF_Problems/pull/${number}`, createdAt, updatedAt: createdAt, filesTruncated: false, problems });
    const merged = record(305, 'merged', '2026-10-13T08:00:00.000Z', [solution('2024-02-01'), solution('2024-03-05'), solution('2024-03-04'), solution('2024-03-05', 'bob'), solution('2024-03-05', 'alice', 'py'), solution('2027-12-31', 'alice', 'cpp', 'cf1234b')]);
    fixture.contributionRows = [record(310, 'open', '2026-10-01T08:00:00.000Z', [solution('2024-03-05')]), merged, record(306, 'closed', '2026-10-13T08:00:00.000Z', [solution('2023-12-12')]), record(999, 'open', '2026-10-12T08:00:00.000Z', [solution('2024-04-07')]), structuredClone(merged), record(400, 'open', '2026-10-10T08:00:00.000Z', [solution('2024-03-05', 'alice', 'cpp', 'cf100001b')]), record(401, 'closed', '2026-10-10T08:00:00.000Z', [solution('2024-03-05', 'alice', 'cpp', 'cf1731a')])];
    const ids = ['cf1234a', 'cf100001b', 'cf1731a', 'cf9000a'];
    const labels = ['Mixed-date PR example', 'Open-only PR example', 'Closed-only PR example', 'No PR example'];
    fixture.latestDay.problems = ids.map((id, index) => ({ ...fixture.latestDay.problems.find(problem => problem.id === id), label: labels[index], sourceWarning: undefined }));
    fixture.contributionIncomplete = false; fixture.contributionFilesTruncated = false;
  });
  const card = () => page.locator('.problem-card').filter({ has: page.getByRole('heading', { name: 'Mixed-date PR example', exact: true }) });
  async function verifyList(container, context) {
    const list = container.getByRole('list', { name: label('关联 PR', 'Related PRs'), exact: true }); await list.waitFor();
    await page.waitForFunction(element => element.querySelectorAll('li').length === 4, await list.elementHandle());
    assert.equal(await container.locator('ul.problem-contribution-list').count(), 1, `${context} has one list`);
    assert.equal(await container.locator('.problem-contribution-label, .problem-contribution-group').count(), 0, `${context} has no date-category heading or group`);
    const rows = await list.locator('li').evaluateAll(rows => rows.map(row => ({ number: Number(row.textContent.match(/#(\d+)/)?.[1]), dates: [...row.querySelectorAll('time')].map(time => time.dateTime) })));
    assert.deepEqual(rows.map(row => row.number), expectedNumbers, `${context} sorts by creation timestamp then PR number`);
    assert.deepEqual(rows.map(row => row.dates), expectedDates, `${context} aggregates matching dates without duplicates or unrelated problem dates`);
    assert.equal(await container.locator('.problem-contribution-total').textContent(), label('共 4 个关联 PR', 'Related PRs: 4'));
    assert.deepEqual(await container.locator('.problem-contribution-summary-states .pr-status').allTextContents(), locale === 'en' ? ['Merged PRs: 1', 'Open PRs: 2', 'Closed PRs: 1'] : ['已合并 1 个 PR', '等待合并 2 个 PR', '已关闭 1 个 PR']);
    const references = await list.locator('.problem-contribution-reference').evaluateAll(elements => elements.map(element => {
      const bounds = element.getBoundingClientRect(), children = [...element.children].map(child => child.getBoundingClientRect());
      return { count: children.length, height: bounds.height, tallestChild: Math.max(...children.map(child => child.height)), centers: children.map(child => child.top + child.height / 2) };
    }));
    assert.equal(references.length, 4);
    for (const reference of references) { assert.equal(reference.count, 3); assert(reference.height <= reference.tallestChild + 1 && Math.max(...reference.centers) - Math.min(...reference.centers) <= 1, `${context} keeps PR number, state and arrow on one unbroken line`); }
  }
  async function capture(name, target) {
    const overflow = await page.evaluate(() => [...document.querySelectorAll('html,.problem-card,.detail-contribution-panel,.modal,.modal-body,.queue-editor,.queue-item,.problem-contribution-status,.problem-contribution-list,.problem-contribution-link')].filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map(el => el.className || el.tagName));
    assert.deepEqual(overflow, [], `${name} has no horizontal overflow`);
    const path = `test-results/related-pr-${name}-${version}-fixture.png`; await target.screenshot({ path, animations: 'disabled' }); screenshots.push(path); console.log(`Screenshot: ${path}`);
  }
  for (const [language, width] of [['zh-CN', 1440], ['en', 900]]) {
    locale = language; await page.setViewportSize({ width, height: 1050 });
    await page.goto(`http://127.0.0.1:45173/?localeFixture=1&uiLanguage=${language}`, { waitUntil: 'networkidle' });
    await verifyList(card().locator('.problem-contribution-status'), `${language} card`);
    assert.deepEqual(await page.locator('.problem-card').evaluateAll(cards => cards.map(card => card.dataset.contributionState)), ['merged', 'open', 'closed', 'none']);
    const backgrounds = await page.locator('.problem-card').evaluateAll(cards => cards.map(card => getComputedStyle(card).backgroundColor));
    assert.equal(backgrounds[0], 'rgb(250, 247, 253)'); assert.equal(backgrounds[1], 'rgb(242, 248, 243)'); assert.equal(backgrounds[2], backgrounds[3]);
    await capture(`${language}-card-${width}`, card());
    await card().locator('.problem-contribution-link').first().click(); assert.equal(await page.evaluate(() => window.__uiTest.openedUrls.at(-1)), 'https://github.com/Yawn-Sean/Daily_CF_Problems/pull/306');
    checks.push(`${language}: Cards show one chronological PR list; one PR with three dates, multiple authors/languages and duplicate snapshots appears once. Matching dates descend; unrelated file dates are absent. Counts, semantic backgrounds and PR links remain correct.`);

    await card().getByRole('button', { name: label('查看题目', 'View problem'), exact: true }).click();
    const detail = page.locator('.detail-contribution-panel'); await verifyList(detail, `${language} detail`); await capture(`${language}-detail-${width}`, detail);
    await page.getByRole('button', { name: label('加入提交列表', 'Add to submission list'), exact: true }).click();
    const editor = page.locator('.queue-editor'); await verifyList(editor, `${language} editor warning`); await capture(`${language}-editor-warning-${width}`, editor.locator('.problem-contribution-status'));
    await editor.getByRole('button', { name: label('选择代码文件', 'Choose code file'), exact: true }).click();
    await editor.getByRole('textbox', { name: locale === 'en' ? /^Author for / : /^署名 / }).fill('related_pr_fixture');
    await editor.getByRole('button', { name: label('加入列表', 'Add to list'), exact: true }).click(); await editor.waitFor({ state: 'detached' });
    await page.locator('.topbar-actions').getByRole('button', { name: locale === 'en' ? /^Submission list/ : /^提交列表/ }).click();
    const queueItem = page.locator('.queue-item'); await verifyList(queueItem, `${language} queue item`); await capture(`${language}-queue-item-${width}`, queueItem);
    assert.equal(await page.evaluate(() => window.__uiTest.submitCalls), 0);
    checks.push(`${language}: Detail, add-to-list editor warning and queued file reuse the same one-row-per-PR order/dates/counts; PR number, state and arrow remain together when dates wrap. File import and queue addition remain available, with no PR submitted.`);
  }
  assert.deepEqual(rendererErrors, []);
  const report = { passed: true, fixture: true, version, checks, screenshots, rendererErrors };
  writeFileSync(`test-results/related-pr-list-${version}.json`, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: `test-results/related-pr-list-failure-${version}.png`, animations: 'disabled' }).catch(() => {});
  const report = { passed: false, fixture: true, version, checks, screenshots, rendererErrors, error: String(error) };
  writeFileSync(`test-results/related-pr-list-${version}-failure.json`, `${JSON.stringify(report, null, 2)}\n`); console.error(JSON.stringify(report)); throw error;
} finally { await browser?.close(); await server?.close(); }
