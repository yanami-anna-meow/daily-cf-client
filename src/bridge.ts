import { ProblemLibrary } from '../electron/library';
import { safeExternal, settingsInput, storedSettingsInput } from '../electron/guards';
import { parseProblems, repositoryDatePath, validateDate, PARSER_VERSION } from '../shared/domain';
import { UPSTREAM, type ClientAPI, type Settings } from '../shared/types';
import { copyBrowserText } from './browser-clipboard';
import { readProblemDay } from '../shared/day-service';
import { isLegacyRemoteDataKey } from '../shared/legacy-remote-data';
import { setLocale, t } from '../shared/i18n';

// Browser builds are a read-only preview. Credentials and remote writes require Electron.
const key = `daily-cf-preview:${UPSTREAM.owner}/${UPSTREAM.repo}:`;
function read<T>(name: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key + name) || 'null') ?? fallback; } catch { return fallback; } }
function write(name: string, value: unknown) { localStorage.setItem(key + name, JSON.stringify(value)); }
try {
  const obsolete: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const name = localStorage.key(index);
    if (name?.startsWith(key) && isLegacyRemoteDataKey(name.slice(key.length))) obsolete.push(name);
  }
  for (const name of obsolete) {
    try { localStorage.removeItem(name); } catch { /* Other obsolete keys can still be removed. */ }
  }
} catch { /* Unavailable browser storage never prevents fresh remote reads. */ }
const library = new ProblemLibrary();
const desktopOnly = async (): Promise<never> => { throw new Error(t('请在桌面客户端中登录并提交。浏览器预览只支持公开题库。')); };
const systemLanguages = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? Array.from(navigator.languages) : [navigator.language];
if (!window.dailyCF) setLocale('system', systemLanguages);
const defaults: Settings = settingsInput({ clientId: '', language: 'cpp', uiLanguage: 'system', theme: 'light' });
const savedSettings = read<unknown>('settings', null);
let settings = defaults;
if (savedSettings && typeof savedSettings === 'object' && !Array.isArray(savedSettings)) {
  const saved = savedSettings as Partial<Settings>;
  try { settings = storedSettingsInput({ ...defaults, ...saved, palettes: saved.palettes, paletteId: saved.paletteId }); } catch { /* Other invalid preview settings use defaults. */ }
  if (Object.prototype.hasOwnProperty.call(savedSettings, 'author')) {
    try { write('settings', settings); } catch { /* Keep the in-memory settings normalized if storage is unavailable. */ }
  }
}
if (!window.dailyCF) setLocale(settings.uiLanguage ?? 'system', systemLanguages);
async function raw(path: string): Promise<string> {
  const response = await fetch(`https://raw.githubusercontent.com/${UPSTREAM.owner}/${UPSTREAM.repo}/HEAD/${path}`, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
  if (!response.ok) throw Object.assign(new Error(t('题库读取失败（HTTP {{status}}），请检查网络后重试。', { status: response.status })), { status: response.status });
  return response.text();
}
const getDay: ClientAPI['getDay'] = (value, refresh) => readProblemDay(async date => {
  if (date === undefined) {
    const readme = await raw('README.md');
    const dates = [...readme.matchAll(/daily_problems\/(\d{4})\/(\d{2})\/(\d{2})(\d{2})\//g)]
      .filter(match => match[2] === match[3]).map(match => `${match[1]}-${match[2]}-${match[4]}`).sort();
    date = dates.at(-1);
    if (!date) throw new Error(t('无法从仓库首页识别最新题单，请从历史题库浏览。'));
  }
  validateDate(date);
  const path = `${repositoryDatePath(date)}/problems.md`;
  const problems = parseProblems(await raw(path), date);
  if (!problems.length) throw new Error(t('该日题目格式暂不受支持，请在 GitHub 查看原文。'));
  return { date, problems, sourceUrl: `${UPSTREAM.url}/blob/HEAD/${path}`, fetchedAt: new Date().toISOString(), parserVersion: PARSER_VERSION };
}, value, refresh === true);
const browser: ClientAPI = {
  isDesktop: false,
  bootstrap: async () => ({ auth: { user: null, configured: false, secureStorage: false }, settings, defaultClientId: '', version: '0.3.24', repository: `${UPSTREAM.owner}/${UPSTREAM.repo}`, systemLanguages }),
  getDay,
  // The browser preview has no filesystem or Git worker; this remains a fresh
  // read-only API lookup. Only the desktop application maintains a Git mirror.
  syncLibrary: async () => { const { branch, revision } = await library.getArchiveSnapshot(); return { branch, revision }; },
  getLocalLibraryView: async () => null,
  onLibrarySync: () => () => {},
  getArchiveMonths: refresh => library.getArchiveMonths(refresh === true), getMonth: (month, refresh) => library.getMonth(month, refresh === true),
  getArchiveSnapshot: () => library.getArchiveSnapshot(), getMonthFromSnapshot: (month, snapshot) => library.getMonthFromSnapshot(month, snapshot),
  getResources: (date, problemId, refresh) => library.getResources(validateDate(date), problemId, refresh === true), getReference: (path, refresh) => library.getReference(path, refresh === true),
  saveSettings: async value => { const normalized = settingsInput(value); write('settings', normalized); settings = normalized; setLocale(settings.uiLanguage ?? 'system', systemLanguages); return settings; },
  getLocalPaths: async () => null,
  openLocalPath: async () => { throw new Error(t('请在桌面客户端中打开本地文件或文件夹。')); },
  getForks: desktopOnly, validateFork: desktopOnly, createFork: desktopOnly,
  beginLogin: desktopOnly, cancelLogin: async () => {}, loginWithToken: desktopOnly, logout: desktopOnly,
  inspectSubmissionFile: desktopOnly, getContributions: desktopOnly,
  previewBatchSubmission: desktopOnly, submitBatch: desktopOnly,
  importCode: desktopOnly,
  copyText: copyBrowserText,
  resolveWindowTransition: async () => { throw new Error(t('浏览器预览请使用浏览器原生的离开页面确认。')); },
  openExternal: async value => {
    window.open(safeExternal(value), '_blank', 'noopener,noreferrer');
  },
  onAuthChanged: () => () => {}, onSubmissionProgress: () => () => {}
};
export const api: ClientAPI = window.dailyCF ?? browser;
