import { contextBridge, ipcRenderer } from 'electron';
import type { ApiResult, BootState, ClientAPI, Settings } from '../shared/types';
import { setLocale } from '../shared/i18n';
import { apiResultError } from '../shared/api-errors';
let systemLanguages: string[] | undefined;
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: ApiResult<T> = await ipcRenderer.invoke(`daily-cf:${channel}`, ...args);
  if (!result.ok) throw apiResultError(result);
  return result.data as T;
}
function subscribe<T>(channel: string, callback: (value: T) => void) {
  const handler = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
const api: ClientAPI = {
  isDesktop: true,
  bootstrap: async () => {
    const boot = await invoke<BootState>('bootstrap');
    systemLanguages = boot.systemLanguages;
    setLocale(boot.settings.uiLanguage ?? 'system', systemLanguages);
    return boot;
  }, getDay: (date, refresh) => invoke('day', date, refresh === true),
  syncLibrary: () => invoke('sync-library'),
  getLocalLibraryView: request => invoke('local-library-view', request),
  onLibrarySync: callback => subscribe('daily-cf:library-sync', callback),
  getArchiveMonths: refresh => invoke('archive-months', refresh === true), getMonth: (month, refresh) => invoke('month', month, refresh === true),
  getArchiveSnapshot: () => invoke('archive-snapshot'), getMonthFromSnapshot: (month, snapshot) => invoke('month-from-snapshot', month, snapshot),
  getResources: (date, problemId, refresh) => invoke('resources', date, problemId, refresh === true), getReference: (path, refresh) => invoke('reference', path, refresh === true),
  getLocalPaths: () => invoke('local-paths'),
  openLocalPath: target => invoke('open-local-path', target),
  saveSettings: async settings => {
    const saved = await invoke<Settings>('settings', settings);
    setLocale(saved.uiLanguage ?? 'system', systemLanguages);
    return saved;
  }, beginLogin: () => invoke('login'), cancelLogin: () => invoke('cancel-login'),
  getForks: () => invoke('forks'), validateFork: repository => invoke('validate-fork', repository), createFork: name => invoke('create-fork', name),
  loginWithToken: token => invoke('token', token), logout: () => invoke('logout'),
  inspectSubmissionFile: input => invoke('inspect-submission-file', input), getContributions: page => invoke('contributions', page),
  previewBatchSubmission: input => invoke('preview-batch', input), submitBatch: input => invoke('submit-batch', input),
  importCode: () => invoke('import'),
  copyText: text => invoke('copy-text', text),
  resolveWindowTransition: proceed => invoke('resolve-window-transition', proceed),
  openExternal: url => invoke('external', url),
  onAuthChanged: callback => subscribe('daily-cf:auth', callback), onSubmissionProgress: callback => subscribe('daily-cf:progress', callback)
};
contextBridge.exposeInMainWorld('dailyCF', api);
