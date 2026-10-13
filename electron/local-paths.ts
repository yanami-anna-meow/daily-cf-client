import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { LocalPaths } from '../shared/types';
import { t } from '../shared/i18n';

interface LocalPathShell {
  showItemInFolder(path: string): void;
  openPath(path: string): Promise<string>;
}

export function getLocalPaths(directory: string): LocalPaths {
  const dataDirectory = resolve(directory);
  return { configFile: join(dataDirectory, 'data.json'), dataDirectory };
}

/** Only fixed application locations may cross this IPC boundary. Opening never saves settings. */
export async function openLocalPath(directory: string, target: unknown, shell: LocalPathShell): Promise<void> {
  if (target !== 'config' && target !== 'data') throw new Error(t('本地路径选项无效。'));
  const paths = getLocalPaths(directory);
  if (target === 'config') {
    let exists = false;
    try {
      const info = await stat(paths.configFile);
      if (!info.isFile()) throw new Error(t('配置文件路径不是普通文件。'));
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (exists) {
      shell.showItemInFolder(paths.configFile);
      return;
    }
  }
  const error = await shell.openPath(paths.dataDirectory);
  if (error) throw new Error(t('无法打开文件夹：{{message}}', { message: error }));
}
