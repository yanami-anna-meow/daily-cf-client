// Read-only official Git transport verification. Never loads application credentials.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { GitRepository } from '../electron/git-repository';
import { GitProblemLibrary } from '../electron/git-library';

const directory = resolve(`.cache/git-library-smoke-${Date.now()}`);
assert(!existsSync(directory));
const requests: { method: string; path: string; bytes: number; status?: number }[] = [];
const nativeFetch = globalThis.fetch;
const trackedFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://github.com');
  assert(url.pathname.startsWith('/Yawn-Sean/Daily_CF_Problems.git/'));
  assert.equal(new Headers(init?.headers).has('authorization'), false);
  assert.equal(new Headers(init?.headers).has('cookie'), false);
  const entry = { method: init?.method ?? 'GET', path: url.pathname, bytes: 0, status: undefined as number | undefined };
  requests.push(entry);
  const response = await nativeFetch(input, init);
  entry.status = response.status;
  if (!response.body) return response;
  const reader = response.body.getReader();
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else { entry.bytes += next.value.byteLength; controller.enqueue(next.value); }
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
};
let lastPhase = '';
const repository = new GitRepository(directory, {
  repository: 'Yawn-Sean/Daily_CF_Problems', fetch: trackedFetch,
  onProgress: value => {
    if (value.phase !== lastPhase) { lastPhase = value.phase; console.log(`Git sync: ${value.phase}`); }
  },
});
const library = new GitProblemLibrary(repository);
const report: Record<string, unknown> = { version: '0.3.0', repository: 'Yawn-Sean/Daily_CF_Problems', directory, readOnly: true, credentialsUsed: false, restApiRequests: 0 };
async function run() {
try {
  let start = performance.now();
  const first = await library.getArchiveSnapshot();
  const firstCount = requests.length;
  const firstBytes = requests.reduce((sum, request) => sum + request.bytes, 0);
  report.initialSync = { ...first, milliseconds: Math.round(performance.now() - start), requests: firstCount, bytes: firstBytes };
  console.log(`Initial sync: ${first.months.length} months, ${firstBytes} bytes`);

  start = performance.now();
  const second = await library.getArchiveSnapshot();
  const secondRequests = requests.slice(firstCount);
  const secondBytes = secondRequests.reduce((sum, request) => sum + request.bytes, 0);
  report.nextSync = { revision: second.revision, milliseconds: Math.round(performance.now() - start), requests: secondRequests.length, bytes: secondBytes, unchanged: second.revision === first.revision };
  if (second.revision === first.revision) assert(secondBytes < firstBytes, 'Unchanged update should transfer less than a fresh clone');
  console.log(`Next sync: ${secondBytes} bytes`);

  start = performance.now();
  const beforeLocalRead = requests.length;
  let days = 0; let problems = 0;
  for (const month of second.months) {
    const entries = await library.getMonthFromSnapshot(month.month, second);
    days += entries.length;
    problems += entries.reduce((sum, day) => sum + day.problems.length, 0);
  }
  assert.equal(requests.length, beforeLocalRead, 'Full index must read local pinned Git objects only');
  report.fullIndex = { months: second.months.length, days, problems, milliseconds: Math.round(performance.now() - start), networkRequests: 0 };
  const latest = await library.getDay();
  assert(latest.problems.length > 0);
  const resources = await library.getResources(latest.date, latest.problems[0].id);
  const reference = resources.references[0];
  const code = reference ? await library.getReference(reference.path) : '';
  report.sample = { date: latest.date, problem: latest.problems[0].id, editorialAvailable: resources.editorial !== null, references: resources.references.length, referenceRead: reference?.path, referenceCharacters: code.length };
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.requests = requests;
  report.finishedAt = new Date().toISOString();
  mkdirSync(resolve('test-results'), { recursive: true });
  writeFileSync(resolve('test-results/git-library-live-0.3.0.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
}
void run();
