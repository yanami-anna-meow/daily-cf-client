import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import git, { type PromiseFsClient, type TreeEntry } from 'isomorphic-git';

const OID = /^[0-9a-f]{40}$/;
const MAX_FILES = 1_000_000;
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_STORE_BYTES = 512 * 1024 * 1024;
const MAX_INFLATED_OBJECT_BYTES = 128 * 1024 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const capturedFileSystems = new WeakSet<PromiseFsClient>();

/** Only this error means that the managed public clone can be rebuilt. OS
 * permission, device and capacity failures retain their original identity. */
export class GitIntegrityError extends Error {
  readonly code = 'git_local_corrupt';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GitIntegrityError';
  }
}
export class GitIntegrityLimitError extends Error {
  readonly code = 'git_integrity_too_large';
  constructor(message: string) { super(message); this.name = 'GitIntegrityLimitError'; }
}

export interface IntegrityProof {
  readonly revision: string;
  readonly fingerprint: string;
  readonly fileCount: number;
  readonly objectCount: number;
}
export interface VerifiedCommit { oid: string; commit: { tree: string }; }
export interface VerifiedTree { oid: string; tree: TreeEntry[]; }
export interface VerifiedBlob { oid: string; blob: Uint8Array; }

function corrupt(message: string, cause?: unknown): never {
  throw new GitIntegrityError(message, cause === undefined ? undefined : { cause });
}
function codeOf(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}
function checkOid(oid: string): void {
  if (typeof oid !== 'string' || !OID.test(oid)) corrupt('Invalid Git object identifier.');
}
function sha1(bytes: Uint8Array): string { return createHash('sha1').update(bytes).digest('hex'); }
function gitOid(type: string, bytes: Uint8Array): string {
  return createHash('sha1').update(`${type} ${bytes.byteLength}\0`).update(bytes).digest('hex');
}
function isMissing(error: unknown): boolean { return codeOf(error) === 'ENOENT'; }
function objectFailure(error: unknown): never {
  if (error instanceof GitIntegrityError) throw error;
  const code = codeOf(error);
  // errno failures other than absent/malformed paths must never trigger a
  // destructive repair. Store boundary errors are likewise handled by its owner.
  if ((code?.startsWith('E') && !['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'ERR_OUT_OF_RANGE', 'ERR_BUFFER_OUT_OF_BOUNDS'].includes(code))
    || code === 'git_store_corrupt' || code === 'unsafe_root') throw error;
  if (code && !['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'ERR_OUT_OF_RANGE', 'ERR_BUFFER_OUT_OF_BOUNDS', 'NotFoundError', 'InternalError', 'Z_DATA_ERROR', 'Z_BUF_ERROR'].includes(code)) throw error;
  corrupt('A local Git object is missing or damaged.', error);
}

function parseTree(bytes: Uint8Array): TreeEntry[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: TreeEntry[] = [];
  const names = new Set<string>();
  let cursor = 0;
  while (cursor < buffer.length) {
    const space = buffer.indexOf(0x20, cursor);
    if (space < 0 || space - cursor > 6) corrupt('Malformed Git tree mode.');
    const rawMode = buffer.subarray(cursor, space).toString('utf8');
    const mode = rawMode === '40000' ? '040000' : rawMode;
    if (!['040000', '100644', '100755', '120000', '160000'].includes(mode)) corrupt('Malformed Git tree mode.');
    const end = buffer.indexOf(0, space + 1);
    if (end <= space + 1 || end + 21 > buffer.length) corrupt('Truncated Git tree entry.');
    const name = buffer.subarray(space + 1, end);
    if (name.includes(0x2f) || name.equals(Buffer.from('.')) || name.equals(Buffer.from('..'))) corrupt('Malformed Git tree name.');
    const nameKey = name.toString('hex');
    if (names.has(nameKey)) corrupt('Duplicate Git tree entry.');
    names.add(nameKey);
    entries.push({
      mode, path: name.toString('utf8'), oid: buffer.subarray(end + 1, end + 21).toString('hex'),
      type: mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob',
    });
    cursor = end + 21;
  }
  return entries;
}

interface PackRecord { type: number; oid?: string; baseOid?: string; baseOffset?: number; sourceSize?: number; targetSize: number; }
interface FileSnapshot {
  files: Map<string, Buffer>; directories: Map<string, string[]>; objectIds: Set<string>; fingerprint: string;
  inflatedLooseBytes: number; looseSizes: Map<string, number>;
}

/** Reads raw objects, independently authenticates their bytes by their Git OID,
 * and only then parses those very bytes. In particular, a valid IDX checksum
 * does not prove that an OID points to the correct pack offset. */
export class GitIntegrity {
  private readonly gitdir: string;
  private readonly fs: PromiseFsClient;
  private readonly proofReaders = new WeakMap<IntegrityProof, GitIntegrity>();
  private readonly packedRecords = new Map<string, Map<number, PackRecord>>();

  constructor(gitdir: string, fsClient: PromiseFsClient = fs) {
    this.gitdir = path.resolve(gitdir);
    this.fs = fsClient;
  }

  private async raw(oid: string, type: 'commit' | 'tree' | 'blob', cache?: object, emptyDepth = 0): Promise<Uint8Array> {
    checkOid(oid);
    // Public standalone reads have the same preflight boundary as preview. The
    // normal application path already uses a captured reader, so it pays this
    // disk scan once for the whole operation, not once for every object.
    if (!capturedFileSystems.has(this.fs)) return (await this.capture()).raw(oid, type, cache, emptyDepth);
    // All real IO completed above, outside the dependency's error-swallowing
    // filesystem adapter. Permission/device errors therefore retain their errno.
    try {
      if (oid === EMPTY_TREE && type === 'tree') return await this.readEmptyTree(this.fs, cache, emptyDepth);
      const result = await git.readObject({ fs: this.fs, gitdir: this.gitdir, oid, format: 'content', cache });
      if (result.format !== 'content' || result.type !== type || !(result.object instanceof Uint8Array)) corrupt(`Expected a Git ${type} object.`);
      if (gitOid(result.type, result.object) !== oid) corrupt('Git object content does not match its identifier.');
      return result.object;
    } catch (error) { objectFailure(error); }
  }

  async readCommit(oid: string, cache?: object): Promise<VerifiedCommit> {
    const bytes = await this.raw(oid, 'commit', cache);
    const text = Buffer.from(bytes).toString('utf8');
    const headerEnd = text.indexOf('\n\n');
    if (headerEnd < 0) corrupt('Malformed Git commit header.');
    const headers = text.slice(0, headerEnd).split('\n');
    if (!/^tree [0-9a-f]{40}$/.test(headers[0]) || headers.slice(1).some(line => line.startsWith('tree '))) corrupt('Malformed Git commit tree.');
    return { oid, commit: { tree: headers[0].slice(5) } };
  }

  async readTree(oid: string, cache?: object): Promise<VerifiedTree> {
    return { oid, tree: parseTree(await this.raw(oid, 'tree', cache)) };
  }

  async readBlob(oid: string, cache?: object): Promise<VerifiedBlob> {
    return { oid, blob: await this.raw(oid, 'blob', cache) };
  }

  /** A fresh immutable byte capture for local preview, without claiming that a
   * particular commit's full closure is present. Each subsequent object read
   * still authenticates its own bytes before parsing them. */
  async capture(): Promise<GitIntegrity> {
    return this.captureSnapshot(await this.snapshot());
  }

  reader(proof: IntegrityProof): GitIntegrity {
    const reader = this.proofReaders.get(proof);
    if (!reader) corrupt('This Git integrity proof does not belong to this reader.');
    return reader;
  }

  private captureSnapshot(snapshot: FileSnapshot): GitIntegrity {
    const reader = new GitIntegrity(this.gitdir, this.snapshotFs(snapshot));
    const budget = { bytes: snapshot.inflatedLooseBytes };
    for (const [filename, bytes] of snapshot.files) {
      if (filename.endsWith('.pack')) reader.packedRecords.set(filename, this.checkPackRecords(bytes, budget));
    }
    reader.checkDeltaDependencies(snapshot);
    return reader;
  }

  private checkDeltaDependencies(snapshot: FileSnapshot): void {
    const packs = [...this.packedRecords.keys()].sort();
    const indexes = new Map<string, Map<string, number>>();
    for (const filename of packs) {
      const index = snapshot.files.get(filename.replace(/\.pack$/, '.idx'))!;
      const count = index.readUInt32BE(1028);
      const mapping = new Map<string, number>();
      for (let entry = 0; entry < count; entry++) {
        const offset = index.readUInt32BE(1032 + count * 24 + entry * 4);
        if (!this.packedRecords.get(filename)!.has(offset)) corrupt('A Git index points inside another pack record.');
        mapping.set(index.subarray(1032 + entry * 20, 1052 + entry * 20).toString('hex'), offset);
      }
      indexes.set(filename, mapping);
    }
    interface Node { pack: string; offset: number; record: PackRecord; }
    const nodes = new Map<string, 1 | 2>();
    const depths = new Map<string, number>();
    const node = (pack: string, offset: number): Node => {
      const record = this.packedRecords.get(pack)!.get(offset);
      if (!record) corrupt('A Git delta references a missing pack record.');
      return { pack, offset, record };
    };
    const baseOf = (current: Node): Node | null => {
      const record = current.record;
      if (record.type <= 4) return null;
      let base: Node | undefined;
      if (record.baseOffset !== undefined) base = node(current.pack, record.baseOffset);
      else {
        const oid = record.baseOid!;
        const local = indexes.get(current.pack)!.get(oid);
        if (local !== undefined) base = node(current.pack, local);
        else if (snapshot.looseSizes.has(oid)) {
          if (record.sourceSize !== snapshot.looseSizes.get(oid)) corrupt('A Git delta has the wrong source size.');
          return null;
        } else {
          for (const pack of packs) {
            const offset = indexes.get(pack)!.get(oid);
            if (offset !== undefined) { base = node(pack, offset); break; }
          }
        }
      }
      if (!base) corrupt('A Git reference delta has no local base object.');
      if (record.sourceSize !== base.record.targetSize) corrupt('A Git delta has the wrong source size.');
      return base;
    };
    for (const pack of packs) for (const offset of this.packedRecords.get(pack)!.keys()) {
      let current: Node | null = node(pack, offset);
      const trail: string[] = [];
      let depth = 0;
      while (current) {
        const key = `${current.pack}:${current.offset}`;
        const state = nodes.get(key);
        if (state === 1) corrupt('Git delta dependencies contain a cycle.');
        if (state === 2) { depth = depths.get(key)!; break; }
        nodes.set(key, 1); trail.push(key);
        if (trail.length > 1024) throw new GitIntegrityLimitError('The Git delta chain exceeds its depth limit.');
        current = baseOf(current);
      }
      if (depth + trail.length > 1024) throw new GitIntegrityLimitError('The Git delta chain exceeds its depth limit.');
      for (const key of trail.reverse()) { nodes.set(key, 2); depths.set(key, ++depth); }
    }
  }

  /** Every call reads and hashes actual object files again. No timestamp or
   * length-only shortcut is used. Previous proofs apply only to identical bytes
   * at this exact Git directory and the same complete reachable revision. */
  async inspect(revision: string, prior?: IntegrityProof): Promise<IntegrityProof> {
    checkOid(revision);
    const snapshot = await this.snapshot();
    if (prior && this.proofReaders.has(prior) && prior.revision === revision && prior.fingerprint === snapshot.fingerprint) return prior;

    // Validate against the captured bytes, rather than re-reading mutable files
    // after fingerprinting them. This also avoids filesystem calls per object.
    const reader = this.captureSnapshot(snapshot);
    const cache = {};
    const commit = await reader.readCommit(revision, cache);
    if (!snapshot.objectIds.has(revision)) corrupt('The current Git commit is missing.');
    const pending: { oid: string; type: 'tree' | 'blob' }[] = [{ oid: commit.commit.tree, type: 'tree' }];
    const visited = new Map<string, 'tree' | 'blob'>();
    while (pending.length) {
      const item = pending.pop()!;
      const previous = visited.get(item.oid);
      if (previous) { if (previous !== item.type) corrupt('Inconsistent Git object type in tree.'); continue; }
      visited.set(item.oid, item.type);
      if (visited.size > MAX_FILES) throw new GitIntegrityLimitError('The local Git tree exceeds its object limit.');
      if (!snapshot.objectIds.has(item.oid)) corrupt('A reachable Git object is missing.');
      if (item.type === 'blob') await reader.readBlob(item.oid, cache);
      else {
        for (const entry of (await reader.readTree(item.oid, cache)).tree) {
          // A gitlink points into another repository, but symlinks are ordinary
          // blob objects and must exist even though the application never follows them.
          if (entry.type !== 'commit') pending.push({ oid: entry.oid, type: entry.type });
        }
      }
    }
    const proof: IntegrityProof = Object.freeze({ revision, fingerprint: snapshot.fingerprint, fileCount: snapshot.files.size, objectCount: visited.size + 1 });
    this.proofReaders.set(proof, reader);
    return proof;
  }

  private async snapshot(): Promise<FileSnapshot> {
    const files = new Map<string, Buffer>();
    const directories = new Map<string, string[]>();
    const fingerprint = createHash('sha256');
    const packs = new Map<string, Buffer>();
    const indexes = new Map<string, Buffer>();
    const objectIds = new Set<string>();
    const looseSizes = new Map<string, number>();
    let totalBytes = 0;
    let inflatedLooseBytes = 0;
    const objects = path.join(this.gitdir, 'objects');
    const io = this.fs.promises;
    const directory = async (target: string, optional = false): Promise<string[]> => {
      let stat: fs.Stats;
      try { stat = await io.lstat(target); }
      catch (error) { if (optional && isMissing(error)) return []; objectFailure(error); }
      if (stat.isSymbolicLink() || !stat.isDirectory()) corrupt('Git object directory is not an ordinary directory.');
      const names: string[] = await io.readdir(target);
      if (names.length > MAX_FILES) throw new GitIntegrityLimitError('Too many local Git directory entries.');
      names.sort();
      if (names.some(name => !name || name === '.' || name === '..' || /[\/\\\0]/.test(name))) corrupt('Invalid Git object directory entry.');
      directories.set(target, names);
      return names;
    };
    const file = async (target: string): Promise<Buffer> => {
      const stat: fs.Stats = await io.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) corrupt('Git object is not an ordinary private file.');
      if (stat.size > MAX_OBJECT_BYTES || totalBytes + stat.size > MAX_STORE_BYTES) throw new GitIntegrityLimitError('The local Git object store exceeds its 512 MiB inspection limit.');
      totalBytes += stat.size;
      const bytes = Buffer.from(await io.readFile(target));
      if (bytes.length !== stat.size) corrupt('Git object changed while it was being inspected.');
      files.set(target, bytes);
      if (files.size > MAX_FILES) throw new GitIntegrityLimitError('Too many local Git object files.');
      const name = path.relative(objects, target).split(path.sep).join('/');
      fingerprint.update(`${name.length}:${name}:${bytes.length}:`).update(createHash('sha256').update(bytes).digest());
      return bytes;
    };
    try {
      await directory(this.gitdir);
      const names = await directory(objects);
      for (const name of names) {
        const target = path.join(objects, name);
        if (name === 'pack') {
          for (const packed of await directory(target)) {
            const match = /^pack-([0-9a-f]{40})\.(pack|idx)$/.exec(packed);
            if (!match) corrupt('Unrecognized local Git pack file.');
            const bytes = await file(path.join(target, packed));
            (match[2] === 'pack' ? packs : indexes).set(match[1], bytes);
          }
        } else if (name === 'info') {
          // An object store produced by this client has no alternates. Following
          // an alternates file would make the clone's trust boundary unbounded.
          if ((await directory(target)).length) corrupt('Unexpected local Git object metadata.');
        } else if (/^[0-9a-f]{2}$/.test(name)) {
          for (const loose of await directory(target)) {
            if (!/^[0-9a-f]{38}$/.test(loose)) corrupt('Unrecognized loose Git object file.');
            const bytes = await file(path.join(target, loose));
            const size = this.verifyLoose(`${name}${loose}`, bytes);
            inflatedLooseBytes += size;
            looseSizes.set(`${name}${loose}`, size);
            if (inflatedLooseBytes > MAX_STORE_BYTES) throw new GitIntegrityLimitError('The expanded Git object store exceeds its 512 MiB limit.');
            objectIds.add(`${name}${loose}`);
          }
        } else corrupt('Unrecognized Git object storage entry.');
      }
      if (packs.size !== indexes.size || [...packs.keys()].some(oid => !indexes.has(oid))) corrupt('A local Git pack or its index is missing.');
      for (const [oid, pack] of packs) this.verifyPack(oid, pack, indexes.get(oid)!, objectIds);
      return { files, directories, objectIds, inflatedLooseBytes, looseSizes, fingerprint: fingerprint.digest('hex') };
    } catch (error) { objectFailure(error); }
  }

  private verifyLoose(oid: string, bytes: Buffer): number {
    let wrapped: Buffer;
    try { wrapped = inflateSync(bytes, { maxOutputLength: MAX_INFLATED_OBJECT_BYTES }); }
    catch (error) {
      if (codeOf(error) === 'ERR_BUFFER_TOO_LARGE') throw new GitIntegrityLimitError('An expanded Git object exceeds its 128 MiB limit.');
      corrupt('A loose Git object cannot be decompressed.', error);
    }
    const zero = wrapped.indexOf(0);
    const match = /^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(wrapped.subarray(0, zero < 0 ? 0 : zero).toString('utf8'));
    if (!match || Number(match[2]) !== wrapped.length - zero - 1 || sha1(wrapped) !== oid) corrupt('A loose Git object is malformed or has the wrong identifier.');
    return wrapped.length - zero - 1;
  }

  /** Preflight compressed records before the dependency can inflate or apply
   * their deltas. No decompressed contents are retained by this pass. */
  private checkPackRecords(pack: Buffer, budget: { bytes: number }): Map<number, PackRecord> {
    if (pack.length < 32 || !pack.subarray(0, 4).equals(Buffer.from('PACK')) || ![2, 3].includes(pack.readUInt32BE(4))) corrupt('Malformed Git pack header.');
    const count = pack.readUInt32BE(8);
    if (count > MAX_FILES) throw new GitIntegrityLimitError('The Git pack exceeds its object limit.');
    const end = pack.length - 20;
    const records = new Map<number, PackRecord>();
    let cursor = 12;
    const next = () => { if (cursor >= end) corrupt('Truncated Git pack record.'); return pack[cursor++]; };
    const bounded = (size: number) => {
      if (!Number.isSafeInteger(size) || size > MAX_INFLATED_OBJECT_BYTES) throw new GitIntegrityLimitError('An expanded Git object exceeds its 128 MiB limit.');
      return size;
    };
    for (let object = 0; object < count; object++) {
      const offset = cursor;
      let byte = next();
      const type = (byte >> 4) & 7;
      if (![1, 2, 3, 4, 6, 7].includes(type)) corrupt('Invalid Git pack record type.');
      let size = byte & 15; let factor = 16;
      while (byte & 0x80) { byte = next(); size = bounded(size + (byte & 127) * factor); factor *= 128; }
      const record: PackRecord = { type, targetSize: size };
      if (type === 6) {
        byte = next(); let distance = byte & 127;
        while (byte & 0x80) {
          byte = next(); distance = (distance + 1) * 128 + (byte & 127);
          if (!Number.isSafeInteger(distance) || distance > offset) corrupt('Invalid Git offset delta base.');
        }
        record.baseOffset = offset - distance;
        if (!distance || !records.has(record.baseOffset)) corrupt('Missing Git offset delta base.');
      } else if (type === 7) {
        if (cursor + 20 > end) corrupt('Truncated Git reference delta base.');
        record.baseOid = pack.subarray(cursor, cursor + 20).toString('hex'); cursor += 20;
      }
      let result: { buffer: Buffer; engine: { bytesWritten: number } };
      try {
        result = inflateSync(pack.subarray(cursor, end), { maxOutputLength: MAX_INFLATED_OBJECT_BYTES, info: true }) as unknown as typeof result;
      } catch (error) {
        if (codeOf(error) === 'ERR_BUFFER_TOO_LARGE') throw new GitIntegrityLimitError('An expanded Git object exceeds its 128 MiB limit.');
        corrupt('A Git pack record cannot be decompressed.', error);
      }
      if (result.buffer.length !== size || !result.engine.bytesWritten) corrupt('Git pack record length does not match its header.');
      cursor += result.engine.bytesWritten;
      if (cursor > end) corrupt('Truncated Git pack compressed data.');
      if (type <= 4) record.oid = gitOid(['', 'commit', 'tree', 'blob', 'tag'][type], result.buffer);
      else {
        const delta = result.buffer;
        let position = 0;
        const deltaByte = () => { if (position >= delta.length) corrupt('Truncated Git delta.'); return delta[position++]; };
        const number = () => {
          let value = 0; let multiplier = 1; let digit: number;
          do { digit = deltaByte(); value = bounded(value + (digit & 127) * multiplier); multiplier *= 128; } while (digit & 128);
          return value;
        };
        record.sourceSize = number(); record.targetSize = number();
        let produced = 0;
        while (position < delta.length) {
          const operation = deltaByte();
          if (operation & 128) {
            let start = 0; let length = 0;
            for (let part = 0; part < 4; part++) if (operation & (1 << part)) start += deltaByte() * 2 ** (part * 8);
            for (let part = 0; part < 3; part++) if (operation & (16 << part)) length += deltaByte() * 2 ** (part * 8);
            if (!length) length = 0x10000;
            if (start + length > record.sourceSize) corrupt('Git delta copies outside its source.');
            produced += length;
          } else {
            if (!operation || position + operation > delta.length) corrupt('Malformed Git delta insertion.');
            position += operation; produced += operation;
          }
          if (produced > record.targetSize) corrupt('Git delta exceeds its declared result.');
        }
        if (produced !== record.targetSize) corrupt('Git delta result length is inconsistent.');
      }
      budget.bytes += Math.max(size, record.targetSize);
      if (budget.bytes > MAX_STORE_BYTES) throw new GitIntegrityLimitError('The expanded Git object store exceeds its 512 MiB limit.');
      records.set(offset, record);
    }
    if (cursor !== end) corrupt('Git pack count does not cover its complete payload.');
    return records;
  }

  private async readEmptyTree(io: PromiseFsClient, cache: object | undefined, depth: number): Promise<Uint8Array> {
    const loose = path.join(this.gitdir, 'objects', EMPTY_TREE.slice(0, 2), EMPTY_TREE.slice(2));
    try {
      const bytes = Buffer.from(await io.promises.readFile(loose));
      this.verifyLoose(EMPTY_TREE, bytes);
      return Buffer.alloc(0);
    } catch (error) { if (!isMissing(error)) throw error; }
    if (depth > 0) corrupt('A Git empty-tree delta depends on itself.');
    const directory = path.join(this.gitdir, 'objects', 'pack');
    let names: string[];
    try { names = await io.promises.readdir(directory); }
    catch (error) { if (isMissing(error)) corrupt('The empty Git tree is missing.'); throw error; }
    for (const name of names.filter(name => name.endsWith('.idx')).sort()) {
      const indexPath = path.join(directory, name);
      const index = Buffer.from(await io.promises.readFile(indexPath));
      if (index.length < 1072 || index.readUInt32BE(0) !== 0xff744f63 || index.readUInt32BE(4) !== 2) corrupt('Malformed Git pack index.');
      const count = index.readUInt32BE(1028);
      if (index.length !== 1072 + count * 28) corrupt('Truncated Git pack index.');
      let position = -1;
      for (let entry = 0; entry < count; entry++) if (index.subarray(1032 + entry * 20, 1052 + entry * 20).toString('hex') === EMPTY_TREE) { position = entry; break; }
      if (position < 0) continue;
      const packPath = indexPath.replace(/\.idx$/, '.pack');
      const pack = Buffer.from(await io.promises.readFile(packPath));
      const match = /^pack-([0-9a-f]{40})\.idx$/.exec(name);
      if (!match) corrupt('Malformed Git pack name.');
      this.verifyPack(match[1], pack, index, new Set());
      const records = this.packedRecords.get(path.resolve(packPath)) ?? this.checkPackRecords(pack, { bytes: 0 });
      const offset = index.readUInt32BE(1032 + count * 24 + position * 4);
      const record = records.get(offset);
      if (!record || record.targetSize !== 0) corrupt('The indexed empty Git tree is not empty.');
      if (record.type <= 4) {
        if (record.type !== 2 || record.oid !== EMPTY_TREE) corrupt('The empty Git tree index points to a different object.');
      } else {
        let base = record.baseOid;
        if (base === undefined) {
          for (let entry = 0; entry < count; entry++) {
            if (index.readUInt32BE(1032 + count * 24 + entry * 4) === record.baseOffset) base = index.subarray(1032 + entry * 20, 1052 + entry * 20).toString('hex');
          }
        }
        if (!base) corrupt('The empty Git tree delta has no base.');
        if ((await this.raw(base, 'tree', cache, depth + 1)).length !== record.sourceSize) corrupt('The empty Git tree delta has an inconsistent base.');
      }
      return Buffer.alloc(0);
    }
    corrupt('The empty Git tree is missing.');
  }

  private verifyPack(oid: string, pack: Buffer, index: Buffer, objectIds: Set<string>): void {
    if (pack.length < 32 || !pack.subarray(0, 4).equals(Buffer.from('PACK'))
      || ![2, 3].includes(pack.readUInt32BE(4)) || pack.subarray(-20).toString('hex') !== oid || sha1(pack.subarray(0, -20)) !== oid) corrupt('A local Git pack is damaged.');
    if (index.length < 1072 || index.readUInt32BE(0) !== 0xff744f63 || index.readUInt32BE(4) !== 2
      || !index.subarray(-20).equals(createHash('sha1').update(index.subarray(0, -20)).digest())
      || index.subarray(-40, -20).toString('hex') !== oid) corrupt('A local Git pack index is damaged.');
    const count = index.readUInt32BE(1028);
    if (count !== pack.readUInt32BE(8)) corrupt('A local Git pack index has an invalid object count.');
    if (count > MAX_FILES) throw new GitIntegrityLimitError('The local Git pack exceeds its object limit.');
    const fixedSize = 1072 + count * 28;
    if (index.length < fixedSize || (index.length - fixedSize) % 8 !== 0) corrupt('A local Git pack index is truncated.');
    const largeCount = (index.length - fixedSize) / 8;
    // This clone never downloads packs large enough to need extended offsets,
    // and the installed isomorphic-git reader does not implement this table.
    if (largeCount) corrupt('The local Git index uses unsupported extended offsets.');
    const offsets = new Set<number>();
    const fanout = Array<number>(256).fill(0);
    let previous: Buffer | undefined;
    for (let position = 0; position < count; position++) {
      const hash = index.subarray(1032 + position * 20, 1052 + position * 20);
      if (previous && Buffer.compare(previous, hash) >= 0) corrupt('A local Git index has unsorted or duplicate identifiers.');
      previous = hash;
      objectIds.add(hash.toString('hex'));
      if (objectIds.size > MAX_FILES) throw new GitIntegrityLimitError('The local Git object store exceeds its object limit.');
      fanout[hash[0]]++;
      const offset = index.readUInt32BE(1032 + count * 24 + position * 4);
      if (offset >= 0x80000000) {
        corrupt('The local Git index uses unsupported extended offsets.');
      }
      if (offset < 12 || offset >= pack.length - 20 || offsets.has(offset)) corrupt('A local Git index points outside its pack or duplicates an offset.');
      offsets.add(offset);
    }
    let total = 0;
    for (let bucket = 0; bucket < 256; bucket++) {
      total += fanout[bucket];
      if (index.readUInt32BE(8 + bucket * 4) !== total) corrupt('A local Git pack index has an invalid fanout table.');
    }
  }

  private snapshotFs(snapshot: FileSnapshot): PromiseFsClient {
    const missing = (): never => { throw Object.assign(new Error('Object is absent from the captured Git store.'), { code: 'ENOENT' }); };
    const unsupported = async (): Promise<never> => { throw new Error('The captured Git object store is read only.'); };
    const captured: PromiseFsClient = { promises: {
      readFile: async (name: string) => snapshot.files.get(path.resolve(name)) ?? missing(),
      readdir: async (name: string) => [...(snapshot.directories.get(path.resolve(name)) ?? [])],
      lstat: unsupported, stat: unsupported, writeFile: unsupported, unlink: unsupported, mkdir: unsupported, rmdir: unsupported,
      readlink: unsupported, symlink: unsupported,
    } };
    capturedFileSystems.add(captured);
    return captured;
  }
}
