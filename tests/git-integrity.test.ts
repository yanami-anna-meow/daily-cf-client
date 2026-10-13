import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import git, { type PromiseFsClient, type TreeEntry } from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitIntegrity, GitIntegrityError, GitIntegrityLimitError } from '../electron/git-integrity';

let directory: string;
let gitdir: string;
let oids: string[];
const loosePath = (oid: string) => path.join(gitdir, 'objects', oid.slice(0, 2), oid.slice(2));

beforeEach(async () => {
  directory = await fs.promises.mkdtemp(path.join(tmpdir(), 'daily-cf-integrity-test-'));
  gitdir = path.join(directory, 'objects.git');
  await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
  oids = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(directory));
  if (!relative.startsWith('daily-cf-integrity-test-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe integrity fixture cleanup.');
  await fs.promises.rm(directory, { recursive: true, force: true });
});

async function object(type: 'blob' | 'tree' | 'commit', value: string | Uint8Array) {
  const oid = await git.writeObject({ fs, gitdir, type, object: typeof value === 'string' ? Buffer.from(value) : value, format: 'content' });
  oids.push(oid);
  return oid;
}
async function tree(entries: TreeEntry[]) {
  const oid = await git.writeTree({ fs, gitdir, tree: entries });
  oids.push(oid);
  return oid;
}
async function commit(root: string) {
  return object('commit', `tree ${root}\nauthor Test <test@example.invalid> 0 +0000\ncommitter Test <test@example.invalid> 0 +0000\n\nFixture\n`);
}
async function basic() {
  const a = await object('blob', 'original A');
  const b = await object('blob', 'modified B');
  const root = await tree([
    { mode: '100644', path: 'a.txt', type: 'blob', oid: a },
    { mode: '100644', path: 'b.txt', type: 'blob', oid: b },
  ]);
  return { a, b, root, revision: await commit(root) };
}
async function pack() {
  const result = await git.packObjects({ fs, gitdir, oids: [...new Set(oids)], write: true });
  const packPath = path.join(gitdir, 'objects', 'pack', result.filename);
  await git.indexPack({ fs, dir: directory, gitdir, filepath: packPath });
  for (const oid of new Set(oids)) await fs.promises.unlink(loosePath(oid));
  return { packPath, idxPath: packPath.replace(/\.pack$/, '.idx') };
}
function rechecksum(index: Buffer): Buffer {
  createHash('sha1').update(index.subarray(0, -20)).digest().copy(index, index.length - 20);
  return index;
}
function swap(index: Buffer, a: string, b: string): Buffer {
  const result = Buffer.from(index);
  const count = result.readUInt32BE(1028);
  const hashes = Array.from({ length: count }, (_, position) => result.subarray(1032 + position * 20, 1052 + position * 20).toString('hex'));
  const first = hashes.indexOf(a); const second = hashes.indexOf(b);
  if (first < 0 || second < 0) throw new Error('Missing fixture objects in index.');
  // Swap matching CRC values as well: this must exercise object identity, not a
  // simple mismatch between an offset and the compressed-entry CRC checksum.
  for (const base of [1032 + count * 20, 1032 + count * 24]) {
    const value = result.readUInt32BE(base + first * 4);
    result.writeUInt32BE(result.readUInt32BE(base + second * 4), base + first * 4);
    result.writeUInt32BE(value, base + second * 4);
  }
  return rechecksum(result);
}
function client(overrides: Partial<PromiseFsClient['promises']>): PromiseFsClient {
  return { promises: { ...fs.promises, ...overrides } };
}
function variable(value: number): Buffer {
  const bytes: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function record(type: number, body: Buffer, declaredSize = body.length, base = Buffer.alloc(0)): Buffer {
  const size: number[] = [(type << 4) | (declaredSize % 16)];
  let remaining = Math.floor(declaredSize / 16);
  while (remaining) { size[size.length - 1] |= 128; size.push(remaining % 128); remaining = Math.floor(remaining / 128); }
  return Buffer.concat([Buffer.from(size), base, deflateSync(body)]);
}
async function binaryPack(entries: { oid: string; content: Buffer }[]) {
  const header = Buffer.from('5041434b0000000200000000', 'hex'); header.writeUInt32BE(entries.length, 8);
  const payload = Buffer.concat([header, ...entries.map(entry => entry.content)]);
  const hash = createHash('sha1').update(payload).digest();
  const data = Buffer.concat([payload, hash]);
  let offset = 12;
  const records = entries.map(entry => { const result = { oid: entry.oid, offset }; offset += entry.content.length; return result; }).sort((a, b) => a.oid.localeCompare(b.oid));
  const index = Buffer.alloc(1072 + records.length * 28);
  index.writeUInt32BE(0xff744f63, 0); index.writeUInt32BE(2, 4);
  for (let bucket = 0; bucket < 256; bucket++) index.writeUInt32BE(records.filter(entry => parseInt(entry.oid.slice(0, 2), 16) <= bucket).length, 8 + bucket * 4);
  records.forEach((entry, position) => {
    Buffer.from(entry.oid, 'hex').copy(index, 1032 + position * 20);
    index.writeUInt32BE(entry.offset, 1032 + records.length * 24 + position * 4);
  });
  hash.copy(index, index.length - 40); rechecksum(index);
  const packDirectory = path.join(gitdir, 'objects', 'pack');
  await fs.promises.mkdir(packDirectory, { recursive: true });
  const packPath = path.join(packDirectory, `pack-${hash.toString('hex')}.pack`);
  const idxPath = packPath.replace(/\.pack$/, '.idx');
  await fs.promises.writeFile(packPath, data); await fs.promises.writeFile(idxPath, index);
  return { packPath, idxPath };
}

describe('GitIntegrity verifies actual public object-store bytes', () => {
  it('verifies the complete current tree including symlink blobs, excluding external gitlink targets and parents', async () => {
    const blob = await object('blob', 'hello');
    const link = await object('blob', '../outside');
    const nested = await tree([{ mode: '100755', path: 'program', type: 'blob', oid: blob }]);
    const root = await tree([
      { mode: '040000', path: 'nested', type: 'tree', oid: nested },
      { mode: '120000', path: 'link', type: 'blob', oid: link },
      { mode: '160000', path: 'module', type: 'commit', oid: 'f'.repeat(40) },
    ]);
    const revision = await object('commit', `tree ${root}\nparent ${'e'.repeat(40)}\n\nShallow commit\n`);
    const reader = new GitIntegrity(gitdir);
    const proof = await reader.inspect(revision);
    expect(proof).toMatchObject({ revision, objectCount: 5, fileCount: 5 });
    expect(await reader.readCommit(revision)).toEqual({ oid: revision, commit: { tree: root } });
    expect((await reader.readTree(nested)).tree).toEqual([{ mode: '100755', path: 'program', type: 'blob', oid: blob }]);
    expect(Buffer.from((await reader.readBlob(blob)).blob).toString()).toBe('hello');
    await fs.promises.unlink(loosePath(link));
    await expect(reader.inspect(revision, proof)).rejects.toBeInstanceOf(GitIntegrityError);
  });

  it('re-reads every pack/index byte while reusing only a genuine identical revision proof', async () => {
    const { revision } = await basic();
    const { packPath, idxPath } = await pack();
    const reader = new GitIntegrity(gitdir);
    const first = await reader.inspect(revision);
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const raw = vi.spyOn(git, 'readObject');
    expect(await reader.inspect(revision, first)).toBe(first);
    expect(readFile.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining([packPath, idxPath]));
    expect(raw).not.toHaveBeenCalled();
    expect(Object.isFrozen(first)).toBe(true);
    await reader.inspect(revision, { ...first });
    expect(raw).toHaveBeenCalled();
  });

  it('rejects a correctly checksummed IDX offset-and-CRC swap that the underlying reader accepts', async () => {
    const { revision, a, b } = await basic();
    const { packPath, idxPath } = await pack();
    const originalPack = await fs.promises.readFile(packPath);
    const original = await fs.promises.readFile(idxPath);
    const reader = new GitIntegrity(gitdir);
    const prior = await reader.inspect(revision);
    const stat = await fs.promises.stat(idxPath);
    const changed = swap(original, a, b);
    await fs.promises.writeFile(idxPath, changed);
    await fs.promises.utimes(idxPath, stat.atime, stat.mtime);
    expect(changed.length).toBe(original.length);
    expect(changed.subarray(-20)).toEqual(createHash('sha1').update(changed.subarray(0, -20)).digest());
    expect(await fs.promises.readFile(packPath)).toEqual(originalPack);
    const unverified = await git.readObject({ fs, gitdir, oid: a, format: 'content' });
    expect(unverified.oid).toBe(a);
    expect(Buffer.from(unverified.object as Uint8Array).toString()).toBe('modified B');
    await expect(reader.readBlob(a)).rejects.toMatchObject({ code: 'git_local_corrupt' });
    await expect(reader.inspect(revision, prior)).rejects.toMatchObject({ code: 'git_local_corrupt' });
    await fs.promises.writeFile(idxPath, original);
    expect(await reader.inspect(revision, prior)).toBe(prior);
  });

  it('detects a damaged unreachable loose object and a corrupt loose object shadowing a valid pack', async () => {
    const { revision, a } = await basic();
    const extra = await object('blob', 'unreachable but present');
    const bytes = await fs.promises.readFile(loosePath(extra));
    const reader = new GitIntegrity(gitdir);
    const proof = await reader.inspect(revision);
    await fs.promises.writeFile(loosePath(extra), bytes.subarray(0, 3));
    await expect(reader.inspect(revision, proof)).rejects.toMatchObject({ code: 'git_local_corrupt' });
    await fs.promises.writeFile(loosePath(extra), bytes);
    await pack();
    await fs.promises.mkdir(path.dirname(loosePath(a)), { recursive: true });
    await fs.promises.writeFile(loosePath(a), deflateSync(Buffer.from('blob 5\0other')));
    await expect(reader.readBlob(a)).rejects.toBeInstanceOf(GitIntegrityError);
    await expect(reader.inspect(revision)).rejects.toBeInstanceOf(GitIntegrityError);
  });

  it.each(['blob', 'tree', 'commit'] as const)('detects a missing reachable %s', async kind => {
    const { revision, a, root } = await basic();
    const reader = new GitIntegrity(gitdir);
    const proof = await reader.inspect(revision);
    await fs.promises.unlink(loosePath(kind === 'blob' ? a : kind === 'tree' ? root : revision));
    await expect(reader.inspect(revision, proof)).rejects.toMatchObject({ code: 'git_local_corrupt' });
  });

  it('does not let the dependency synthesize a missing empty tree during complete validation', async () => {
    const root = await tree([]);
    const revision = await commit(root);
    const reader = new GitIntegrity(gitdir);
    await reader.inspect(revision);
    await fs.promises.unlink(loosePath(root));
    await expect(reader.inspect(revision)).rejects.toMatchObject({ code: 'git_local_corrupt' });
  });

  it.each(['missing index', 'missing pack', 'truncated index', 'bad index checksum', 'bad pack payload', 'bad pack name'] as const)('detects %s without trusting a previously warmed cache', async damage => {
    const { revision, a } = await basic();
    const { packPath, idxPath } = await pack();
    const reader = new GitIntegrity(gitdir);
    const proof = await reader.inspect(revision);
    await reader.readBlob(a, {});
    if (damage === 'missing index') await fs.promises.unlink(idxPath);
    if (damage === 'missing pack') await fs.promises.unlink(packPath);
    if (damage === 'truncated index') await fs.promises.writeFile(idxPath, (await fs.promises.readFile(idxPath)).subarray(0, 1035));
    if (damage === 'bad index checksum') {
      const bytes = await fs.promises.readFile(idxPath); bytes[bytes.length - 1] ^= 1;
      await fs.promises.writeFile(idxPath, bytes);
    }
    if (damage === 'bad pack payload') {
      const bytes = await fs.promises.readFile(packPath); bytes[14] ^= 1;
      await fs.promises.writeFile(packPath, bytes);
    }
    if (damage === 'bad pack name') {
      await fs.promises.rename(packPath, path.join(path.dirname(packPath), `pack-${'f'.repeat(40)}.pack`));
      await fs.promises.rename(idxPath, path.join(path.dirname(idxPath), `pack-${'f'.repeat(40)}.idx`));
    }
    await expect(reader.inspect(revision, proof)).rejects.toMatchObject({ code: 'git_local_corrupt' });
  });

  it.each(['fanout', 'duplicate oid', 'duplicate offset', 'outside offset', 'trailing bytes'] as const)('rejects a self-checksummed malformed IDX %s', async damage => {
    const { revision } = await basic();
    const { idxPath } = await pack();
    let bytes = await fs.promises.readFile(idxPath);
    const count = bytes.readUInt32BE(1028);
    if (damage === 'fanout') bytes.writeUInt32BE(123, 8);
    if (damage === 'duplicate oid') bytes.copy(bytes, 1052, 1032, 1052);
    if (damage === 'duplicate offset') bytes.copy(bytes, 1032 + count * 24 + 4, 1032 + count * 24, 1032 + count * 24 + 4);
    if (damage === 'outside offset') bytes.writeUInt32BE(1, 1032 + count * 24);
    if (damage === 'trailing bytes') bytes = Buffer.concat([bytes.subarray(0, -40), Buffer.alloc(8), bytes.subarray(-40)]);
    await fs.promises.writeFile(idxPath, rechecksum(bytes));
    await expect(new GitIntegrity(gitdir).inspect(revision)).rejects.toMatchObject({ code: 'git_local_corrupt' });
  });

  it.each(['EACCES', 'ENOSPC', 'EIO'] as const)('preserves %s on disk reads instead of authorizing repair', async code => {
    const { revision, a } = await basic();
    await pack();
    const error = Object.assign(new Error('Disk unavailable'), { code });
    const reader = new GitIntegrity(gitdir, client({
      readFile: async (file: string) => {
        if (String(file).endsWith('.pack')) throw error;
        return fs.promises.readFile(file);
      },
    }));
    await expect(reader.inspect(revision)).rejects.toBe(error);
    await expect(reader.readBlob(a)).rejects.toBe(error);
  });

  it('preserves errors swallowed by the Git reader even when another copy of the object is available', async () => {
    const { a } = await basic();
    const original = await fs.promises.readFile(loosePath(a));
    await pack();
    await fs.promises.writeFile(loosePath(a), original);
    const error = Object.assign(new Error('Permission denied on loose object'), { code: 'EACCES' });
    const reader = new GitIntegrity(gitdir, client({
      readFile: async (file: string) => {
        if (path.resolve(file) === loosePath(a)) throw error;
        return fs.promises.readFile(file);
      },
    }));
    await expect(reader.readBlob(a)).rejects.toBe(error);
  });

  it.each(['lstat', 'readdir'] as const)('preserves %s errors', async method => {
    const { revision, a } = await basic();
    await pack();
    const error = Object.assign(new Error('Not allowed'), { code: 'EACCES' });
    const reader = new GitIntegrity(gitdir, client({ [method]: async () => { throw error; } }));
    await expect(reader.inspect(revision)).rejects.toBe(error);
    if (method === 'readdir') await expect(reader.readBlob(a)).rejects.toBe(error);
  });

  it('rejects disk hardlinks and directory junctions instead of following external object storage', async () => {
    const { revision, a } = await basic();
    const outside = path.join(directory, 'external-object');
    await fs.promises.rename(loosePath(a), outside);
    await fs.promises.link(outside, loosePath(a));
    await expect(new GitIntegrity(gitdir).inspect(revision)).rejects.toMatchObject({ code: 'git_local_corrupt' });
    await expect(new GitIntegrity(gitdir).readBlob(a)).rejects.toMatchObject({ code: 'git_local_corrupt' });
    await fs.promises.unlink(loosePath(a));
    await fs.promises.rename(outside, loosePath(a));
    const { packPath } = await pack();
    const packDirectory = path.dirname(packPath);
    const externalPacks = path.join(directory, 'external-packs');
    await fs.promises.rename(packDirectory, externalPacks);
    await fs.promises.symlink(externalPacks, packDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new GitIntegrity(gitdir).inspect(revision)).rejects.toMatchObject({ code: 'git_local_corrupt' });
    await expect(new GitIntegrity(gitdir).readBlob(a)).rejects.toMatchObject({ code: 'git_local_corrupt' });
    await fs.promises.unlink(packDirectory);
  });

  it('authenticates and parses the same bytes and does not accept a different object type', async () => {
    const malformed = await object('tree', Buffer.from('100644 missing-oid\0'));
    const malformedCommit = await object('commit', `tree ${'f'.repeat(40)}\ntree ${'e'.repeat(40)}\n\nBad commit`);
    const blob = await object('blob', 'not a tree');
    const badTypeTree = await tree([{ mode: '040000', path: 'directory', type: 'tree', oid: blob }]);
    const revision = await commit(badTypeTree);
    const reader = new GitIntegrity(gitdir);
    await expect(reader.readTree(malformed)).rejects.toBeInstanceOf(GitIntegrityError);
    await expect(reader.readCommit(malformedCommit)).rejects.toBeInstanceOf(GitIntegrityError);
    await expect(reader.readTree(blob)).rejects.toBeInstanceOf(GitIntegrityError);
    await expect(reader.inspect(revision)).rejects.toBeInstanceOf(GitIntegrityError);
  });

  it('builds its proof from the exact captured bytes even if disk content changes during verification', async () => {
    const { revision, a, b } = await basic();
    const { idxPath } = await pack();
    const original = await fs.promises.readFile(idxPath);
    let changed = false;
    const reader = new GitIntegrity(gitdir, client({
      readFile: async (file: string) => {
        const result = await fs.promises.readFile(file);
        if (path.resolve(file) === idxPath && !changed) {
          changed = true;
          await fs.promises.writeFile(file, swap(original, a, b));
        }
        return result;
      },
    }));
    const captured = await reader.inspect(revision);
    expect(captured.revision).toBe(revision);
    await expect(reader.inspect(revision, captured)).rejects.toMatchObject({ code: 'git_local_corrupt' });
  });

  it('captures one immutable view and binds reusable full proofs to the issuing instance', async () => {
    const { revision, a } = await basic();
    const reader = new GitIntegrity(gitdir);
    const captured = await reader.capture();
    const proof = await reader.inspect(revision);
    const published = reader.reader(proof);
    await fs.promises.writeFile(loosePath(a), Buffer.from('broken'));
    expect(Buffer.from((await captured.readBlob(a)).blob).toString()).toBe('original A');
    expect(Buffer.from((await published.readBlob(a)).blob).toString()).toBe('original A');
    expect(() => new GitIntegrity(gitdir).reader(proof)).toThrow(GitIntegrityError);
    expect(() => reader.reader({ ...proof })).toThrow(GitIntegrityError);
    await expect(reader.capture()).rejects.toBeInstanceOf(GitIntegrityError);
  });

  it('rejects a self-consistent index claiming that a real blob is the absent empty tree', async () => {
    const empty = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const commitBytes = Buffer.from(`tree ${empty}\n\nFixture\n`);
    const revision = createHash('sha1').update(`commit ${commitBytes.length}\0`).update(commitBytes).digest('hex');
    await binaryPack([
      { oid: empty, content: record(3, Buffer.alloc(0)) },
      { oid: revision, content: record(1, commitBytes) },
    ]);
    const reader = new GitIntegrity(gitdir);
    expect((await git.readObject({ fs, gitdir, oid: empty, format: 'content' })).type).toBe('tree');
    await expect(reader.inspect(revision)).rejects.toBeInstanceOf(GitIntegrityError);
    await expect(reader.readTree(empty)).rejects.toBeInstanceOf(GitIntegrityError);
    await expect((await reader.capture()).readTree(empty)).rejects.toBeInstanceOf(GitIntegrityError);
  });

  it('accepts a real empty tree represented as an offset delta against another tree', async () => {
    const empty = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const base = Buffer.concat([Buffer.from('100644 a\0'), Buffer.from('a'.repeat(40), 'hex')]);
    const baseOid = createHash('sha1').update(`tree ${base.length}\0`).update(base).digest('hex');
    const baseRecord = record(2, base);
    expect(baseRecord.length).toBeLessThan(128);
    const commitBytes = Buffer.from(`tree ${empty}\n\nFixture\n`);
    const revision = createHash('sha1').update(`commit ${commitBytes.length}\0`).update(commitBytes).digest('hex');
    const delta = Buffer.concat([variable(base.length), variable(0)]);
    await binaryPack([
      { oid: baseOid, content: baseRecord },
      { oid: empty, content: record(6, delta, delta.length, Buffer.from([baseRecord.length])) },
      { oid: revision, content: record(1, commitBytes) },
    ]);
    const reader = new GitIntegrity(gitdir);
    expect((await reader.inspect(revision)).objectCount).toBe(2);
    expect(await reader.readTree(empty)).toEqual({ oid: empty, tree: [] });
  });

  it('checks cumulative file sizes before reading a pack and classifies the limit separately from damage', async () => {
    const { revision } = await basic();
    const { packPath } = await pack();
    const readFile = vi.fn(fs.promises.readFile);
    const reader = new GitIntegrity(gitdir, client({
      lstat: async (file: string) => {
        const stat = await fs.promises.lstat(file);
        if (path.resolve(file) === packPath) Object.defineProperty(stat, 'size', { value: 512 * 1024 * 1024 });
        return stat;
      }, readFile,
    }));
    await expect(reader.inspect(revision)).rejects.toBeInstanceOf(GitIntegrityLimitError);
    expect(readFile.mock.calls.some(call => path.resolve(String(call[0])) === packPath)).toBe(false);
  });

  it.each(['declared blob', 'delta source', 'delta target'] as const)('bounds an oversized %s before Git can allocate it, including local preview reads', async kind => {
    const oid = 'a'.repeat(40);
    const over = 128 * 1024 * 1024 + 1;
    const delta = Buffer.concat([variable(kind === 'delta source' ? over : 0), variable(kind === 'delta target' ? over : 0)]);
    const content = kind === 'declared blob' ? record(3, Buffer.from('x'), over) : record(7, delta, delta.length, Buffer.from('b'.repeat(40), 'hex'));
    await binaryPack([{ oid, content }]);
    const reader = new GitIntegrity(gitdir);
    await expect(reader.capture()).rejects.toMatchObject({ code: 'git_integrity_too_large' });
    await expect(reader.inspect(oid)).rejects.toMatchObject({ code: 'git_integrity_too_large' });
    await expect(reader.readBlob(oid)).rejects.toMatchObject({ code: 'git_integrity_too_large' });
  });

  it('bounds cumulative restored delta sizes without allocating their large results', async () => {
    const size = 128 * 1024 * 1024;
    const operations = Buffer.alloc(2048, 0x80); // Each operation copies 64 KiB.
    const delta = Buffer.concat([variable(size), variable(size), operations]);
    await binaryPack(Array.from({ length: 5 }, (_, index) => ({
      oid: String(index + 1).repeat(40), content: record(7, delta, delta.length, Buffer.from('b'.repeat(40), 'hex')),
    })));
    await expect(new GitIntegrity(gitdir).capture()).rejects.toMatchObject({ code: 'git_integrity_too_large' });
  });

  it('maps the actual loose inflation limit to a resource error without repair eligibility', async () => {
    const wrapped = Buffer.alloc(128 * 1024 * 1024 + 1);
    const bytes = deflateSync(wrapped);
    const oid = 'a'.repeat(40);
    await fs.promises.mkdir(path.dirname(loosePath(oid)), { recursive: true });
    await fs.promises.writeFile(loosePath(oid), bytes);
    const reader = new GitIntegrity(gitdir);
    await expect(reader.capture()).rejects.toBeInstanceOf(GitIntegrityLimitError);
    await expect(reader.readBlob(oid)).rejects.toBeInstanceOf(GitIntegrityLimitError);
  }, 20_000);

  it.each(['self', 'same pack', 'cross pack', 'missing'] as const)('rejects a %s reference-delta dependency failure before invoking Git decoding', async kind => {
    const a = '1'.repeat(40); const b = '2'.repeat(40);
    const delta = Buffer.from([0, 0]);
    const first = { oid: a, content: record(7, delta, delta.length, Buffer.from(kind === 'self' ? a : b, 'hex')) };
    const second = { oid: b, content: record(7, delta, delta.length, Buffer.from(a, 'hex')) };
    if (kind === 'same pack') await binaryPack([first, second]);
    else {
      await binaryPack([first]);
      if (kind === 'cross pack') await binaryPack([second]);
    }
    const raw = vi.spyOn(git, 'readObject');
    const reader = new GitIntegrity(gitdir);
    await expect(reader.capture()).rejects.toMatchObject({ code: 'git_local_corrupt' });
    await expect(reader.inspect(a)).rejects.toMatchObject({ code: 'git_local_corrupt' });
    await expect(reader.readBlob(a)).rejects.toMatchObject({ code: 'git_local_corrupt' });
    expect(raw).not.toHaveBeenCalled();
  });

  it('accepts a real cross-pack reference delta with a present base', async () => {
    const base = Buffer.from('abc');
    const content = Buffer.from('abcd');
    const baseOid = createHash('sha1').update(`blob ${base.length}\0`).update(base).digest('hex');
    const oid = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    const delta = Buffer.from([3, 4, 0x90, 3, 1, 0x64]);
    await binaryPack([{ oid: baseOid, content: record(3, base) }]);
    await binaryPack([{ oid, content: record(7, delta, delta.length, Buffer.from(baseOid, 'hex')) }]);
    const reader = await new GitIntegrity(gitdir).capture();
    expect(Buffer.from((await reader.readBlob(oid)).blob)).toEqual(content);
  });

  it.each([6, 1025])('computes complete delta depth when %i records put already-visited bases first', async count => {
    const entries: { oid: string; content: Buffer }[] = [];
    for (let length = 1; length <= count; length++) {
      const bytes = Buffer.alloc(length, 0x78);
      const oid = createHash('sha1').update(`blob ${length}\0`).update(bytes).digest('hex');
      if (length === 1) entries.push({ oid, content: record(3, bytes) });
      else {
        const sourceLength = length - 1;
        const operation = sourceLength > 255 ? Buffer.from([0xb0, sourceLength % 256, Math.floor(sourceLength / 256)]) : Buffer.from([0x90, sourceLength]);
        const delta = Buffer.concat([variable(sourceLength), variable(length), operation, Buffer.from([1, 0x78])]);
        entries.push({ oid, content: record(7, delta, delta.length, Buffer.from(entries.at(-1)!.oid, 'hex')) });
      }
    }
    await binaryPack(entries);
    const raw = vi.spyOn(git, 'readObject');
    const reader = new GitIntegrity(gitdir);
    if (count > 1024) {
      await expect(reader.capture()).rejects.toMatchObject({ code: 'git_integrity_too_large' });
      expect(raw).not.toHaveBeenCalled();
    } else {
      const captured = await reader.capture();
      expect(Buffer.from((await captured.readBlob(entries.at(-1)!.oid)).blob)).toEqual(Buffer.alloc(count, 0x78));
    }
  });
});
