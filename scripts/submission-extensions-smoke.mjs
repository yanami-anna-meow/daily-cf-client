// Actual renderer integration with a fixture API; no native files or GitHub writes.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installClientFixture } from './ui-fixture.mjs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const checks = [], screenshots = [], rendererErrors = [];
let server, browser, page, locale = 'zh-CN';
const label = (zh, en) => locale === 'en' ? en : zh;
const authorName = 'extension_tester';
const source = '#include <stdio.h>\nint main(void) { puts("fixture"); return 0; }\n';
try {
  mkdirSync('test-results', { recursive: true });
  server = await createServer({ server: { host: '127.0.0.1', port: 45173, strictPort: true }, logLevel: 'error' }); await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 2 }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => rendererErrors.push(error.message)); await installClientFixture(page); await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => { const f = window.__uiTest; f.latestDay.problems = f.latestDay.problems.slice(0, 2); f.contributionRows = []; f.contributionIncomplete = false; f.contributionFilesTruncated = false; });
  const editor = () => page.locator('.queue-editor');
  const extension = () => editor().getByRole('textbox', { name: locale === 'en' ? /^Extension for / : /^扩展名 / });
  const author = () => editor().getByRole('textbox', { name: locale === 'en' ? /^Author for / : /^署名 / });
  const language = () => editor().getByRole('combobox').first();
  const add = () => editor().getByRole('button', { name: locale === 'en' ? /^(Add to list|Save to list)$/ : /^(加入列表|保存到列表)$/ });
  const queue = () => page.locator('.batch-composer');
  const filename = suffix => `cf1234a_${authorName}.${suffix}`;
  const queuePaths = () => page.locator('.queue-item .queue-file-path').allTextContents();
  const expectedPath = (suffix, problemId = 'cf1234a') => `daily_problems/2024/03/0305/personal_submission/${problemId}_${authorName}.${suffix}`;
  async function importFile(name, code = source, explicitExtension) {
    await page.evaluate(file => { window.__uiTest.nextFile = file; }, { name, code, ...(explicitExtension === undefined ? {} : { extension: explicitExtension }) });
    await editor().getByRole('button', { name: locale === 'en' ? /^(Choose code file|Choose another file)$/ : /^(选择代码文件|重新选择文件)$/ }).click();
    await editor().locator('.uploaded-file strong').filter({ hasText: name }).waitFor();
  }
  async function confirmFilename(suffix) { assert.equal(await extension().inputValue(), suffix); assert.equal(await editor().locator('.submission-filename code').textContent(), filename(suffix)); }
  async function commit() { await add().click(); await page.waitForFunction(() => !document.querySelector('.queue-editor') || document.querySelector('.queue-add-confirmation')); }
  async function addFromQueue(problem = 'CF1234A') { await queue().getByRole('button', { name: label(`添加 ${problem}`, `Add ${problem}`), exact: true }).click(); await editor().waitFor(); }
  async function capture(name, target) {
    const overflow = await page.evaluate(() => [...document.querySelectorAll('html,.modal,.modal-body,.composer-fields,.queue-editor,.queue-item,.composer-footer,.submission-preview,.overwrite-confirmation')].filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map(el => el.className || el.tagName));
    assert.deepEqual(overflow, [], `${name} has no horizontal overflow`);
    const path = `test-results/submission-extensions-${name}-${version}-fixture.png`; await target.screenshot({ path, animations: 'disabled' }); screenshots.push(path); console.log(`Screenshot: ${path}`);
  }

  for (const [languageCode, width] of [['zh-CN', 1440], ['en', 900]]) {
    locale = languageCode; await page.setViewportSize({ width, height: 1050 });
    await page.goto(`http://127.0.0.1:45173/?localeFixture=1&uiLanguage=${languageCode}&persistSettings=extension-${languageCode}&validateSettings=1`, { waitUntil: 'networkidle' });
    await page.evaluate(async () => { const { settings } = await window.dailyCF.bootstrap(); await window.dailyCF.saveSettings({ ...settings, forkRepository: 'ui-tester/extensions-fork' }); });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.problem-card').first().getByRole('button', { name: label('加入提交列表', 'Add to submission list'), exact: true }).click();
    await language().selectOption('c'); assert.equal(await extension().inputValue(), 'c'); await author().fill(authorName);
    await importFile('solution.c'); await confirmFilename('c'); assert.equal(await language().inputValue(), 'c');
    assert(await editor().locator('.code-highlight code span').count() > 0, 'C receives syntax highlighting');
    await capture(`${languageCode}-c-editor-${width}`, page.getByRole('dialog'));
    for (const [suffix, preset] of [['cc','cpp'], ['cxx','cpp'], ['C','cpp'], ['customsolver','other'], ['d.ts','other']]) {
      await importFile(`solution.${suffix}`, suffix === 'customsolver' ? 'literal <img src=x> & no markup\n' : source); await confirmFilename(suffix); assert.equal(await language().inputValue(), preset);
      if (suffix === 'customsolver') { assert.equal(await editor().locator('.code-highlight code span').count(), 0); assert.equal(await editor().locator('.code-highlight code').textContent(), 'literal <img src=x> & no markup\n'); assert.equal(await editor().locator('.code-highlight img').count(), 0); await capture(`${languageCode}-custom-editor-${width}`, page.getByRole('dialog')); }
    }
    await importFile('contract-name.txt', source, 'C'); await confirmFilename('C'); assert.equal(await language().inputValue(), 'cpp');
    for (const suffix of ['zig', 'c++', 'd.ts']) { await extension().fill(suffix); await confirmFilename(suffix); assert.equal(await add().isEnabled(), true); }
    const inspectionsBefore = await page.evaluate(() => window.__uiTest.inspectRequests.length);
    for (const invalid of ['', '../cpp']) {
      await extension().fill(invalid); assert.equal(await extension().getAttribute('aria-invalid'), 'true'); assert.equal(await author().getAttribute('aria-invalid'), 'false'); assert.equal(await add().isDisabled(), true);
      const errorId = await extension().getAttribute('aria-describedby'); assert(errorId); assert((await page.locator(`[id="${errorId}"]`).textContent()).length > 0);
      assert.equal(await page.evaluate(() => window.__uiTest.inspectRequests.length), inspectionsBefore);
    }
    checks.push(`${locale}: C defaults to .c; imports retain .c/.cc/.cxx/.C/unknown/compound suffixes and explicit import extensions. C is highlighted, unknown source is literal plaintext. Custom zig/c++/d.ts names preview live; blank and traversal extensions mark only the extension field and cannot be added.`);

    await importFile('solution.c'); await confirmFilename('c'); await commit(); await editor().waitFor({ state: 'detached' });
    await page.locator('.topbar-actions').getByRole('button', { name: locale === 'en' ? /^Submission list/ : /^提交列表/ }).click(); await queue().waitFor();
    await addFromQueue(); await importFile('solution.cc'); await author().fill(authorName); await commit(); await queue().waitFor();
    assert.deepEqual(await queuePaths(), [expectedPath('c'), expectedPath('cc')]);
    await addFromQueue(); await language().selectOption('java'); assert.equal(await extension().inputValue(), 'java');
    await importFile('replacement.cpp', '// replacement for .cc\n' + source); await extension().fill('cc'); await author().fill(authorName); await commit();
    await page.getByText(label('提交列表中已有同路径文件', 'This path is already in your submission list'), { exact: true }).waitFor();
    assert.equal(await page.locator('.queue-add-confirmation .path-preview').textContent(), expectedPath('cc'));
    await page.getByRole('button', { name: label('替换列表中的文件', 'Replace file in list'), exact: true }).click(); await queue().waitFor();
    assert.deepEqual(await queuePaths(), [expectedPath('c'), expectedPath('cc')]);
    checks.push(`${locale}: Same problem and author with different actual suffixes coexist. An entry begun with a different language shortcut but targeting the existing .cc path triggers replacement, leaving exactly two paths after confirmation.`);

    const editCc = () => queue().getByRole('button', { name: label(`编辑 ${filename('cc')}`, `Edit ${filename('cc')}`), exact: true });
    await editCc().click(); await confirmFilename('cc'); await extension().fill('cxx');
    await editor().getByRole('button', { name: label('返回列表', 'Back to list'), exact: true }).click();
    const discard = () => page.getByRole('dialog', { name: label('放弃本次编辑？', 'Discard your edits?'), exact: true });
    await discard().getByRole('button', { name: label('继续编辑', 'Keep editing'), exact: true }).click(); await confirmFilename('cxx');
    await editor().getByRole('button', { name: label('返回列表', 'Back to list'), exact: true }).click(); await discard().getByRole('button', { name: label('放弃修改', 'Discard changes'), exact: true }).click();
    await queue().waitFor(); assert.deepEqual(await queuePaths(), [expectedPath('c'), expectedPath('cc')]);
    await editCc().click(); await confirmFilename('cc'); await editor().getByRole('button', { name: label('返回列表', 'Back to list'), exact: true }).click(); await queue().waitFor();
    checks.push(`${locale}: Editing retains .cc; changing just the extension is dirty. Continue editing retains the draft suffix, while Discard restores the original actual path and next edit still shows .cc.`);

    await addFromQueue('CF100001B'); await importFile('declaration.d.ts', 'declare const answer: number;\n'); await author().fill(authorName); await commit();
    await page.getByText(label('仓库中已有这个文件', 'This file already exists in the repository'), { exact: true }).waitFor();
    assert.equal(await page.locator('.queue-add-confirmation .path-preview').textContent(), expectedPath('d.ts', 'cf100001b'));
    await page.getByRole('button', { name: label('仍然加入列表', 'Add to list anyway'), exact: true }).click(); await queue().waitFor();
    await queue().getByRole('button', { name: label('预览 PR', 'Preview PR'), exact: true }).click(); await page.locator('.submission-preview').waitFor();
    const request = await page.evaluate(() => window.__uiTest.previewRequests.at(-1));
    assert.deepEqual(request.items.map(item => item.extension), ['c', 'cc', 'd.ts']); assert.deepEqual(request.items.map(item => item.language), ['c', 'cpp', 'other']);
    assert.deepEqual(await page.locator('.batch-preview-file > .path-preview').allTextContents(), [expectedPath('c'), expectedPath('cc'), expectedPath('d.ts', 'cf100001b')]);
    const overwrite = page.locator('.overwrite-confirmation'); assert.equal(await overwrite.count(), 1);
    assert((await overwrite.getAttribute('aria-label')).endsWith(expectedPath('d.ts', 'cf100001b')));
    const submit = queue().getByRole('button', { name: label('提交 PR', 'Submit PR'), exact: true }); assert.equal(await submit.isDisabled(), true);
    await overwrite.getByRole('checkbox').check(); assert.equal(await submit.isEnabled(), true);
    await capture(`${locale}-preview-${width}`, page.locator('.submission-preview')); assert.equal(await page.evaluate(() => window.__uiTest.submitCalls), 0);
    checks.push(`${locale}: Preview payloads, file paths and overwrite confirmation retain .c/.cc/.d.ts, independent of shortcut IDs. The actual .d.ts overwrite requires confirmation; submission is never invoked.`);
  }
  assert.deepEqual(rendererErrors, []);
  const report = { passed: true, fixture: true, version, boundary: 'Actual renderer/domain validation; fixture supplies file contents and remote existence. No native file picker or GitHub writes; backend Git behavior is covered separately.', checks, screenshots, rendererErrors };
  writeFileSync(`test-results/submission-extensions-${version}.json`, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: `test-results/submission-extensions-failure-${version}.png`, animations: 'disabled' }).catch(() => {});
  const report = { passed: false, fixture: true, version, checks, screenshots, rendererErrors, error: String(error) };
  writeFileSync(`test-results/submission-extensions-${version}-failure.json`, `${JSON.stringify(report, null, 2)}\n`); console.error(JSON.stringify(report)); throw error;
} finally { await browser?.close(); await server?.close(); }
