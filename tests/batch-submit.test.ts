import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BatchSubmissionEngine, type BatchAdapter, type BatchRepository } from '../electron/batch-submit';
import { submissionPath, validateSubmission } from '../shared/domain';
import { renderBatchPRTemplates } from '../shared/templates';
import { UPSTREAM, type BatchSubmissionInput, type ForkSyncStatus, type Problem, type SubmissionInput } from '../shared/types';

const upstreamName = `${UPSTREAM.owner}/${UPSTREAM.repo}`;
const upstreamPath = `/repos/${upstreamName}`;
const forkPath = '/repos/alice/renamed-practice-fork';
const baseSha = 'immutable-upstream-commit';
const first: SubmissionInput = {
  date: '2026-10-07', problemId: 'cf106744g', language: 'cpp', author: 'alice', code: 'int main() { return 0; }', notes: '',
};
const second: SubmissionInput = {
  date: '2026-10-06', problemId: 'cf103627a', language: 'py', author: 'alice', code: 'print(42)', notes: 'Python solution',
};
const batch = (items: SubmissionInput[] = [first, second]): BatchSubmissionInput => ({ items, notes: '', requestId: 'batch-intent-00000001' });
const problem = (id: string): Problem => ({ id, label: id.toUpperCase(), url: `https://codeforces.com/contest/${id.slice(2, -1)}/problem/${id.at(-1)!.toUpperCase()}`, rating: 1400, hint: '' });
const sha = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex');
const blobSha = (code: string) => createHash('sha1').update(`blob ${Buffer.byteLength(code)}\0`).update(code).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
class MockError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}
interface GitCommit { sha: string; tree: { sha: string }; parents: { sha: string }[]; message: string }
interface Request { path: string; method: string; query: URLSearchParams; body: any }
type LostResponse = 'blob' | 'tree' | 'commit' | 'ref' | 'pull';
interface Options { forkExists?: boolean; login?: string; invalidDay?: string; upstreamFiles?: Record<string, string>; lose?: LostResponse; }

/** A small Git DAG, not canned endpoint responses: files are derived from immutable
 * trees, comparisons are actual file differences and refs enforce fast-forward. */
