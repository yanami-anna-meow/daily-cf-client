import { LANGUAGES, type BatchSubmissionInput, type ColorPalette, type ThemeColors, type Settings, type SubmissionInput } from '../shared/types';
import { submissionPath, validateSubmission } from '../shared/domain';
import { t } from '../shared/i18n';
import { createDefaultPalettes, normalizeColorHex, resolveAccentColor } from '../shared/appearance';
export function text(value: unknown, name: string, maximum = 1024): string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error(t('{{name}}格式不正确或内容过长。', { name: t(name) }));
  return value;
}
function paletteInput(value: unknown): ColorPalette {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('配色方案设置不正确。'));
  const palette = value as Record<string, unknown>;
  if (typeof palette.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(palette.id)) throw new Error(t('配色方案编号须为 1 至 128 个英文字母、数字、下划线或连字符。'));
  if (typeof palette.name !== 'string' || !palette.name.trim() || palette.name.trim().length > 80) throw new Error(t('配色方案名称须为 1 至 80 个字符。'));
  const themeColors = (value: unknown): ThemeColors => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('配色方案颜色设置不正确。'));
    const source = value as Record<string, unknown>;
    const colors = {} as ThemeColors;
    for (const key of ['primary', 'background', 'surface', 'text'] as const) {
      const color = normalizeColorHex(source[key]);
      if (!color) throw new Error(t('配色方案颜色设置不正确。'));
      colors[key] = color;
    }
    const accent = source.accent === undefined ? resolveAccentColor(colors) : normalizeColorHex(source.accent);
    if (!accent) throw new Error(t('配色方案颜色设置不正确。'));
    colors.accent = accent;
    return colors;
  };
  return { id: palette.id, name: palette.name.trim(), light: themeColors(palette.light), dark: themeColors(palette.dark) };
}
export function settingsInput(value: unknown): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('设置格式不正确。'));
  const v = value as Settings;
  const clientId = text(v.clientId, 'Client ID', 120).trim();
  if (clientId && !/^[A-Za-z0-9_.-]+$/.test(clientId)) throw new Error(t('Client ID 仅包含字母、数字、下划线、点或连字符。'));
  if (!LANGUAGES.some(x => x.id === v.language) || !['light', 'dark', 'system'].includes(v.theme)) throw new Error(t('语言或主题设置不正确。'));
  const uiLanguage = v.uiLanguage === undefined ? 'system' : v.uiLanguage;
  if (!['system', 'zh-CN', 'en'].includes(uiLanguage)) throw new Error(t('界面语言设置不正确。'));
  const sourcePalettes = v.palettes === undefined ? createDefaultPalettes(uiLanguage === 'system' ? undefined : uiLanguage) : v.palettes;
  if (!Array.isArray(sourcePalettes) || sourcePalettes.length < 1 || sourcePalettes.length > 100) throw new Error(t('配色方案列表须包含 1 至 100 个方案。'));
  const palettes = Array.from(sourcePalettes, paletteInput);
  if (new Set(palettes.map(palette => palette.id)).size !== palettes.length) throw new Error(t('配色方案编号不能重复。'));
  const paletteId = v.paletteId === undefined ? palettes[0].id : v.paletteId;
  if (!palettes.some(palette => palette.id === paletteId)) throw new Error(t('请选择列表中的配色方案。'));
  const extra: Pick<Settings, 'forkRepository' | 'prTitleTemplate' | 'prBodyTemplate'> = {};
  if (v.forkRepository !== undefined) {
    extra.forkRepository = text(v.forkRepository, 'Fork 仓库', 160).trim();
    if (extra.forkRepository && !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(extra.forkRepository)) throw new Error(t('Fork 仓库请使用 owner/repository 格式。'));
  }
  if (v.prTitleTemplate !== undefined) extra.prTitleTemplate = text(v.prTitleTemplate, 'PR 标题模板', 2000);
  if (v.prBodyTemplate !== undefined) extra.prBodyTemplate = text(v.prBodyTemplate, 'PR 正文模板', 60000);
  return { clientId, language: v.language, uiLanguage, theme: v.theme, palettes, paletteId, ...extra };
}

