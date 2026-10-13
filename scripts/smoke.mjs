import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import electron from 'electron';
if (existsSync('.env')) process.loadEnvFile('.env');
const expectedVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!existsSync('dist/index.html') || !existsSync('dist-electron/preload.cjs')) throw new Error('Run npm run build first.');
await import('./build-electron.mjs');
const env = { ...process.env, DAILY_CF_SMOKE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const temporaryRoot = resolve(tmpdir());
const profile = mkdtempSync(join(temporaryRoot, 'daily-cf-smoke-'));
const child = spawn(electron, ['.', `--user-data-dir=${profile}`], { env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
let output = '';
child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
const deadline = setTimeout(() => { child.kill(); console.error('Desktop bootstrap timed out'); process.exitCode = 1; }, 45000);
child.on('exit', code => {
  clearTimeout(deadline);
  if (dirname(resolve(profile)) === temporaryRoot && resolve(profile).startsWith(join(temporaryRoot, 'daily-cf-smoke-'))) {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Preserve a locked temporary profile for inspection. */ }
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/desktop-smoke.log', output);
  try {
    const result = output.split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).find(value => value?.bridge === 'connected');
    const expectedRepository = process.env.DAILY_CF_REPOSITORY || 'Yawn-Sean/Daily_CF_Problems';
    if (code !== 0 || !result?.nodeIntegrationOff || result.draftsAvailable !== false
      || !result.remoteContributionsAvailable || !result.batchSubmissionAvailable || !result.noPullRequestMutationAPI || !result.noHandleSubmissionAPI || !result.noDefaultAuthor || result.repository !== expectedRepository
      || result.version !== expectedVersion) throw new Error('Desktop did not report a successful app bootstrap.');
    writeFileSync('test-results/desktop-smoke.json', JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
});
