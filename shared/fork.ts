import { t } from './i18n';
/** The creation form and main-process boundary must agree on the exact target name. */
export function validateForkName(value: unknown): string {
  if (typeof value !== 'string') throw new Error(t('请输入新 Fork 的仓库名。'));
  const name = value.trim();
  if (!name || name.length > 100) throw new Error(t('仓库名需要 1 至 100 个字符。'));
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(t('仓库名只能包含英文字母、数字、点、下划线和连字符，请勿填写账号或完整地址。'));
  }
  if (/\.git$/i.test(name)) throw new Error(t('请使用不以 .git 结尾的仓库名。'));
  return name;
}
