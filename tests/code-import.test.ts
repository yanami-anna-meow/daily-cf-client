import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { readCodeFile } from '../electron/code-import';

describe('native code file import', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'daily-cf-code-import-')); });
  afterEach(async () => {
    const target = resolve(directory);
    if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(target).startsWith('daily-cf-code-import-')) throw new Error('Unexpected import-test cleanup path');
    await rm(target, { recursive: true, force: true });
  });

  it.each([
    ['solution.c', 'c', 'c'], ['solution.C', 'C', 'cpp'], ['solution.cc', 'cc', 'cpp'],
    ['solution.cxx', 'cxx', 'cpp'], ['solution.c++', 'c++', 'cpp'], ['solution.CPP', 'CPP', 'cpp'],
    ['solution.d.ts', 'd.ts', 'other'], ['solution.private-code', 'private-code', 'other'],
    ['solution.part.unknown', 'unknown', 'other'], ['solution', '', 'other'],
  ])('imports %s without replacing its actual suffix', async (name, extension, language) => {
    const code = '\uFEFF// User source\r\nint main() {}';
    const path = join(directory, name);
    await writeFile(path, code);
    await expect(readCodeFile(path)).resolves.toEqual({ name, code, extension, language });
  });

  it('retains the existing 256 KiB limit and rejects binary files even with a known extension', async () => {
    const path = join(directory, 'solution.c');
    await writeFile(path, 'x'.repeat(256 * 1024));
    expect((await readCodeFile(path)).code.length).toBe(256 * 1024);
    await writeFile(path, 'x'.repeat(256 * 1024 + 1));
    await expect(readCodeFile(path)).rejects.toThrow('256 KiB');
    await writeFile(path, Buffer.from([0x41, 0, 0x42]));
    await expect(readCodeFile(path)).rejects.toThrow('UTF-8');
  });

  it.each([
    [0x2f, 0x2f, 0x20, 0x80],
    [0x2f, 0x2f, 0x20, 0xc3, 0x28],
    [0x2f, 0x2f, 0x20, 0xe2, 0x82],
  ])('rejects malformed UTF-8 bytes rather than importing replacement characters: %j', async (...bytes) => {
    const path = join(directory, 'solution.c');
    await writeFile(path, Buffer.from(bytes));
    await expect(readCodeFile(path)).rejects.toThrow('代码文件不是有效的 UTF-8 文本');
  });

  it('preserves a legitimately encoded replacement character rather than rejecting it as invalid bytes', async () => {
    const path = join(directory, 'solution.c');
    const code = '\uFEFF// Valid Unicode: \uFFFD 汉字\r\nint main() {}';
    await writeFile(path, Buffer.from(code, 'utf8'));
    await expect(readCodeFile(path)).resolves.toMatchObject({ code, extension: 'c', language: 'c' });
  });
});