function server(options: Options = {}) {
  const upstream: BatchRepository = { name: UPSTREAM.repo, full_name: upstreamName, default_branch: 'main', fork: false, owner: { login: UPSTREAM.owner } };
  const fork: BatchRepository = { name: 'renamed-practice-fork', full_name: 'alice/renamed-practice-fork', default_branch: 'main', fork: true, owner: { login: 'alice' }, parent: { full_name: upstreamName } };
  const requests: Request[] = [];
  const events: string[] = [];
  const blobs = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, GitCommit>();
  const refs = new Map<string, string>([['main', 'stale-fork-commit']]);
  const pulls = new Map<number, any>();
  const branchPullNoise: any[] = [];
  const pullFilesOverride = new Map<number, { filename: string; status: string }[]>();
  const days = new Map<string, Problem[]>([[first.date, [problem(first.problemId)]], [second.date, [problem(second.problemId)]]]);
  let forkExists = options.forkExists ?? true;
  let lost = false;
  let lostStage = options.lose;
  let raceAfterPublishedInspection = false;
  let failOnBlob = 0;
  let blobCalls = 0;
  let currentUpstream = baseSha;
  let templates: { title?: string; body?: string } | undefined;
  const storeTree = (files: Map<string, string>) => {
    const hash = sha([...files].sort(([left], [right]) => left.localeCompare(right)));
    trees.set(hash, new Map(files));
    return hash;
  };
  const originalFiles = new Map(Object.entries({ 'README.md': 'Upstream documentation\n', ...options.upstreamFiles }));
  commits.set(baseSha, { sha: baseSha, tree: { sha: storeTree(originalFiles) }, parents: [], message: 'Upstream latest' });
  commits.set('stale-fork-commit', { sha: 'stale-fork-commit', tree: { sha: storeTree(new Map([['README.md', 'Old fork documentation\n']])) }, parents: [], message: 'Old fork main' });
  const filesAt = (ref: string) => trees.get(commits.get(refs.get(ref) ?? ref)!.tree.sha)!;
  const changes = (from: string, to: string) => {
    const before = filesAt(from);
    const after = filesAt(to);
    return [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).map(filename => ({
      filename, status: !before.has(filename) ? 'added' : !after.has(filename) ? 'removed' : 'modified',
    }));
  };
  const updateRef = (branch: string, commit: string) => {
    refs.set(branch, commit);
    for (const pull of pulls.values()) if (pull.head.ref === branch) pull.head.sha = commit;
  };
  const lose = (stage: LostResponse) => {
    if (lostStage === stage && !lost) { lost = true; throw new MockError('Response lost after server accepted the request'); }
  };
  const manualCommit = (branch: string, path = submissionPath(first), code = 'Concurrent author edit\n') => {
    const parent = refs.get(branch)!;
    const files = new Map(filesAt(parent));
    files.set(path, code);
    const tree = storeTree(files);
    const hash = sha({ tree, parent, code });
    commits.set(hash, { sha: hash, tree: { sha: tree }, parents: [{ sha: parent }], message: 'Manual user edit' });
    updateRef(branch, hash);
    return hash;
  };
  async function dispatch(raw: string, method = 'GET', body?: any): Promise<any> {
    const url = new URL(raw, 'https://api.github.com');
    const path = decodeURIComponent(url.pathname);
    events.push(`${method} ${path}`);
    requests.push({ path, method, query: url.searchParams, body: clone(body) });
    if (method !== 'GET' && method !== 'POST') throw new Error(`New submissions must never mutate existing PRs or refs: ${method} ${path}`);
    if (path === `${upstreamPath}/git/ref/heads/main`) return { object: { sha: currentUpstream } };
    if (path === '/search/issues') {
      const marker = /in:body "([a-f0-9]+)"/.exec(url.searchParams.get('q') ?? '')?.[1];
      const matches = [...pulls.values()].filter(pull => pull.state === 'closed' && (!marker || pull.body?.includes(marker)));
      return { total_count: matches.length, incomplete_results: false, items: matches.map(pull => ({ number: pull.number, body: pull.body })) };
    }
    for (const repositoryPath of [upstreamPath, forkPath]) {
      if (path.startsWith(`${repositoryPath}/contents/`)) {
        const file = path.slice(`${repositoryPath}/contents/`.length);
        const ref = url.searchParams.get('ref')!;
        const code = filesAt(ref).get(file);
        if (code === undefined) throw new MockError('Not found', 404);
        return { type: 'file', encoding: 'base64', content: Buffer.from(code).toString('base64'), sha: blobSha(code), size: Buffer.byteLength(code) };
      }
    }
    if (path.startsWith(`${forkPath}/git/ref/heads/`)) {
      const branch = path.slice(`${forkPath}/git/ref/heads/`.length);
      if (!refs.has(branch)) throw new MockError('Not found', 404);
      return { object: { sha: refs.get(branch) } };
    }
    if (path.startsWith(`${forkPath}/git/commits/`)) {
      const commit = commits.get(path.slice(`${forkPath}/git/commits/`.length));
      if (!commit) throw new MockError('Not found', 404);
      return commit;
    }
    if (path === `${forkPath}/git/blobs` && method === 'POST') {
      if (++blobCalls === failOnBlob) throw new MockError('Forbidden blob creation', 403);
      const code = body.encoding === 'base64' ? Buffer.from(body.content, 'base64').toString('utf8') : body.content;
      const hash = blobSha(code);
      blobs.set(hash, code);
      lose('blob');
      return { sha: hash };
    }
    if (path === `${forkPath}/git/trees` && method === 'POST') {
      const files = new Map(trees.get(body.base_tree)!);
      for (const entry of body.tree) {
        expect(entry).toMatchObject({ mode: '100644', type: 'blob' });
        expect(blobs.has(entry.sha)).toBe(true);
        files.set(entry.path, blobs.get(entry.sha)!);
      }
      const hash = storeTree(files);
      lose('tree');
      return { sha: hash };
    }
    if (path === `${forkPath}/git/commits` && method === 'POST') {
      expect(trees.has(body.tree)).toBe(true);
      expect(body.parents.every((parent: string) => commits.has(parent))).toBe(true);
      const hash = sha(body);
      const commit = { sha: hash, tree: { sha: body.tree }, parents: body.parents.map((parent: string) => ({ sha: parent })), message: body.message };
      commits.set(hash, commit);
      lose('commit');
      return commit;
    }
    if (path.startsWith(`${forkPath}/compare/`)) {
      const [from, to] = path.slice(`${forkPath}/compare/`.length).split('...');
      const comparison = { files: changes(from, to), ahead_by: from === to ? 0 : 1 };
      const publishedBranch = [...refs].find(([branch, commit]) => branch !== 'main' && commit === to)?.[0];
      if (raceAfterPublishedInspection && publishedBranch) {
        raceAfterPublishedInspection = false;
        manualCommit(publishedBranch);
      }
      return comparison;
    }
    if (path === `${forkPath}/git/refs` && method === 'POST') {
      const branch = body.ref.replace(/^refs\/heads\//, '');
      if (refs.has(branch)) throw new MockError('Reference already exists', 422);
      updateRef(branch, body.sha);
      lose('ref');
      return { object: { sha: body.sha } };
    }
    if (path === `${upstreamPath}/pulls` && method === 'GET') {
      const matching = [...pulls.values()].filter(pull => {
        const head = url.searchParams.get('head');
        const state = url.searchParams.get('state');
        return (!head || head === `${pull.head.user?.login ?? pull.user?.login}:${pull.head.ref}`) && (!state || state === 'all' || pull.state === state);
      });
      const page = Number(url.searchParams.get('page') ?? 1);
      return [...matching.slice((page - 1) * 100, page * 100), ...(url.searchParams.has('head') ? branchPullNoise : [])];
    }
    if (path === `${upstreamPath}/pulls` && method === 'POST') {
      const branch = body.head.slice(body.head.indexOf(':') + 1);
      if ([...pulls.values()].some(pull => pull.head.ref === branch && pull.state === 'open')) throw new MockError('PR already exists', 422);
      const number = 100 + pulls.size;
      const pull = {
        number, title: body.title, body: body.body, state: 'open', merged_at: null, user: { login: 'alice' },
        created_at: '2026-10-07T01:00:00Z', updated_at: '2026-10-07T01:00:00Z',
        head: { ref: branch, sha: refs.get(branch), user: { login: 'alice' }, repo: clone(fork) }, base: { ref: body.base, repo: clone(upstream), sha: currentUpstream },
      };
      pulls.set(number, pull);
      lose('pull');
      return pull;
    }
    if (path.startsWith(`${upstreamPath}/pulls/`)) {
      const tail = path.slice(`${upstreamPath}/pulls/`.length);
      const pull = pulls.get(Number(tail.split('/')[0]));
      if (!pull) throw new MockError('Not found', 404);
      if (tail.endsWith('/files')) return (pullFilesOverride.get(pull.number) ?? changes(pull.base.sha ?? baseSha, pull.head.sha)).slice(0, 100);
      return pull;
    }
    throw new Error(`Unhandled mock request: ${method} ${raw}`);
  }
  const request: BatchAdapter['request'] = async <T>(path: string, method?: string, body?: unknown): Promise<T> => clone(await dispatch(path, method, body)) as T;
  const syncStatus = (upstreamSha: string): ForkSyncStatus => ({
    state: refs.get('main') === upstreamSha ? 'synced' : 'behind', repository: fork.full_name, branch: 'main',
    upstreamSha, forkSha: refs.get('main')!, aheadBy: 0, behindBy: refs.get('main') === upstreamSha ? 0 : 1,
  });
  const adapter: BatchAdapter = {
    request,
    optional: async <T>(path: string): Promise<T | null> => {
      try { return await request<T>(path); } catch (error) { if (error instanceof MockError && error.status === 404) return null; throw error; }
    },
    getUser: vi.fn(async () => ({ login: options.login ?? 'alice', name: 'Alice', avatarUrl: 'https://example.com/alice.png' })),
    getUpstream: vi.fn(async () => clone(upstream)),
    dayAt: vi.fn(async (date: string) => ({ date, problems: options.invalidDay === date ? [] : clone(days.get(date) ?? []), sourceUrl: `${UPSTREAM.url}/blob/main/problems.md`, fetchedAt: '2026-10-07T01:00:00Z' })),
    resolveExistingFork: vi.fn(async () => forkExists ? clone(fork) : null),
    ensureFork: vi.fn(async () => { forkExists = true; return clone(fork); }),
    inspectForkSync: vi.fn(async (_fork: BatchRepository, _upstream: BatchRepository, upstreamSha: string) => {
      events.push('inspectForkSync');
      return syncStatus(upstreamSha);
    }),
    syncFork: vi.fn(async (_fork: BatchRepository, _upstream: BatchRepository, upstreamSha: string) => {
      events.push('syncFork');
      if (upstreamSha !== currentUpstream) throw new MockError('Upstream changed before fork synchronization');
      updateRef('main', upstreamSha);
      return syncStatus(upstreamSha);
    }),
    assertForkCurrent: vi.fn(async (_fork: BatchRepository, _upstream: BatchRepository, upstreamSha: string) => {
      events.push('assertForkCurrent');
      if (upstreamSha !== currentUpstream) throw new MockError('Upstream changed before publishing');
      return syncStatus(upstreamSha);
    }),
    renderBatch: (input, login, problems) => renderBatchPRTemplates(input, { login, problems }, templates),
    error: (message, status) => new MockError(message, status),
  };
  return {
    engine: new BatchSubmissionEngine(adapter), adapter, requests, events, refs, commits, pulls, filesAt, changes, manualCommit, days, fork, pullFilesOverride, branchPullNoise,
    writes: () => requests.filter(request => request.method !== 'GET'),
    count: (suffix: string, method = 'POST') => requests.filter(request => request.path.endsWith(suffix) && request.method === method).length,
    setTemplates: (next: typeof templates) => { templates = next; },
    raceBeforePR: () => { raceAfterPublishedInspection = true; },
    failBlob: (number: number) => { failOnBlob = number; },
    advanceUpstreamTo: (commit: string) => { currentUpstream = commit; },
    changeUpstreamFile: (path: string, code: string) => {
      const files = new Map(filesAt(currentUpstream));
      files.set(path, code);
      const tree = storeTree(files);
      const commit = sha({ parent: currentUpstream, tree });
      commits.set(commit, { sha: commit, tree: { sha: tree }, parents: [{ sha: currentUpstream }], message: 'Upstream changed after preview' });
      currentUpstream = commit;
    },
  };
}

describe('atomic batch submission', () => {
  it('keeps repository dates in 2128 in the preview, new PR and code paths while the commit clock is in 2026', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
      const date = '2128-02-29';
      const items = [{ ...first, date }, { ...second, date }];
      const source: BatchSubmissionInput = { items, notes: '', target: { kind: 'new' }, requestId: 'future-date-batch-request' };
      const mock = server();
      mock.days.set(date, items.map(item => problem(item.problemId)));
      const expectedPaths = [
        'daily_problems/2128/02/0229/personal_submission/cf106744g_alice.cpp',
        'daily_problems/2128/02/0229/personal_submission/cf103627a_alice.py',
      ].sort();
      const preview = await mock.engine.preview(source);
      expect(preview.items.map(item => item.path).sort()).toEqual(expectedPaths);
      expect(preview.items.every(item => item.date === date)).toBe(true);
      expect(preview.branch).toMatch(/^daily-cf\/batch\/2128-02-29-/);
      expect(preview.title).toMatch(/^21280229 /);
      expect(mock.writes()).toEqual([]);
      const result = await mock.engine.submit(source, 'alice');
      const pull = mock.pulls.get(result.record.number)!;
      expect(result.record.problems.map(item => item.path).sort()).toEqual(expectedPaths);
      expect(result.record.problems.every(item => item.date === date)).toBe(true);
      expect(pull.head.ref).toBe(preview.branch);
      expect(pull.title).toMatch(/^21280229 /);
      expect(mock.changes(baseSha, pull.head.sha).map(file => file.filename).sort()).toEqual(expectedPaths);
      expect(mock.adapter.dayAt).toHaveBeenCalledWith(date, baseSha);
      expect(mock.count('/pulls')).toBe(1);
      expect(mock.requests.find(request => request.path === `${forkPath}/git/commits` && request.method === 'POST')?.body.author.date).toBe('2026-10-07T12:00:00.000Z');
    } finally { vi.useRealTimers(); }
  });

  it('normalizes, sorts and previews every real problem without creating a fork or writing', async () => {
    const mock = server({ forkExists: false });
    const source = batch([{ ...first, problemId: 'GYM106744G', author: ' alice ', code: '\uFEFFa\r\nb' }, second]);
    const preview = await mock.engine.preview(source);
    expect(preview.items.map(item => item.path)).toEqual([submissionPath(second), submissionPath(first)]);
    expect(preview.items.map(item => item.bytes)).toEqual([Buffer.byteLength(validateSubmission(second).code), 4]);
    expect(preview.bytes).toBe(preview.items.reduce((sum, item) => sum + item.bytes, 0));
    expect(preview.body).toContain('CF106744G');
    expect(preview.body).toContain('CF103627A');
    expect(preview.forkRepository).toBeUndefined();
    expect(mock.adapter.dayAt).toHaveBeenCalledWith(first.date, baseSha);
    expect(mock.adapter.dayAt).toHaveBeenCalledWith(second.date, baseSha);
    expect(mock.adapter.getUpstream).toHaveBeenCalledWith(true);
    expect(mock.adapter.ensureFork).not.toHaveBeenCalled();
    expect(mock.writes()).toEqual([]);
  });

  it('gives normalized equivalent payloads the same branch regardless of selection order', async () => {
    const mock = server();
    const original = await mock.engine.preview(batch());
    const reordered = await mock.engine.preview(batch([{ ...second, code: `${second.code}\r\n` }, { ...first, problemId: ' GYM106744G ', code: `\uFEFF${first.code}\n` }]));
    expect(reordered.branch).toBe(original.branch);
    expect((await mock.engine.preview(batch([{ ...first, code: 'changed' }, second]))).branch).not.toBe(original.branch);
  });

  it('publishes C, C++ aliases and free extensions together without renaming any suffix', async () => {
    const mock = server();
    const extensions = ['c', 'cpp', 'cc', 'cxx', 'C', 'c++', 'd.ts', 'private.cpp', 'private.part'];
    const items = extensions.map(extension => ({ ...first, language: 'py' as const, extension, code: `// ${extension}\n` }));
    const source = batch(items);
    const expectedPaths = extensions.map(extension => `daily_problems/2026/10/1007/personal_submission/cf106744g_alice.${extension}`);
    const preview = await mock.engine.preview(source);
    expect(preview.items.map(item => item.path).sort()).toEqual([...expectedPaths].sort());
    for (const [index, extension] of extensions.entries()) {
      expect(preview.items.find(item => item.path === expectedPaths[index])).toMatchObject({
        extension, author: 'alice', language: extension === 'c' ? 'c' : ['d.ts', 'private.part'].includes(extension) ? 'other' : 'cpp',
        existing: false,
      });
    }
    expect(mock.writes()).toEqual([]);
    const result = await mock.engine.submit(source, 'alice');
    const head = mock.pulls.get(result.record.number)!.head.sha;
    expect(mock.changes(baseSha, head).map(file => file.filename).sort()).toEqual([...expectedPaths].sort());
    for (const [index, extension] of extensions.entries()) expect(mock.filesAt(head).get(expectedPaths[index])).toBe(`// ${extension}\n`);
    expect(mock.filesAt(head).get('README.md')).toBe('Upstream documentation\n');
    const tree = mock.writes().find(request => request.path.endsWith('/git/trees'))!.body.tree;
    expect(tree.map((entry: { path: string }) => entry.path).sort()).toEqual([...expectedPaths].sort());
    expect(mock.count('/git/commits')).toBe(1);
    expect(mock.count('/pulls')).toBe(1);
  });

  it('normalizes request identity from actual extensions instead of a stale language selection', async () => {
    const mock = server();
    const cpp = await mock.engine.preview(batch([first]));
    const explicitCpp = await mock.engine.preview(batch([{ ...first, language: 'py', extension: '.cpp' }]));
    expect(explicitCpp.branch).toBe(cpp.branch);
    const free = await mock.engine.preview(batch([{ ...first, language: 'cpp', extension: 'private.part' }]));
    const otherLabel = await mock.engine.preview(batch([{ ...first, language: 'py', extension: '.private.part' }]));
    expect(otherLabel.branch).toBe(free.branch);
    expect(free.branch).not.toBe(cpp.branch);
    expect((await mock.engine.preview(batch([{ ...first, extension: 'c' }]))).branch).not.toBe(cpp.branch);
  });

  it('rejects identical actual file paths with different language labels before remote access', async () => {
    const mock = server();
    const source = batch([{ ...first, language: 'cpp', extension: '.custom+part' }, { ...first, language: 'py', extension: 'custom+part' }]);
    await expect(mock.engine.preview(source)).rejects.toThrow('重复');
    await expect(mock.engine.submit(source, 'alice')).rejects.toThrow('重复');
    expect(mock.adapter.getUser).not.toHaveBeenCalled();
    expect(mock.requests).toEqual([]);
  });

  it.each(['c', 'cc', 'private+name.part'])('checks overwrite consent against the actual .%s path while leaving .cpp untouched', async extension => {
    const path = `daily_problems/2026/10/1007/personal_submission/cf106744g_alice.${extension}`;
    const cppPath = 'daily_problems/2026/10/1007/personal_submission/cf106744g_alice.cpp';
    const oldCode = 'Existing actual-extension file\n';
    const cppCode = 'Existing separate C++ file\n';
    const mock = server({ upstreamFiles: { [path]: oldCode, [cppPath]: cppCode } });
    const source = batch([{ ...first, language: 'cpp', extension, code: 'Replacement code\n' }]);
    const preview = await mock.engine.preview(source);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({ path, extension, existing: true, previous: { code: oldCode, sha: blobSha(oldCode) } });
    await expect(mock.engine.submit(source, 'alice')).rejects.toThrow(/覆盖.*确认|确认.*覆盖/);
    await expect(mock.engine.submit({ ...source, overwrites: [{ path: cppPath, sha: blobSha(cppCode) }] }, 'alice')).rejects.toThrow('规范文件路径');
    expect(mock.writes()).toEqual([]);
    const result = await mock.engine.submit({ ...source, overwrites: [{ path, sha: blobSha(oldCode) }] }, 'alice');
    const head = mock.pulls.get(result.record.number)!.head.sha;
    expect(mock.filesAt(head).get(path)).toBe('Replacement code\n');
    expect(mock.filesAt(head).get(cppPath)).toBe(cppCode);
    expect(mock.changes(baseSha, head)).toEqual([{ filename: path, status: 'modified' }]);
    expect(mock.filesAt(baseSha).get(path)).toBe(oldCode);
  });

  it.each([0, 51])('rejects %i files before any remote write', async count => {
    const mock = server({ forkExists: false });
    const input = batch(Array.from({ length: count }, (_, index) => ({ ...first, author: `alice${index}` })));
    await expect(mock.engine.submit(input, 'alice')).rejects.toThrow(/1.*50/);
    expect(mock.writes()).toEqual([]);
    expect(mock.adapter.ensureFork).not.toHaveBeenCalled();
  });

  it('accepts exactly 50 distinct files and resolves a shared day once', async () => {
    const mock = server();
    const input = batch(Array.from({ length: 50 }, (_, index) => ({ ...first, author: `alice${index}` })));
    const preview = await mock.engine.preview(input);
    expect(preview.items).toHaveLength(50);
    expect(mock.adapter.dayAt).toHaveBeenCalledTimes(1);
    expect(new Set(preview.items.map(item => item.path)).size).toBe(50);
  });

  it('rejects normalized duplicate paths even when their code differs', async () => {
    const mock = server();
    await expect(mock.engine.submit(batch([first, { ...first, problemId: 'GYM106744G', author: ' alice ', code: 'different' }]), 'alice')).rejects.toThrow(/重复/);
    expect(mock.writes()).toEqual([]);
    expect(mock.adapter.ensureFork).not.toHaveBeenCalled();
  });

  it('enforces the normalized 256 KiB per-file bound, including UTF-8 and the final newline', async () => {
    const mock = server();
    const atLimit = { ...first, code: 'x'.repeat(256 * 1024 - 1) };
    expect((await mock.engine.preview(batch([atLimit, second]))).items.find(item => item.problemId === first.problemId)?.bytes).toBe(256 * 1024);
    await expect(mock.engine.submit(batch([{ ...first, code: 'x'.repeat(256 * 1024) }, second]), 'alice')).rejects.toThrow('256 KiB');
    await expect(mock.engine.submit(batch([{ ...first, code: '中'.repeat(90_000) }, second]), 'alice')).rejects.toThrow('256 KiB');
    expect(mock.writes()).toEqual([]);
  });

  it('accepts exactly 5 MiB and rejects a larger aggregate before creating a fork', async () => {
    const mock = server({ forkExists: false });
    const items = Array.from({ length: 20 }, (_, index) => ({ ...first, author: `alice${index}`, code: 'x'.repeat(256 * 1024 - 1) }));
    expect((await mock.engine.preview(batch(items))).bytes).toBe(5 * 1024 * 1024);
    await expect(mock.engine.submit(batch([...items, { ...first, author: 'extra' }]), 'alice')).rejects.toThrow('5 MiB');
    expect(mock.writes()).toEqual([]);
    expect(mock.adapter.ensureFork).not.toHaveBeenCalled();
  });

  it.each([first.date, second.date])('rejects a problem absent from the immutable %s day before any write', async date => {
    const mock = server({ invalidDay: date });
    await expect(mock.engine.submit(batch(), 'alice')).rejects.toThrow(/题单不包含/);
    expect(mock.writes()).toEqual([]);
    expect(mock.adapter.ensureFork).not.toHaveBeenCalled();
  });

  it('rejects an account change before creating Git objects', async () => {
    const mock = server({ login: 'bob' });
    await expect(mock.engine.submit(batch(), 'alice')).rejects.toThrow(/账号已发生变化/);
    expect(mock.writes()).toEqual([]);
  });

  it('publishes one complete tree, one commit and one PR from the immutable upstream base', async () => {
    const mock = server();
    const result = await mock.engine.submit(batch(), 'alice');
    const pull = mock.pulls.get(result.record.number)!;
    const commit = mock.commits.get(pull.head.sha)!;
    expect(result.reused).toBe(false);
    expect(result.record.problems.map(item => item.path).sort()).toEqual([submissionPath(first), submissionPath(second)].sort());
    expect(mock.count('/git/trees')).toBe(1);
    expect(mock.count('/git/commits')).toBe(1);
    expect(mock.count('/pulls')).toBe(1);
    expect(commit.parents).toEqual([{ sha: baseSha }]);
    expect(mock.changes(baseSha, commit.sha).map(file => file.filename).sort()).toEqual([submissionPath(first), submissionPath(second)].sort());
    expect(mock.filesAt(commit.sha).get(submissionPath(first))).toBe(validateSubmission(first).code);
    expect(mock.filesAt(commit.sha).get(submissionPath(second))).toBe(validateSubmission(second).code);
    expect(mock.filesAt(commit.sha).get('README.md')).toBe('Upstream documentation\n');
    expect(mock.refs.get('main')).toBe(baseSha);
    expect(mock.requests.filter(request => request.path.includes('/contents/')).every(request => request.query.get('ref') && request.query.get('ref') !== 'main')).toBe(true);
    expect(mock.writes().every(request => !request.path.endsWith('/heads/main') && request.body?.ref !== 'refs/heads/main')).toBe(true);
    const refPosition = mock.requests.findIndex(request => request.path.endsWith('/git/refs') && request.method === 'POST');
    const commitPosition = mock.requests.findIndex(request => request.path.endsWith('/git/commits') && request.method === 'POST');
    expect(refPosition).toBeGreaterThan(commitPosition);
  });

  it('never publishes a partial branch when the second blob fails', async () => {
    const mock = server();
    mock.failBlob(2);
    await expect(mock.engine.submit(batch(), 'alice')).rejects.toThrow('Forbidden blob creation');
    expect([...mock.refs.keys()]).toEqual(['main']);
    expect(mock.pulls.size).toBe(0);
    expect(mock.count('/git/trees')).toBe(0);
    expect(mock.count('/git/commits')).toBe(0);
  });

  it.each(['blob', 'tree', 'commit', 'ref', 'pull'] as const)('recovers an accepted %s request with a lost response without another published commit or PR', async lose => {
    const mock = server({ lose });
    const result = await mock.engine.submit(batch(), 'alice');
    expect(result.record.problems).toHaveLength(2);
    expect(mock.pulls.size).toBe(1);
    expect(mock.commits.size).toBe(3); // Upstream, untouched old fork main, one batch commit.
    expect([...mock.refs.keys()].filter(branch => branch !== 'main')).toHaveLength(1);
    const writes = mock.writes().length;
    const retry = await mock.engine.submit(batch(), 'alice');
    expect(retry.reused).toBe(true);
    expect(retry.record.number).toBe(result.record.number);
    expect(mock.writes()).toHaveLength(writes);
  });

  it('does not create a PR when another author advances the published ref during inspection', async () => {
    const mock = server();
    mock.raceBeforePR();
    await expect(mock.engine.submit(batch(), 'alice')).rejects.toThrow(/变化/);
    expect(mock.count('/pulls')).toBe(0);
    expect(mock.pulls.size).toBe(0);
    const branch = [...mock.refs.keys()].find(branch => branch !== 'main')!;
    expect(mock.filesAt(mock.refs.get(branch)!).get(submissionPath(first))).toBe('Concurrent author edit\n');
    expect(mock.requests.some(request => request.method === 'PATCH' && request.body?.force === true)).toBe(false);
  });

  it('preserves an unfinished old-base branch and requests a new preview before creating a PR after upstream advances', async () => {
    const mock = server();
    const request = mock.adapter.request;
    mock.adapter.request = async <T>(path: string, method?: string, body?: unknown): Promise<T> => {
      if (path === `${upstreamPath}/pulls` && method === 'POST') throw new MockError('PR request was not accepted', 503);
      return request<T>(path, method, body);
    };
    const input = batch();
    await expect(mock.engine.submit(input, 'alice')).rejects.toThrow('PR request was not accepted');
    expect(mock.pulls.size).toBe(0);
    const branch = [...mock.refs.keys()].find(value => value !== 'main')!;
    const originalSha = mock.refs.get(branch)!;
    expect(mock.commits.get(originalSha)?.parents).toEqual([{ sha: baseSha }]);
    mock.changeUpstreamFile('new-document.md', 'New upstream documentation\n');
    mock.adapter.request = request;
    vi.mocked(mock.adapter.syncFork).mockClear();
    const writes = mock.writes().length;
    await expect(mock.engine.submit(input, 'alice')).rejects.toMatchObject({ code: 'submission_base_changed' });
    expect(mock.refs.get(branch)).toBe(originalSha);
    expect(mock.pulls.size).toBe(0);
    expect(mock.writes()).toHaveLength(writes);
    expect(mock.adapter.syncFork).not.toHaveBeenCalled();
    const replacement = await mock.engine.submit({ ...input, requestId: 'new-preview-after-upstream' }, 'alice');
    const pull = mock.pulls.get(replacement.record.number)!;
    expect(pull.head.ref).not.toBe(branch);
    expect(mock.filesAt(pull.head.sha).get('new-document.md')).toBe('New upstream documentation\n');
    expect(mock.commits.get(pull.head.sha)?.parents[0].sha).not.toBe(baseSha);
    expect(mock.refs.get(branch)).toBe(originalSha);
  });

  it.each([false, true])('creates a new PR for changed content after the old PR closes (merged=%s)', async merged => {
    const mock = server();
    const initial = await mock.engine.submit(batch(), 'alice');
    const oldPull = mock.pulls.get(initial.record.number)!;
    const saved = clone(oldPull);
    oldPull.state = 'closed';
    oldPull.merged_at = merged ? '2026-10-08T00:00:00Z' : null;
    const result = await mock.engine.submit(batch([{ ...first, code: 'new revision' }, second]), 'alice');
    expect(result.record.number).not.toBe(initial.record.number);
    expect(result.reused).toBe(false);
    expect(oldPull.head).toEqual(saved.head);
    expect(oldPull.body).toBe(saved.body);
    expect(mock.count('/pulls')).toBe(2);
  });

  it('finds an identical merged PR after upstream advances to include its code', async () => {
    const mock = server();
    const initial = await mock.engine.submit(batch(), 'alice');
    const pull = mock.pulls.get(initial.record.number)!;
    pull.state = 'closed';
    pull.merged_at = '2026-10-08T00:00:00Z';
    mock.advanceUpstreamTo(pull.head.sha);
    const writes = mock.writes().length;
    const retry = await mock.engine.submit(batch(), 'alice');
    expect(retry).toMatchObject({ reused: true, record: { number: initial.record.number, state: 'merged' } });
    expect(mock.writes()).toHaveLength(writes);
  });

  it('does not adopt or edit a manual PR with the same files', async () => {
    const mock = server();
    const initial = await mock.engine.submit(batch(), 'alice');
    const manual = mock.pulls.get(initial.record.number)!;
    manual.body = 'Submitted manually from the GitHub website';
    const previous = clone(manual);
    const result = await mock.engine.submit(batch([{ ...first, code: 'a new independent contribution' }, second]), 'alice');
    expect(result.record.number).not.toBe(manual.number);
    expect(mock.pulls.get(manual.number)).toEqual(previous);
    expect(mock.count(`/pulls/${manual.number}`, 'PATCH')).toBe(0);
  });

  it('creates an independent PR after notes change and preserves the old PR description, branch and unrelated files', async () => {
    const mock = server();
    const initial = await mock.engine.submit(batch(), 'alice');
    const original = mock.pulls.get(initial.record.number)!;
    mock.manualCommit(original.head.ref, 'README.md', 'Documentation edited outside the client\n');
    original.body = 'Keep the original human-written explanation.';
    const saved = clone(original);
    const result = await mock.engine.submit({ ...batch(), notes: 'A new independent explanation' }, 'alice');
    const created = mock.pulls.get(result.record.number)!;
    expect(result.reused).toBe(false);
    expect(created.number).not.toBe(original.number);
    expect(created.head.ref).not.toBe(original.head.ref);
    expect(mock.commits.get(created.head.sha)?.parents).toEqual([{ sha: baseSha }]);
    expect(created.body).toContain('A new independent explanation');
    expect(mock.pulls.get(original.number)).toEqual(saved);
    expect(mock.refs.get(original.head.ref)).toBe(saved.head.sha);
    expect(mock.filesAt(original.head.sha).get('README.md')).toBe('Documentation edited outside the client\n');
    expect(mock.filesAt(created.head.sha).get('README.md')).toBe('Upstream documentation\n');
    expect(mock.writes().every(request => request.method === 'POST')).toBe(true);
  });

  it('includes only changed files when another listed file already matches upstream', async () => {
    const unchangedPath = submissionPath(first);
    const mock = server({ upstreamFiles: { [unchangedPath]: validateSubmission(first).code } });
    const input = batch();
    const preview = await mock.engine.preview(input);
    expect(preview.items.find(item => item.path === unchangedPath)).toMatchObject({ existing: true, unchanged: true });
    expect(preview.items.find(item => item.path === submissionPath(second))).toMatchObject({ existing: false, unchanged: false });
    expect(preview.body).not.toContain(unchangedPath);
    expect(preview.body).toContain(submissionPath(second));
    const result = await mock.engine.submit(input, 'alice');
    const pull = mock.pulls.get(result.record.number)!;
    expect(pull.body).not.toContain(unchangedPath);
    expect(pull.body).toContain(submissionPath(second));
    expect(mock.changes(baseSha, pull.head.sha)).toEqual([{ filename: submissionPath(second), status: 'added' }]);
    expect(result.record.problems).toEqual([{ date: second.date, problemId: second.problemId, language: second.language, path: submissionPath(second) }]);
    expect(mock.filesAt(pull.head.sha).get(unchangedPath)).toBe(validateSubmission(first).code);
    expect(mock.count('/git/blobs')).toBe(1);
    const writes = mock.writes().length;
    const retried = await new BatchSubmissionEngine(mock.adapter).submit(input, 'alice');
    expect(retried).toMatchObject({ reused: true, record: { number: result.record.number } });
    expect(retried.record.problems).toEqual(result.record.problems);
    expect(mock.writes()).toHaveLength(writes);
  });

  it('rejects an entirely unchanged batch before any fork synchronization or remote write', async () => {
    const mock = server({ forkExists: false, upstreamFiles: Object.fromEntries([first, second].map(item => [submissionPath(item), validateSubmission(item).code])) });
    const preview = await mock.engine.preview(batch());
    expect(preview.items.every(item => item.unchanged)).toBe(true);
    await expect(mock.engine.submit(batch(), 'alice')).rejects.toThrow(/相同|没有.*变更|无.*变更/);
    expect(mock.writes()).toEqual([]);
    expect(mock.adapter.ensureFork).not.toHaveBeenCalled();
    expect(mock.adapter.syncFork).not.toHaveBeenCalled();
    expect(mock.pulls.size).toBe(0);
  });

  it('recovers a merged mixed batch from its original diff after upstream includes every submitted file', async () => {
    const mock = server({ upstreamFiles: { [submissionPath(first)]: validateSubmission(first).code } });
    const input = batch();
    const result = await mock.engine.submit(input, 'alice');
    const pull = mock.pulls.get(result.record.number)!;
    pull.state = 'closed';
    pull.merged_at = '2026-10-08T00:00:00Z';
    mock.advanceUpstreamTo(pull.head.sha);
    const saved = clone(pull);
    const writes = mock.writes().length;
    const retried = await new BatchSubmissionEngine(mock.adapter).submit(input, 'alice');
    expect(retried).toMatchObject({ reused: true, record: { number: result.record.number, state: 'merged' } });
    expect(retried.record.problems).toEqual(result.record.problems);
    expect(retried.record.problems.map(item => item.path)).toEqual([submissionPath(second)]);
    expect(mock.pulls.get(result.record.number)).toEqual(saved);
    expect(mock.writes()).toHaveLength(writes);
  });

  it('ignores unrelated deleted-source PRs during an exact request retry', async () => {
    const mock = server();
    const initial = await mock.engine.submit(batch(), 'alice');
    const deleted = clone(mock.pulls.get(initial.record.number)!);
    deleted.number = 999;
    deleted.head.ref = 'daily-cf/batch/2026-10-01-0123456789abcdef';
    deleted.head.repo = null;
    deleted.head.user = null;
    deleted.body = `Old deleted source\n<!-- daily-cf-client:${deleted.head.ref} -->`;
    mock.pulls.set(deleted.number, deleted);
    const writes = mock.writes().length;
    const retried = await mock.engine.submit(batch(), 'alice');
    expect(retried).toMatchObject({ reused: true, record: { number: initial.record.number } });
    expect(mock.writes()).toHaveLength(writes);
    expect(mock.count(`/pulls/${deleted.number}/files`, 'GET')).toBe(0);
  });

  it('reports successful fork synchronization separately from a later blob error and preserves its status', async () => {
    const mock = server();
    expect((await mock.engine.preview(batch())).forkSync?.state).toBe('behind');
    mock.failBlob(1);
    const error = await mock.engine.submit(batch(), 'alice').catch(error => error);
    expect(error).toBeInstanceOf(MockError);
    expect(error.status).toBe(403);
    expect(error.message).toBe('个人 Fork 默认分支已同步至上游；后续提交步骤未完成确认。Forbidden blob creation');
    expect(mock.refs.get('main')).toBe(baseSha);
    expect(mock.adapter.syncFork).toHaveBeenCalledTimes(1);
    expect(mock.pulls.size).toBe(0);
  });
});

