import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { importExtension, languageForExtension } from '../shared/file-formats';
import { t } from '../shared/i18n';

/** Read the file chosen in the native dialog without replacing its actual suffix. */
export async function readCodeFile(path: string) {
  if ((await stat(path)).size > 256 * 1024) throw new Error(t('代码文件不能超过 256 KiB。'));
  const bytes = await readFile(path);
  let code: string;
  try {
    // Reject malformed bytes instead of silently replacing the user's source.
    // Keep a UTF-8 BOM here; the submission normalizer handles it explicitly.
    code = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(t('代码文件不是有效的 UTF-8 文本，请转换为 UTF-8 后重新导入。'));
  }
  if (code.includes('\0')) throw new Error(t('请选择 UTF-8 文本代码文件。'));
  const name = basename(path);
  const extension = importExtension(name);
  return { name, code, extension, language: languageForExtension(extension) };
}
