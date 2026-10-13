import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitHubClient } from './github';
import { GitHubRateLimitGate } from './github-rate-limit';
import { LibraryWorkerHost } from './library-worker-host';
import { GitHubAuth } from './auth';
import { shouldExpireGitHubSession } from './ipc-errors';
import { LocalStore } from './storage';
import { getLocalPaths, openLocalPath } from './local-paths';
import { readCodeFile } from './code-import';
import { WindowTransitionState } from './window-transition';
import { LoginAttemptLock } from './login-attempt';
import { batchSubmissionInput, safeExternal, settingsInput, text } from './guards';
import { UPSTREAM, type AuthState, type BatchSubmissionInput, type SubmissionInput, type User } from '../shared/types';
import { validateDate } from '../shared/domain';
import { readProblemDay } from '../shared/day-service';
import { clipboardText } from '../shared/clipboard';
import { validateForkName } from '../shared/fork';
import { getLocale, setLocale, t } from '../shared/i18n';
import { serializeApiError } from '../shared/api-errors';
import { localLibraryViewInput } from '../shared/library-files';
import { appearanceBackground } from '../shared/appearance';

declare const __GITHUB_CLIENT_ID__: string;
app.commandLine.appendSwitch('disable-http-cache');
// Keep the settings and encrypted session location stable across display-name changes.
const profileDirectory = app.commandLine.getSwitchValue('user-data-dir');
app.setPath('userData', profileDirectory ? resolve(profileDirectory) : join(app.getPath('appData'), 'Daily CF'));
let window: BrowserWindow | null = null;
let store: LocalStore;
let library: LibraryWorkerHost;
let client: GitHubClient;
let auth: GitHubAuth;
let token: string | undefined;
let rateLimitIdentity: string | undefined;
let rateLimitGate = new GitHubRateLimitGate();
let user: User | null = null;
let submitting = false;
const loginAttempt = new LoginAttemptLock();
let authGeneration = 0;
const windowTransition = new WindowTransitionState();
const repository = `${UPSTREAM.owner}/${UPSTREAM.repo}`;
const developmentUrl = !app.isPackaged ? process.env.DAILY_CF_DEV_URL : undefined;
const indexPath = join(__dirname, '../dist/index.html');
let systemLanguages: string[] = [];