describe('explicit new pull request target', () => {
  const fresh = (items: SubmissionInput[] = [first, second], requestId = '18c1c0de-ea12-4938-9b4b-9d7c3799147f'): BatchSubmissionInput => ({
    items, notes: '', target: { kind: 'new' }, requestId,
  });

  it('allows a single file when the user explicitly chooses a new PR', async () => {
    const mock = server();
    const result = await mock.engine.submit(fresh([first]), 'alice');
    expect(result.record.problems).toEqual([{ date: first.date, problemId: first.problemId, language: first.language, path: submissionPath(first) }]);
    expect(mock.count('/git/commits')).toBe(1);
    expect(mock.count('/pulls')).toBe(1);
  });

  it('creates a new PR for one file without requiring a target selector', async () => {
    const mock = server();
    const input = batch([first]);
    expect(input.target).toBeUndefined();
    const result = await mock.engine.submit(input, 'alice');
    expect(result.record.problems.map(item => item.path)).toEqual([submissionPath(first)]);
    expect(result.reused).toBe(false);
    expect(mock.count('/pulls')).toBe(1);
  });

  it.each(['batch', 'single'] as const)('allows explicit new submission overlapping an existing %s client PR without touching it', async kind => {
    const mock = server();
    const initial = await mock.engine.submit(batch(), 'alice');
    const old = mock.pulls.get(initial.record.number)!;
    if (kind === 'single') {
      old.head.ref = 'daily-cf/2026-10-07/cf106744g-cpp-1234567890abcdef';
      old.body = `Single solution\n<!-- daily-cf-client:${old.head.ref} -->`;
      mock.pullFilesOverride.set(old.number, [{ filename: submissionPath(first), status: 'added' }]);
    }
    const saved = clone(old);
    const requestBoundary = mock.requests.length;
    const result = await mock.engine.submit(fresh(), 'alice');
    expect(result.reused).toBe(false);
    expect(result.record.number).not.toBe(initial.record.number);
    expect(mock.pulls.get(initial.record.number)).toEqual(saved);
    expect(mock.count(`/pulls/${initial.record.number}`, 'PATCH')).toBe(0);
    const newReads = mock.requests.slice(requestBoundary).filter(request => request.method === 'GET');
    expect(newReads.some(request => request.path === '/search/issues')).toBe(false);
    expect(newReads.some(request => request.path === `${upstreamPath}/pulls` && request.query.get('state') === 'open')).toBe(false);
  });

  it('assigns different branches and PRs to separate deliberate requests with identical code', async () => {
    const mock = server();
    const one = fresh(undefined, 'intent-one-000001');
    const two = fresh(undefined, 'intent-two-000002');
    const firstPreview = await mock.engine.preview(one);
    const secondPreview = await mock.engine.preview(two);
    expect(firstPreview.branch).not.toBe(secondPreview.branch);
    const created = await mock.engine.submit(one, 'alice');
    const repeated = await mock.engine.submit(two, 'alice');
    expect(repeated.reused).toBe(false);
    expect(repeated.record.number).not.toBe(created.record.number);
    expect(mock.pulls.size).toBe(2);
  });

  it('retries the same request and normalized payload without writing or updating metadata', async () => {
    const mock = server();
    const input = fresh();
    const initial = await mock.engine.submit(input, 'alice');
    const saved = clone(mock.pulls.get(initial.record.number)!);
    const writes = mock.writes().length;
    mock.setTemplates({ title: '{{date_compact}} {{file_count}} new template title', body: 'New template body: {{file_list}}' });
    const retry = await new BatchSubmissionEngine(mock.adapter).submit({
      ...input, items: [{ ...second, code: `${second.code}\r\n` }, { ...first, code: `\uFEFF${first.code}\n` }],
    }, 'alice');
    expect(retry).toMatchObject({ reused: true, record: { number: initial.record.number } });
    expect(mock.pulls.get(initial.record.number)).toEqual(saved);
    expect(mock.writes()).toHaveLength(writes);
    expect(mock.count(`/pulls/${initial.record.number}`, 'PATCH')).toBe(0);
  });

  it.each(['intent-one-000001', 'intent-two-000002'])('creates a separate PR for changed code using requestId=%s', async requestId => {
    const mock = server();
    const initial = await mock.engine.submit(fresh(undefined, 'intent-one-000001'), 'alice');
    const saved = clone(mock.pulls.get(initial.record.number)!);
    const result = await mock.engine.submit(fresh([{ ...first, code: 'a deliberate new solution' }, second], requestId), 'alice');
    expect(result.reused).toBe(false);
    expect(result.record.number).not.toBe(initial.record.number);
    expect(mock.pulls.get(initial.record.number)).toEqual(saved);
    expect(mock.count('/pulls')).toBe(2);
    expect(mock.count(`/pulls/${initial.record.number}`, 'PATCH')).toBe(0);
  });

  it('does not adopt external changes on the branch during an identical request retry', async () => {
    const mock = server();
    const input = fresh();
    const initial = await mock.engine.submit(input, 'alice');
    const pull = mock.pulls.get(initial.record.number)!;
    const remoteSha = mock.manualCommit(pull.head.ref);
    const writes = mock.writes().length;
    await expect(mock.engine.submit(input, 'alice')).rejects.toThrow(/其他地方修改|内容标记不匹配/);
    expect(pull.head.sha).toBe(remoteSha);
    expect(mock.filesAt(remoteSha).get(submissionPath(first))).toBe('Concurrent author edit\n');
    expect(mock.writes()).toHaveLength(writes);
  });

  it.each(['a'.repeat(16), 'a'.repeat(80)])('accepts valid ASCII request identifiers at the length boundaries', async requestId => {
    const mock = server();
    expect((await mock.engine.preview(fresh([first], requestId))).items).toHaveLength(1);
    expect(mock.writes()).toEqual([]);
  });

  it.each([undefined, '', 'a'.repeat(15), 'contains a space', 'contains/a/slash', 'identifier-long\n', '汉字'.repeat(8), 'a'.repeat(81)])('rejects invalid explicit-new request identifier %j before writing', async requestId => {
    const mock = server({ forkExists: false });
    const input = { ...fresh(), requestId } as unknown as BatchSubmissionInput;
    await expect(mock.engine.submit(input, 'alice')).rejects.toThrow();
    expect(mock.writes()).toEqual([]);
    expect(mock.adapter.ensureFork).not.toHaveBeenCalled();
  });

  it('rejects an existing-PR target at the new-batch engine boundary', async () => {
    const mock = server();
    const input = { ...batch(), target: { kind: 'existing', number: 123 }, requestId: 'intent-one-000001' } as unknown as BatchSubmissionInput;
    await expect(mock.engine.submit(input, 'alice')).rejects.toThrow();
    expect(mock.writes()).toEqual([]);
    expect(mock.adapter.ensureFork).not.toHaveBeenCalled();
  });

  it.each(['旧版本\r\nDo not normalize the existing file\r\n', '\uFEFFExisting UTF-8 BOM\r\nKeep both BOM and CRLF\r\n'])('previews the exact existing code, blob SHA and byte count before an overwrite', async code => {
    const path = submissionPath(first);
    const mock = server({ upstreamFiles: { [path]: code } });
    const preview = await mock.engine.preview(fresh());
    const item = preview.items.find(item => item.path === path)!;
    expect(item).toMatchObject({ existing: true, unchanged: false, previous: { code, sha: blobSha(code), bytes: Buffer.byteLength(code), truncated: false } });
    expect(preview.items.find(item => item.path === submissionPath(second))?.previous).toBeUndefined();
    expect(mock.writes()).toEqual([]);
  });

  it('rejects invalid historical UTF-8 instead of displaying replacement characters for overwrite approval', async () => {
    const path = submissionPath(first);
    const mock = server({ upstreamFiles: { [path]: 'A placeholder readable file\n' } });
    const invalid = Buffer.from([0x66, 0x80, 0x6f, 0x6f, 0x0a]);
    const originalOptional = mock.adapter.optional;
    mock.adapter.optional = async <T>(raw: string): Promise<T | null> => {
      const result = await originalOptional<T>(raw);
      const url = new URL(raw, 'https://api.github.com');
      if (decodeURIComponent(url.pathname) !== `${upstreamPath}/contents/${path}`) return result;
      return {
        type: 'file', encoding: 'base64', content: invalid.toString('base64'), size: invalid.length,
        sha: createHash('sha1').update(`blob ${invalid.length}\0`).update(invalid).digest('hex'),
      } as T;
    };
    await expect(mock.engine.preview(fresh())).rejects.toThrow(/UTF-8/);
    expect(mock.writes()).toEqual([]);
    expect(mock.adapter.ensureFork).not.toHaveBeenCalled();
  });

  it('marks an existing file unchanged only when its complete content matches the normalized submission', async () => {
    const path = submissionPath(first);
    const code = validateSubmission(first).code;
    const mock = server({ upstreamFiles: { [path]: code } });
    const preview = await mock.engine.preview(fresh());
    expect(preview.items.find(item => item.path === path)).toMatchObject({ existing: true, unchanged: true, previous: { sha: blobSha(code), code } });
    expect(mock.writes()).toEqual([]);
  });

  it.each([
    'a'.repeat(256 * 1024 + 20),
    `${'a'.repeat(256 * 1024 - 2)}中.cut-off-at-a-multibyte-boundary`,
  ])('bounds previous-content previews to 256 KiB while retaining full byte count and SHA', async code => {
    const path = submissionPath(first);
    const mock = server({ upstreamFiles: { [path]: code } });
    const item = (await mock.engine.preview(fresh())).items.find(item => item.path === path)!;
    expect(item.previous).toMatchObject({ sha: blobSha(code), bytes: Buffer.byteLength(code), truncated: true });
    expect(Buffer.byteLength(item.previous!.code)).toBeLessThanOrEqual(256 * 1024);
    expect(code.startsWith(item.previous!.code)).toBe(true);
    expect(item.previous!.code).not.toContain('\uFFFD');
    expect(item.unchanged).toBe(false);
    expect(mock.writes()).toEqual([]);
  });

  it('does not mistake a matching truncated preview for an unchanged complete file', async () => {
    const inputCode = `${'a'.repeat(256 * 1024 - 1)}\n`;
    const code = `${inputCode}Additional bytes outside the preview\n`;
    const path = submissionPath(first);
    const mock = server({ upstreamFiles: { [path]: code } });
    const item = (await mock.engine.preview(fresh([{ ...first, code: inputCode }]))).items[0];
    expect(item.previous?.code).toBe(inputCode);
    expect(item.previous?.truncated).toBe(true);
    expect(item.unchanged).toBe(false);
  });

  it('requires an acknowledgement before replacing an existing upstream file', async () => {
    const path = submissionPath(first);
    const code = 'Existing solution\n';
    const mock = server({ forkExists: false, upstreamFiles: { [path]: code } });
    await expect(mock.engine.submit(fresh(), 'alice')).rejects.toThrow(/(?=.*覆盖)(?=.*确认)/);
    expect(mock.writes()).toEqual([]);
    expect(mock.adapter.ensureFork).not.toHaveBeenCalled();
    expect(mock.adapter.syncFork).not.toHaveBeenCalled();
    expect(mock.filesAt(baseSha).get(path)).toBe(code);
  });

  it.each(['wrong-path', 'wrong-sha'] as const)('rejects an overwrite acknowledgement with %s', async invalid => {
    const path = submissionPath(first);
    const code = 'Existing solution\n';
    const mock = server({ upstreamFiles: { [path]: code } });
    const overwrites = [{ path: invalid === 'wrong-path' ? submissionPath(second) : path, sha: invalid === 'wrong-sha' ? '0'.repeat(40) : blobSha(code) }];
    await expect(mock.engine.submit({ ...fresh(), overwrites }, 'alice')).rejects.toThrow(/(?=.*覆盖)(?=.*确认)/);
    expect(mock.writes()).toEqual([]);
    expect(mock.adapter.ensureFork).not.toHaveBeenCalled();
    expect(mock.adapter.syncFork).not.toHaveBeenCalled();
  });

  it('rejects a stale acknowledgement when the upstream file changes after preview', async () => {
    const path = submissionPath(first);
    const oldCode = 'The version shown in the preview\n';
    const newCode = 'An edit accepted by upstream after the preview\n';
    const mock = server({ upstreamFiles: { [path]: oldCode } });
    const previous = (await mock.engine.preview(fresh())).items.find(item => item.path === path)!.previous!;
    mock.changeUpstreamFile(path, newCode);
    await expect(mock.engine.submit({ ...fresh(), overwrites: [{ path, sha: previous.sha }] }, 'alice')).rejects.toThrow(/确认|覆盖|变化/);
    expect(mock.writes()).toEqual([]);
    expect(mock.adapter.ensureFork).not.toHaveBeenCalled();
    expect(mock.adapter.syncFork).not.toHaveBeenCalled();
    expect([...mock.commits.keys()].some(commit => mock.filesAt(commit).get(path) === newCode)).toBe(true);
  });

  it('keeps overwrite acknowledgements separate for different signatures even when the problem, language and old blob SHA match', async () => {
    const otherSignature = { ...first, author: 'another_handle', code: 'int main() { return 1; }' };
    const paths = [submissionPath(first), submissionPath(otherSignature)];
    const oldCode = 'Identical previous solutions\n';
    const mock = server({ upstreamFiles: Object.fromEntries(paths.map(path => [path, oldCode])) });
    const input = fresh([first, otherSignature]);
    const preview = await mock.engine.preview(input);
    expect(preview.items.map(item => ({ author: item.author, path: item.path, existing: item.existing, sha: item.previous?.sha })))
      .toEqual([first, otherSignature].map((item, index) => ({ author: item.author, path: paths[index], existing: true, sha: blobSha(oldCode) })));
    await expect(mock.engine.submit({ ...input, overwrites: [{ path: paths[0], sha: blobSha(oldCode) }] }, 'alice'))
      .rejects.toThrow(/(?=.*覆盖)(?=.*确认)/);
    expect(mock.writes()).toEqual([]);
    expect(mock.adapter.syncFork).not.toHaveBeenCalled();
    const result = await mock.engine.submit({ ...input, overwrites: paths.map(path => ({ path, sha: blobSha(oldCode) })) }, 'alice');
    const head = mock.pulls.get(result.record.number)!.head.sha;
    expect(mock.filesAt(head).get(paths[0])).toBe(validateSubmission(first).code);
    expect(mock.filesAt(head).get(paths[1])).toBe(validateSubmission(otherSignature).code);
    expect(mock.filesAt(baseSha).get(paths[0])).toBe(oldCode);
    expect(mock.filesAt(baseSha).get(paths[1])).toBe(oldCode);
    expect(mock.count('/git/commits')).toBe(1);
  });

  it('allows a matching current acknowledgement and needs no acknowledgement for the new path', async () => {
    const path = submissionPath(first);
    const oldCode = 'Existing solution\n';
    const mock = server({ upstreamFiles: { [path]: oldCode } });
    const result = await mock.engine.submit({ ...fresh(), overwrites: [{ path, sha: blobSha(oldCode) }] }, 'alice');
    const pull = mock.pulls.get(result.record.number)!;
    expect(mock.filesAt(pull.head.sha).get(path)).toBe(validateSubmission(first).code);
    expect(mock.filesAt(pull.head.sha).get(submissionPath(second))).toBe(validateSubmission(second).code);
    expect(mock.filesAt(baseSha).get(path)).toBe(oldCode);
    expect(mock.count('/git/commits')).toBe(1);
    expect(mock.count('/pulls')).toBe(1);
  });

  it('keeps acknowledgement data out of deterministic request identity', async () => {
    const path = submissionPath(first);
    const oldCode = 'Existing solution\n';
    const mock = server({ upstreamFiles: { [path]: oldCode } });
    const input = fresh();
    const unconfirmed = await mock.engine.preview(input);
    const confirmed = await mock.engine.preview({ ...input, overwrites: [{ path, sha: blobSha(oldCode) }] });
    expect(confirmed.branch).toBe(unconfirmed.branch);
    expect(confirmed.body).toBe(unconfirmed.body);
  });

  it('recovers an identical completed request without requiring the acknowledgement again', async () => {
    const path = submissionPath(first);
    const oldCode = 'Existing solution\n';
    const mock = server({ upstreamFiles: { [path]: oldCode } });
    const input = fresh();
    const created = await mock.engine.submit({ ...input, overwrites: [{ path, sha: blobSha(oldCode) }] }, 'alice');
    const saved = clone(mock.pulls.get(created.record.number)!);
    const writes = mock.writes().length;
    const retried = await new BatchSubmissionEngine(mock.adapter).submit(input, 'alice');
    expect(retried).toMatchObject({ reused: true, record: { number: created.record.number } });
    expect(mock.pulls.get(created.record.number)).toEqual(saved);
    expect(mock.writes()).toHaveLength(writes);
  });

  it('ignores unrelated deleted-source records in the branch lookup for an explicit new request', async () => {
    const mock = server();
    const initial = await mock.engine.submit(fresh(), 'alice');
    const deleted = clone(mock.pulls.get(initial.record.number)!);
    deleted.number = 999;
    deleted.head.repo = null;
    deleted.head.user = null;
    mock.branchPullNoise.push(deleted);
    const requestBoundary = mock.requests.length;
    const result = await mock.engine.submit(fresh(undefined, 'separate-intent-0001'), 'alice');
    expect(result.reused).toBe(false);
    expect(result.record.number).not.toBe(initial.record.number);
    const newReads = mock.requests.slice(requestBoundary).filter(request => request.method === 'GET');
    expect(newReads.some(request => request.path === `${upstreamPath}/pulls` && request.query.get('state') === 'open')).toBe(false);
    expect(mock.count(`/pulls/${deleted.number}/files`, 'GET')).toBe(0);
  });

  it.each(['repo', 'user', 'both'] as const)('stops a matching request with missing head %s before any further fork or branch writes', async missing => {
    const mock = server();
    const input = fresh();
    const initial = await mock.engine.submit(input, 'alice');
    const pull = mock.pulls.get(initial.record.number)!;
    if (missing === 'repo' || missing === 'both') pull.head.repo = null;
    if (missing === 'user' || missing === 'both') pull.head.user = null;
    const writes = mock.writes().length;
    const priorForkCalls = vi.mocked(mock.adapter.ensureFork).mock.calls.length;
    await expect(mock.engine.submit(input, 'alice')).rejects.toBeInstanceOf(MockError);
    expect(mock.writes()).toHaveLength(writes);
    expect(mock.adapter.ensureFork).toHaveBeenCalledTimes(priorForkCalls);
    expect(mock.pulls.size).toBe(1);
  });

  it('includes read-only fork synchronization status in the preview', async () => {
    const mock = server();
    const preview = await mock.engine.preview(fresh());
    expect(preview.forkSync).toMatchObject({
      state: 'behind', repository: 'alice/renamed-practice-fork', branch: 'main',
      upstreamSha: baseSha, forkSha: 'stale-fork-commit', aheadBy: 0, behindBy: 1,
    });
    expect(mock.adapter.inspectForkSync).toHaveBeenCalledWith(mock.fork, expect.objectContaining({ full_name: upstreamName }), baseSha);
    expect(mock.adapter.syncFork).not.toHaveBeenCalled();
    expect(mock.adapter.assertForkCurrent).not.toHaveBeenCalled();
    expect(mock.refs.get('main')).toBe('stale-fork-commit');
    expect(mock.writes()).toEqual([]);
  });

  it('synchronizes the fork before creating code objects and rechecks its base before publishing', async () => {
    const mock = server();
    await mock.engine.submit(fresh(), 'alice');
    const syncPosition = mock.events.indexOf('syncFork');
    const firstBlobPosition = mock.events.indexOf(`POST ${forkPath}/git/blobs`);
    const commitPosition = mock.events.indexOf(`POST ${forkPath}/git/commits`);
    const refPosition = mock.events.indexOf(`POST ${forkPath}/git/refs`);
    const pullPosition = mock.events.indexOf(`POST ${upstreamPath}/pulls`);
    const firstGuardPosition = mock.events.indexOf('assertForkCurrent');
    const finalGuardPosition = mock.events.lastIndexOf('assertForkCurrent');
    expect(syncPosition).toBeGreaterThanOrEqual(0);
    expect(syncPosition).toBeLessThan(firstBlobPosition);
    expect(firstGuardPosition).toBeGreaterThan(commitPosition);
    expect(firstGuardPosition).toBeLessThan(refPosition);
    expect(finalGuardPosition).toBeGreaterThan(refPosition);
    expect(finalGuardPosition).toBeLessThan(pullPosition);
    expect(mock.adapter.syncFork).toHaveBeenCalledWith(mock.fork, expect.objectContaining({ full_name: upstreamName }), baseSha);
    expect(mock.refs.get('main')).toBe(baseSha);
  });

  it('stops a diverged fork before writing any code object or client branch', async () => {
    const mock = server();
    vi.mocked(mock.adapter.inspectForkSync).mockResolvedValue({
      state: 'diverged', repository: mock.fork.full_name, branch: 'main', upstreamSha: baseSha,
      forkSha: 'stale-fork-commit', aheadBy: 1, behindBy: 1,
    });
    vi.mocked(mock.adapter.syncFork).mockRejectedValue(new MockError('Fork has diverged; preserve its existing commits'));
    expect((await mock.engine.preview(fresh())).forkSync?.state).toBe('diverged');
    await expect(mock.engine.submit(fresh(), 'alice')).rejects.toThrow('Fork has diverged');
    expect(mock.writes()).toEqual([]);
    expect(mock.count('/git/blobs')).toBe(0);
    expect(mock.count('/git/refs')).toBe(0);
    expect(mock.refs.get('main')).toBe('stale-fork-commit');
    expect(mock.pulls.size).toBe(0);
  });

  it('does not synchronize a fork during read-only recovery of an already completed request', async () => {
    const mock = server();
    const input = fresh();
    const initial = await mock.engine.submit(input, 'alice');
    vi.mocked(mock.adapter.syncFork).mockClear();
    const writes = mock.writes().length;
    const retried = await mock.engine.submit(input, 'alice');
    expect(retried).toMatchObject({ reused: true, record: { number: initial.record.number } });
    expect(mock.adapter.syncFork).not.toHaveBeenCalled();
    expect(mock.writes()).toHaveLength(writes);
  });

  it('does not publish a client branch when the current-base guard reports an upstream change', async () => {
    const mock = server();
    vi.mocked(mock.adapter.assertForkCurrent).mockRejectedValue(new MockError('Upstream changed before publishing'));
    await expect(mock.engine.submit(fresh(), 'alice')).rejects.toThrow('Upstream changed before publishing');
    expect(mock.count('/git/refs')).toBe(0);
    expect(mock.count('/pulls')).toBe(0);
    expect([...mock.refs.keys()]).toEqual(['main']);
  });

  it('rejects a rebuilt fork with the same owner and name but a different repository identity', async () => {
    const mock = server();
    Object.assign(mock.fork, { id: 41 });
    const input = fresh();
    const initial = await mock.engine.submit(input, 'alice');
    const saved = clone(mock.pulls.get(initial.record.number)!);
    Object.assign(mock.fork, { id: 42 });
    const writes = mock.writes().length;
    await expect(mock.engine.submit(input, 'alice')).rejects.toBeInstanceOf(MockError);
    expect(mock.pulls.get(initial.record.number)).toEqual(saved);
    expect(mock.writes()).toHaveLength(writes);
  });
});
