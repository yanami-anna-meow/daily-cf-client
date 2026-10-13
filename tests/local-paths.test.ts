import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { getLocalPaths, openLocalPath } from '../electron/local-paths';
import { setLocale } from '../shared/i18n';

describe('application local paths', () => {
  let directory: string;
  let shell: { showItemInFolder: ReturnType<typeof vi.fn<(path: string) => void>>; openPath: ReturnType<typeof vi.fn<(path: string) => Promise<string>>> };
  beforeEach(async () => {
    setLocale('zh-CN');
    directory = await mkdtemp(join(tmpdir(), 'daily-cf-local-paths-'));
    shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') };
  });
  afterEach(async () => {
    const target = resolve(directory);
    if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(target).startsWith('daily-cf-local-paths-')) {
      throw new Error('Unexpected local-path test cleanup path');
    }
    await rm(target, { recursive: true, force: true });
  });

  it('shows the containing data directory on first run without creating a config file', async () => {
    const paths = getLocalPaths(directory);
    expect(paths).toEqual({ configFile: join(directory, 'data.json'), dataDirectory: directory });
    await openLocalPath(directory, 'config', shell);
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(directory);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it('reveals the existing config without parsing, replacing or saving its manually edited contents', async () => {
    const path = join(directory, 'data.json');
    const manuallyEdited = '{ "settings": { "paletteId": "my-pink" }, "stillEditing":';
    await writeFile(path, manuallyEdited);
    await openLocalPath(directory, 'config', shell);
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(path);
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(manuallyEdited);
    expect(await readdir(directory)).toEqual(['data.json']);
  });

  it('opens the data root containing both settings and the local library', async () => {
    await mkdir(join(directory, 'library.git'));
    await writeFile(join(directory, 'data.json'), '{}');
    await openLocalPath(directory, 'data', shell);
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(directory);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect((await readdir(directory)).sort()).toEqual(['data.json', 'library.git']);
  });

  it.each([undefined, null, '', 'config/data', '../data.json', 'C:\\Windows', 'https://example.com', 1, {}, ['config']])(
    'rejects an arbitrary or malformed target before calling the OS: %j', async target => {
      await expect(openLocalPath(directory, target, shell)).rejects.toThrow('本地路径选项无效');
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    },
  );

  it('reports a config path occupied by a directory instead of launching it as a file', async () => {
    await mkdir(join(directory, 'data.json'));
    await expect(openLocalPath(directory, 'config', shell)).rejects.toThrow('配置文件路径不是普通文件');
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it.each(['config', 'data'] as const)('surfaces an OS directory-opening error for %s', async target => {
    shell.openPath.mockResolvedValue('No file manager available');
    await expect(openLocalPath(directory, target, shell)).rejects.toThrow('No file manager available');
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it('propagates a file-reveal exception without changing the config', async () => {
    const path = join(directory, 'data.json');
    await writeFile(path, 'preserve me');
    shell.showItemInFolder.mockImplementation(() => { throw new Error('File manager failed'); });
    await expect(openLocalPath(directory, 'config', shell)).rejects.toThrow('File manager failed');
    expect(await readFile(path, 'utf8')).toBe('preserve me');
  });
});