function applyNativeLanguage() {
  window?.setTitle(t('小羊肖恩的每日一题'));
  const template: MenuItemConstructorOptions[] = [
    { label: t('文件'), submenu: [{ role: process.platform === 'darwin' ? 'close' : 'quit', label: t(process.platform === 'darwin' ? '关闭窗口' : '退出') }] },
    { label: t('编辑'), submenu: [
      { role: 'undo', label: t('撤销') }, { role: 'redo', label: t('重做') }, { type: 'separator' },
      { role: 'cut', label: t('剪切') }, { role: 'copy', label: t('复制') }, { role: 'paste', label: t('粘贴') }, { role: 'selectAll', label: t('全选') },
    ] },
    { label: t('视图'), submenu: [
      { role: 'reload', label: t('重新加载') }, { role: 'forceReload', label: t('强制重新加载') }, { type: 'separator' },
      { role: 'resetZoom', label: t('实际大小') }, { role: 'zoomIn', label: t('放大') }, { role: 'zoomOut', label: t('缩小') },
      { type: 'separator' }, { role: 'togglefullscreen', label: t('切换全屏') },
    ] },
  ];
  if (process.platform === 'darwin') template.unshift({ label: t('小羊肖恩的每日一题'), submenu: [
    { role: 'about', label: t('关于小羊肖恩的每日一题') }, { type: 'separator' },
    { role: 'hide', label: t('隐藏窗口') }, { role: 'hideOthers', label: t('隐藏其他窗口') }, { role: 'unhide', label: t('显示全部窗口') },
    { type: 'separator' }, { role: 'quit', label: t('退出') },
  ] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function state(message?: string): AuthState { return { user, configured: !!store.data.settings.clientId, secureStorage: store.secure, message: message || store.warning }; }
function emitAuth(message?: string) { window?.webContents.send('daily-cf:auth', state(message)); }
function resetClients() {
  // Settings changes keep the cooldown; signing in uses the account's own quota.
  if (rateLimitIdentity !== token) { rateLimitIdentity = token; rateLimitGate = new GitHubRateLimitGate(); }
  client = new GitHubClient(token, { rateLimitGate, forkRepository: store.data.settings.forkRepository, prTitleTemplate: store.data.settings.prTitleTemplate, prBodyTemplate: store.data.settings.prBodyTemplate });
}
function idle() { if (submitting) throw new Error(t('正在提交，请等待当前提交完成后再切换账号或设置。')); }
function invalidateAuthAttempt() { auth.cancel(); authGeneration++; loginAttempt.clear(); }
function trust(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error(t('不允许的调用来源。'));
  const url = event.senderFrame.url;
  if (developmentUrl ? new URL(url).origin !== developmentUrl : url.split('#')[0] !== pathToFileURL(indexPath).href) throw new Error(t('不允许的页面来源。'));
}
function handle(name: string, callback: (...args: any[]) => unknown) {
  ipcMain.handle(`daily-cf:${name}`, async (event, ...args) => {
    const requestToken = token;
    try { trust(event); return { ok: true, data: await callback(...args) }; }
    catch (error) {
      if (shouldExpireGitHubSession(name, error, requestToken, token)) {
        invalidateAuthAttempt(); token = undefined; user = null; store.clearToken(); resetClients(); emitAuth(t('GitHub 登录已过期，请重新登录。'));
      }
      return serializeApiError(error);
    }
  });
}
async function signIn(value: string, signal?: AbortSignal) {
  const generation = authGeneration;
  const nextClient = new GitHubClient(value);
  const nextUser = await nextClient.getUser();
  if (signal?.aborted || generation !== authGeneration) return state();
  store.saveToken(value);
  token = value; user = nextUser;
  resetClients();
  emitAuth(store.secure ? undefined : t('系统安全存储不可用，本次登录只保存在内存中，退出程序后失效。'));
  return state();
}
function registerHandlers() {
  handle('bootstrap', () => ({ auth: state(), settings: store.data.settings, defaultClientId: __GITHUB_CLIENT_ID__.trim(), version: app.getVersion(), repository, systemLanguages }));
  handle('local-paths', () => getLocalPaths(store.directory));
  handle('open-local-path', (target: unknown) => openLocalPath(store.directory, target, shell));
  handle('sync-library', () => library.syncLibrary());
  handle('local-library-view', (request: unknown) => library.getLocalLibraryView(localLibraryViewInput(request)));
  handle('day', (date?: string, refresh?: boolean) => readProblemDay((requestedDate, force) => library.getDay(requestedDate, force), date, refresh === true));
  handle('archive-months', (refresh?: boolean) => library.getArchiveMonths(refresh === true));
  handle('archive-snapshot', () => library.getArchiveSnapshot());
  handle('month-from-snapshot', (month: string, snapshot: unknown) => library.getMonthFromSnapshot(text(month, '月份', 7), snapshot as import('../shared/types').ArchiveSnapshot));
  handle('month', (month: string, refresh?: boolean) => library.getMonth(text(month, '月份', 7), refresh === true));
  handle('resources', (date: string, id: string, refresh?: boolean) => library.getResources(validateDate(date), text(id, '题号', 30), refresh === true));
  handle('reference', (path: string, refresh?: boolean) => library.getReference(text(path, '路径', 400), refresh === true));
  handle('settings', async value => {
    idle();
    const settings = settingsInput(value);
    const session = authGeneration;
    if (settings.forkRepository && settings.forkRepository !== store.data.settings.forkRepository) {
      if (!user || !token) throw new Error(t('请先登录 GitHub，再绑定投稿 Fork。'));
      await client.validateFork(settings.forkRepository);
      if (session !== authGeneration) throw new Error(t('账号已变更，请重新校验 Fork。'));
    }
    idle();
    if (settings.clientId !== store.data.settings.clientId) invalidateAuthAttempt();
    const previous = store.data.settings;
    store.data.settings = settings;
    try { store.persist(); } catch (error) { store.data.settings = previous; throw error; }
    setLocale(settings.uiLanguage ?? 'system', systemLanguages); library.setLocale(getLocale()); applyNativeLanguage();
    if (window && !window.isDestroyed()) window.setBackgroundColor(appearanceBackground(settings, nativeTheme.shouldUseDarkColors));
    resetClients(); emitAuth(); return settings;
  });
  handle('forks', () => client.getForks());
  handle('validate-fork', (repository: string) => client.validateFork(text(repository, 'Fork 仓库', 160)));
  handle('create-fork', async (value: unknown) => {
    idle();
    if (!user || !token || loginAttempt.active) throw new Error(t('请先完成 GitHub 登录。'));
    const name = validateForkName(value);
    invalidateAuthAttempt(); submitting = true;
    try { return await client.createFork(name); } finally { submitting = false; }
  });
  handle('login', async () => { idle(); if (loginAttempt.active) throw new Error(t('请等待当前登录完成。')); invalidateAuthAttempt(); return auth.begin(store.data.settings.clientId); });
  handle('cancel-login', () => { invalidateAuthAttempt(); });
  handle('token', async (value: string) => {
    idle(); if (loginAttempt.active) throw new Error(t('正在验证登录，请稍候。'));
    const personalToken = text(value, 'Token', 300).trim();
    if (!/^(ghp_|github_pat_)[A-Za-z0-9_]+$/.test(personalToken)) throw new Error(t('请输入有效的 GitHub Personal Access Token。建议使用具有 public_repo 权限的 classic token。'));
    invalidateAuthAttempt();
    const generation = authGeneration;
    loginAttempt.acquire(generation);
    try { return await signIn(personalToken); }
    finally { if (generation === authGeneration) loginAttempt.release(generation); }
  });
  handle('logout', () => { idle(); invalidateAuthAttempt(); token = undefined; user = null; store.clearToken(); resetClients(); emitAuth(); return state(); });
  handle('inspect-submission-file', (input: SubmissionInput) => client.inspectSubmissionFile(input));
  handle('preview-batch', (input: BatchSubmissionInput) => client.previewBatchSubmission(batchSubmissionInput(input)));
  handle('submit-batch', async (input: BatchSubmissionInput) => {
    idle();
    if (!user || !token) throw new Error(t('请先登录 GitHub 后提交。'));
    if (loginAttempt.active) throw new Error(t('请等待登录完成。'));
    const validated = batchSubmissionInput(input);
    invalidateAuthAttempt(); submitting = true;
    try {
      return await client.submitBatch(validated, user.login, progress => window?.webContents.send('daily-cf:progress', progress));
    } finally { submitting = false; }
  });
  handle('contributions', async (page = 1) => {
    if (!user || !token) throw new Error(t('请先登录 GitHub 查看你的 PR 记录。'));
    const login = user?.login;
    const generation = authGeneration;
    const result = await client.getContributions(page);
    if (generation !== authGeneration || login !== user?.login) throw new Error(t('账号已变更，请重新读取 PR 记录。'));
    return result;
  });
  handle('import', async () => {
    const result = await dialog.showOpenDialog(window!, { title: t('导入解答代码'), buttonLabel: t('导入'), properties: ['openFile'], filters: [{ name: t('所有文件'), extensions: ['*'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return readCodeFile(result.filePaths[0]);
  });
  handle('copy-text', async (value: unknown) => {
    const content = clipboardText(value);
    try { await clipboard.writeText(content); }
    catch { throw new Error(t('无法写入系统剪贴板，请重试，或选中文本后手动复制。')); }
  });
  handle('resolve-window-transition', (proceed: unknown) => {
    const transition = windowTransition.resolve(proceed);
    if (!transition) return;
    const target = window;
    setImmediate(() => {
      if (transition === 'quit') { app.quit(); return; }
      if (!target || target.isDestroyed()) return;
      if (transition === 'close') target.close();
      else if (!target.webContents.isDestroyed()) target.webContents.reload();
    });
  });
  handle('external', async (url: string) => { await shell.openExternal(safeExternal(url)); });
}
async function createWindow() {
  window = new BrowserWindow({ show: !(!app.isPackaged && process.env.DAILY_CF_SMOKE === '1'), width: 1390, height: 940, minWidth: 900, minHeight: 650, backgroundColor: appearanceBackground(store.data.settings, nativeTheme.shouldUseDarkColors), title: t('小羊肖恩的每日一题'), autoHideMenuBar: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  const target = window;
  const updateBackground = () => { if (!target.isDestroyed()) target.setBackgroundColor(appearanceBackground(store.data.settings, nativeTheme.shouldUseDarkColors)); };
  nativeTheme.on('updated', updateBackground);
  target.once('closed', () => nativeTheme.removeListener('updated', updateBackground));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.on('will-prevent-unload', () => { windowTransition.preventUnload(); });
  window.on('close', event => {
    if (submitting) {
      event.preventDefault(); windowTransition.clear();
      dialog.showMessageBox(window!, { type: 'info', message: t('提交正在进行中，请等待完成后再退出。'), buttons: [t('确定')] });
      return;
    }
    windowTransition.requestClose();
  });
  window.on('closed', () => {
    windowTransition.clear(); window = null;
  });
  if (developmentUrl === 'http://127.0.0.1:5173') await window.loadURL(developmentUrl);
  else await window.loadFile(indexPath);
  if (!app.isPackaged && process.env.DAILY_CF_SMOKE === '1') {
    const info = await window.webContents.executeJavaScript(`(async () => {
      if (!window.dailyCF?.isDesktop) throw new Error('Sandboxed preload unavailable');
      const boot = await window.dailyCF.bootstrap();
      return { repository: boot.repository, version: boot.version, account: boot.auth.user?.login || null,
        secureStorage: boot.auth.secureStorage, remoteContributionsAvailable: typeof window.dailyCF.getContributions === 'function',
        externalLinksAvailable: typeof window.dailyCF.openExternal === 'function',
        batchSubmissionAvailable: typeof window.dailyCF.previewBatchSubmission === 'function' && typeof window.dailyCF.submitBatch === 'function' && typeof window.dailyCF.inspectSubmissionFile === 'function',
        noPullRequestMutationAPI: ['getOpenPullRequests', 'previewSubmission', 'submit'].every(name => typeof window.dailyCF[name] !== 'function'),
        noHandleSubmissionAPI: typeof window.dailyCF.getHandleSubmissions !== 'function',
        noDefaultAuthor: !Object.hasOwn(boot.settings, 'author'),
        draftsAvailable: 'saveDraft' in window.dailyCF || 'drafts' in boot,
        nodeIntegrationOff: typeof window.require === 'undefined', bridge: 'connected' };
    })()`);
    if (!info.nodeIntegrationOff || info.bridge !== 'connected') throw new Error('Desktop isolation failed.');
    console.log(JSON.stringify(info)); app.quit();
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    systemLanguages = app.getPreferredSystemLanguages();
    setLocale('system', systemLanguages);
    store = new LocalStore(join(app.getPath('userData'), UPSTREAM.owner, UPSTREAM.repo), safeStorage, __GITHUB_CLIENT_ID__);
    setLocale(store.data.settings.uiLanguage ?? 'system', systemLanguages);
    library = new LibraryWorkerHost(join(store.directory, 'library.git'), { onProgress(progress) {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('daily-cf:library-sync', progress);
    } });
    applyNativeLanguage();
    token = store.loadToken(); resetClients();
    auth = new GitHubAuth({ onToken: async (value, signal) => { await signIn(value, signal); }, onError: message => emitAuth(message) });
    if (token) { try { user = await client.getUser(); } catch (error) { if ((error as { status?: number }).status === 401) { token = undefined; store.clearToken(); resetClients(); } store.warning = '暂时无法验证已保存的登录，请检查网络或重新登录。'; } }
    registerHandlers(); await createWindow();
    app.on('activate', () => { if (!window) void createWindow(); });
  }).catch(error => { dialog.showErrorBox(t('启动失败'), error instanceof Error ? error.message : String(error)); app.quit(); });
  app.on('before-quit', () => { windowTransition.requestQuit(); });
  app.on('will-quit', () => { auth?.cancel(); library?.dispose(); windowTransition.clear(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