/** Startup-only recovery; save paths must use the strict settingsInput boundary. */
export function storedSettingsInput(value: unknown): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return settingsInput(value);
  const saved = value as Settings;
  const palettes: ColorPalette[] = [];
  const seen = new Set<string>();
  if (Array.isArray(saved.palettes)) {
    for (const value of saved.palettes) {
      try {
        const palette = paletteInput(value);
        if (seen.has(palette.id)) continue;
        seen.add(palette.id);
        palettes.push(palette);
        if (palettes.length === 100) break;
      } catch { /* Preserve the other valid palettes when one entry is damaged. */ }
    }
  }
  if (!palettes.length) palettes.push(...createDefaultPalettes(saved.uiLanguage === 'en' || saved.uiLanguage === 'zh-CN' ? saved.uiLanguage : undefined));
  const paletteId = palettes.some(palette => palette.id === saved.paletteId) ? saved.paletteId : palettes[0].id;
  return settingsInput({ ...saved, palettes, paletteId });
}

export function batchSubmissionInput(value: unknown): BatchSubmissionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('批量提交内容无效。'));
  const input = value as Partial<BatchSubmissionInput>;
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) {
    throw new Error(t('每次批量提交须包含 1 至 50 份解答。'));
  }
  if (typeof input.notes !== 'string') throw new Error(t('批量提交说明必须是文本。'));
  const notes = text(input.notes.trim(), '批量提交说明', 2000);
  const extra: Pick<BatchSubmissionInput, 'target' | 'requestId' | 'overwrites'> = { requestId: '' };
  if (input.target !== undefined) {
    const target = input.target;
    if (!target || typeof target !== 'object' || Array.isArray(target) || target.kind !== 'new') {
      throw new Error(t('客户端仅支持创建新 Pull Request，请从提交列表重新预览。'));
    }
    extra.target = { kind: 'new' };
  }
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(input.requestId)) {
    throw new Error(t('提交请求编号须为 16 至 80 个英文字母、数字、下划线或连字符。'));
  }
  extra.requestId = input.requestId;
  const items: SubmissionInput[] = [];
  const paths = new Set<string>();
  const encoder = new TextEncoder();
  let bytes = 0;
  for (let index = 0; index < input.items.length; index++) {
    let item: SubmissionInput;
    try { item = validateSubmission(input.items[index]); }
    catch (error) {
      throw new Error(t('第 {{index}} 份解答：{{message}}', { index: index + 1, message: error instanceof Error ? error.message : t('提交内容无效。') }));
    }
    const path = submissionPath(item);
    if (paths.has(path)) throw new Error(t('第 {{index}} 份解答与前面的文件路径重复，请移除重复文件：{{path}}', { index: index + 1, path }));
    paths.add(path);
    bytes += encoder.encode(item.code).byteLength;
    if (bytes > 5 * 1024 * 1024) throw new Error(t('批量提交的代码总大小不能超过 5 MiB。'));
    items.push(item);
  }
  if (input.overwrites !== undefined) {
    if (!Array.isArray(input.overwrites) || input.overwrites.length > 50) throw new Error(t('覆盖确认列表格式不正确或超过 50 个文件。'));
    const confirmed = new Set<string>();
    extra.overwrites = [];
    for (const entry of input.overwrites) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.path !== 'string' || !paths.has(entry.path)) {
        throw new Error(t('覆盖确认路径必须是本次提交的规范文件路径。'));
      }
      if (confirmed.has(entry.path)) throw new Error(t('覆盖确认列表不能包含重复文件路径。'));
      if (typeof entry.sha !== 'string' || !/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/.test(entry.sha)) {
        throw new Error(t('覆盖确认的文件版本无效，请重新预览后确认。'));
      }
      confirmed.add(entry.path);
      extra.overwrites.push({ path: entry.path, sha: entry.sha.toLowerCase() });
    }
  }
  return { items, notes, ...extra };
}

export function safeExternal(value: unknown): string {
  const raw = text(value, '链接', 2048);
  const url = new URL(raw);
  const allowedProtocol = url.protocol === 'https:' || (url.protocol === 'http:' && ['codeforces.com', 'www.codeforces.com'].includes(url.hostname));
  if (!allowedProtocol || /[\u0000-\u0020\u007f\\]/.test(raw) || url.username || url.password || url.port || !['github.com', 'codeforces.com', 'www.codeforces.com', 'espresso.codeforces.com', 'yawn-sean.github.io', 'docs.github.com'].includes(url.hostname)) throw new Error(t('只允许打开 GitHub 和 Codeforces 的安全链接。'));
  return raw;
}

