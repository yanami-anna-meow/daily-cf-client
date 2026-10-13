// Read-only local corpus benchmark. Does not fetch, create a clone, or read an
// application profile. TypeScript modules are transpiled in memory only.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};
const { GitRepository } = require('../electron/git-repository.ts');
const { GitProblemLibrary } = require('../electron/git-library.ts');
const { GitStore } = require('../electron/git-store.ts');
const { GitIntegrity } = require('../electron/git-integrity.ts');
const git = require('isomorphic-git').default;
const integrityOnly = process.argv.includes('--integrity-only');
const checkout = path.resolve(process.argv[2] ?? '.cache/upstream');
const revision = execFileSync('git', ['-C', checkout, 'rev-parse', process.argv[3] ?? 'HEAD'], { encoding: 'utf8' }).trim();
const gitdir = execFileSync('git', ['-C', checkout, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Expected an immutable SHA-1 revision');
globalThis.fetch = async () => { throw new Error('Network is forbidden in this local benchmark'); };

// A disposable copy uses the real checked GitStore filesystem. The original
// corpus is read-only, and no private GitRepository path or FS is overridden.
const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'daily-cf-benchmark-0.3.6-'));
const corpusRoot = path.join(temporaryRoot, 'corpus');
const snapshotPath = path.join(corpusRoot, 'objects.git', 'refs', 'heads', 'daily-cf-snapshot');
await fs.promises.mkdir(corpusRoot);
await fs.promises.cp(gitdir, path.join(corpusRoot, 'objects.git'), { recursive: true, dereference: false });
let removedPromisorMarkers = 0;
let removedGitCliMetadata = 0;
// GitIntegrity correctly rejects foreign object-store entries. These markers
// describe the input's partial clone, not Git object bytes: remove them only in
// the disposable copy. This corpus is used for problem reads, never for a full
// reachable-object integrity claim. The separate complete clone covers that.
const copiedPackDirectory = path.join(corpusRoot, 'objects.git', 'objects', 'pack');
for (const filename of await fs.promises.readdir(copiedPackDirectory)) {
  if (!/^pack-[0-9a-f]{40}\.(?:promisor|rev)$/.test(filename)) continue;
  const target = path.resolve(copiedPackDirectory, filename);
  if (path.relative(copiedPackDirectory, target) !== filename || !target.startsWith(`${temporaryRoot}${path.sep}`)) throw new Error('Invalid temporary promisor path');
  await fs.promises.unlink(target);
  if (filename.endsWith('.promisor')) removedPromisorMarkers++;
  else removedGitCliMetadata++;
}
const copiedInfoPacks = path.join(corpusRoot, 'objects.git', 'objects', 'info', 'packs');
try { await fs.promises.unlink(copiedInfoPacks); removedGitCliMetadata++; }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
await fs.promises.writeFile(path.join(corpusRoot, 'daily-cf-repository.json'), JSON.stringify({ version: 1, repository: 'Yawn-Sean/Daily_CF_Problems' }));
await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true });
await fs.promises.writeFile(snapshotPath, `${revision}\n`);
const store = new GitRepository(corpusRoot);
let version = { branch: 'benchmark-pinned-local', revision };
let counts = {};
let durations = {};
let fsReads = 0;
let fsReadBytes = 0;
let fsStats = 0;
let fsDirectoryReads = 0;
let fsLstats = 0;
let fsRealpaths = 0;
let fsOpens = 0;
const read = fs.promises.readFile.bind(fs.promises);
fs.promises.readFile = async (...args) => {
  const result = await read(...args);
  fsReads++;
  fsReadBytes += Buffer.byteLength(result);
  return result;
};
const stat = fs.promises.stat.bind(fs.promises);
fs.promises.stat = async (...args) => { fsStats++; return stat(...args); };
const readdir = fs.promises.readdir.bind(fs.promises);
fs.promises.readdir = async (...args) => { fsDirectoryReads++; return readdir(...args); };
const lstat = fs.promises.lstat.bind(fs.promises);
fs.promises.lstat = async (...args) => { fsLstats++; return lstat(...args); };
const realpath = fs.promises.realpath.bind(fs.promises);
fs.promises.realpath = async (...args) => { fsRealpaths++; return realpath(...args); };
const open = fs.promises.open.bind(fs.promises);
fs.promises.open = async (...args) => {
  fsOpens++;
  const handle = await open(...args);
  const handleRead = handle.readFile.bind(handle);
  handle.readFile = async (...options) => {
    const result = await handleRead(...options);
    fsReads++; fsReadBytes += Buffer.byteLength(result);
    return result;
  };
  return handle;
};
for (const method of ['readCommit', 'readTree', 'readBlob', 'readObject']) {
  const original = git[method];
  git[method] = async (...args) => {
    counts[method] = (counts[method] ?? 0) + 1;
    const started = performance.now();
    try { return await original(...args); }
    finally { durations[method] = (durations[method] ?? 0) + performance.now() - started; }
  };
}
let syncs = 0;
const checkedRepository = (store, expectedRevision) => ({
  sync: async () => {
    syncs++;
    const snapshot = await store.getLocalSnapshot();
    if (!snapshot || (expectedRevision && snapshot.revision !== expectedRevision())) throw new Error('Disposable corpus did not select the expected immutable revision');
    return snapshot;
  },
  getLocalSnapshot: store.getLocalSnapshot.bind(store),
  listFiles: store.listFiles.bind(store),
  readFile: async (revision, filename, maxBytes) => {
    if (filename.endsWith('/problems.md')) counts.problemFileReads = (counts.problemFileReads ?? 0) + 1;
    return store.readFile(revision, filename, maxBytes);
  },
});
const repository = checkedRepository(store, () => version.revision);
const library = new GitProblemLibrary(repository);
const results = [];
async function measure(name, operation) {
  counts = {}; durations = {}; fsReads = 0; fsReadBytes = 0; fsStats = 0; fsDirectoryReads = 0; fsLstats = 0; fsRealpaths = 0; fsOpens = 0;
  const started = performance.now();
  console.log(JSON.stringify({ started: name, revision: version.revision }));
  const output = await operation();
  const row = { name, milliseconds: Math.round(performance.now() - started), counts, objectMilliseconds: Object.fromEntries(Object.entries(durations).map(([key, value]) => [key, Math.round(value)])), fsReads, fsReadBytes, fsStats, fsDirectoryReads, fsLstats, fsRealpaths, fsOpens, rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024), ...output };
  results.push(row);
  console.log(JSON.stringify(row));
}
let snapshot;
async function fullIndex() {
  const snap = snapshot ?? await library.getArchiveSnapshot();
  return fullIndexFrom(library, snap);
}
async function fullIndexFrom(target, snap) {
  let days = 0; let problems = 0;
  for (const entry of snap.months) {
    const month = await target.getMonthFromSnapshot(entry.month, snap);
    days += month.length;
    problems += month.reduce((total, day) => total + day.problems.length, 0);
  }
  return { months: snap.months.length, days, problems };
}
try {
if (!integrityOnly) {
await measure('cold-directory', async () => {
  snapshot = await library.getArchiveSnapshot();
  return { months: snapshot.months.length, days: snapshot.months.reduce((total, item) => total + item.days, 0) };
});
await measure('cold-full-index', fullIndex);
await measure('same-revision-full-index', fullIndex);
await measure('same-revision-checked-snapshot-and-full-index', async () => {
  snapshot = await library.getArchiveSnapshot();
  return fullIndex();
});
await measure('concurrent-local-preview-and-fresh-full-index', async () => {
  const [preview, fresh] = await Promise.all([library.getLocalLibraryView({ kind: 'archive', scope: 'all' }), fullIndex()]);
  return { ...fresh, previewDays: preview && preview.kind === 'archive' ? Object.values(preview.index ?? {}).flat().length : 0 };
});
const nextRef = process.argv[4];
if (nextRef && nextRef !== '-') {
  const nextRevision = execFileSync('git', ['-C', checkout, 'rev-parse', nextRef], { encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(nextRevision)) throw new Error('Expected an immutable next SHA-1 revision');
  const changedPaths = execFileSync('git', ['-C', checkout, 'diff', '--name-status', '--no-renames', revision, nextRevision, '--', 'daily_problems'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).flatMap(line => {
    const [status, filename] = line.split('\t');
    return /^daily_problems\/\d{4}\/\d{2}\/\d{4}\/problems\.md$/.test(filename ?? '') ? [{ status, path: filename }] : [];
  });
  version = { ...version, revision: nextRevision };
  await fs.promises.writeFile(snapshotPath, `${nextRevision}\n`);
  await measure('existing-next-revision-changed-blob-only-index', async () => {
    snapshot = await library.getArchiveSnapshot();
    const output = await fullIndex();
    const expectedBlobReads = changedPaths.filter(item => item.status !== 'D').length;
    if ((counts.problemFileReads ?? 0) !== expectedBlobReads) throw new Error(`Expected ${expectedBlobReads} changed/new problem file reads, received ${counts.problemFileReads ?? 0}`);
    return { ...output, revision: nextRevision, expectedBlobReads, changedPaths };
  });
}
}
const integritySource = process.argv[6];
if (integritySource) {
  const completeSource = path.resolve(integritySource);
  const completeRoot = path.join(temporaryRoot, 'complete');
  await fs.promises.cp(completeSource, completeRoot, { recursive: true, dereference: false });
  if (!integrityOnly) {
    const completeLibrary = new GitProblemLibrary(checkedRepository(new GitRepository(completeRoot)));
    let completeSnapshot;
    await measure('complete-corpus-cold-directory', async () => {
      completeSnapshot = await completeLibrary.getArchiveSnapshot();
      return { revision: completeSnapshot.revision, months: completeSnapshot.months.length, days: completeSnapshot.months.reduce((total, item) => total + item.days, 0) };
    });
    await measure('complete-corpus-cold-full-index', () => fullIndexFrom(completeLibrary, completeSnapshot));
    await measure('complete-corpus-same-revision-full-index', () => fullIndexFrom(completeLibrary, completeSnapshot));
  }
  let inspector;
  let proof;
  await measure('complete-corpus-integrity-cold', async () => {
    const selected = await new GitStore(completeRoot, 'Yawn-Sean/Daily_CF_Problems').open();
    if (!selected?.snapshot) throw new Error('Complete corpus has no published snapshot');
    inspector = new GitIntegrity(selected.gitdir, selected.fs);
    proof = await inspector.inspect(selected.snapshot.revision);
    return { revision: proof.revision, inspectedFiles: proof.fileCount, verifiedObjects: proof.objectCount, fingerprint: proof.fingerprint };
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await measure(`complete-corpus-integrity-unchanged-${attempt}`, async () => {
      const previous = proof;
      proof = await inspector.inspect(previous.revision, previous);
      if (proof.fingerprint !== previous.fingerprint) throw new Error('Unmodified corpus fingerprint changed');
      return { revision: proof.revision, inspectedFiles: proof.fileCount, verifiedObjects: proof.objectCount, sameFingerprint: true };
    });
  }
}
const report = { version: '0.3.6', integrityOnly, checkout, revision, removedPromisorMarkers, removedGitCliMetadata, integritySource: integritySource ? path.resolve(integritySource) : undefined, networkRequests: 0, profileAccess: false, checkedFilesystem: true, syncs, notes: 'Disposable corpus copies use real GitStore checked filesystems. Promisor markers and Git CLI reverse-index/info-packs metadata are removed only from the sparse corpus copy; its existing pack/idx object bytes and immutable revisions are unchanged and no complete-closure claim is made for it. Complete-corpus read and physical-byte integrity measurements use the separate complete clone. Network synchronization is stubbed. These machine-specific measurements do not promise network latency.', results };
const outputPath = process.argv[5];
if (outputPath) fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
} finally {
  // Delete only the fresh benchmark directory whose absolute location was
  // verified below; the input corpora and user profiles are never modified.
  const cleanupPath = await realpath(temporaryRoot);
  const relative = path.relative(path.resolve(os.tmpdir()), cleanupPath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep) || !relative.startsWith('daily-cf-benchmark-0.3.6-')) throw new Error('Refusing cleanup outside the benchmark temporary directory');
  await fs.promises.rm(cleanupPath, { recursive: true });
}
