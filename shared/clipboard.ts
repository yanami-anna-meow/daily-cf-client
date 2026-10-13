import { t } from './i18n';
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;

/** Bound the only clipboard operation exposed to the renderer: writing text. */
export function clipboardText(value: unknown): string {
  if (typeof value !== 'string') throw new Error(t('复制内容必须是文本。'));
  if (value.includes('\0')) throw new Error(t('复制内容包含无效的空字符。'));
  if (value.length > MAX_CLIPBOARD_BYTES || new TextEncoder().encode(value).byteLength > MAX_CLIPBOARD_BYTES) {
    throw new Error(t('复制内容不能超过 1 MiB。'));
  }
  return value;
}
