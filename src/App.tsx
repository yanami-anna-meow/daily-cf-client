import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Braces,
  CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight,
  CircleHelp, Clock3, Code2, Copy, ExternalLink, FileCode2, TriangleAlert,
  GitBranch, Github, GitPullRequest, History, LayoutGrid,
  ListPlus, LoaderCircle, LogOut, RefreshCw, Search, Send,
  Settings2, ShieldCheck, Sparkles, Upload, WifiOff, X,
} from 'lucide-react';
import { api } from './bridge';
import { CLIENT_REPOSITORY } from '../shared/metadata';
import { LANGUAGES, UPSTREAM, type AuthState, type DeviceLogin,
  type Language, type Problem, type ProblemDay, type ProblemResources, type ReferenceFile,
  type Settings, type BatchSubmissionResult, type RemotePullRequest } from '../shared/types';
import Markdown from './components/Markdown';
import DeviceCode from './components/DeviceCode';
import GitHubRateLimitNotice, { useRateLimitReady } from './components/GitHubRateLimitNotice';
import LibrarySyncNotice from './components/LibrarySyncNotice';
import RetainedContentNotice from './components/RetainedContentNotice';
import Modal from './components/Modal';
import ForkSettings from './components/ForkSettings';
import TemplateSettings from './components/TemplateSettings';
import AppearanceSettings from './components/AppearanceSettings';
import LocalDataSettings from './components/LocalDataSettings';
import CodeHighlight from './components/CodeHighlight';
import { useContributions } from './useContributions';
import { useLibrary } from './useLibrary';
import { useArchiveNavigation } from './useArchiveNavigation';
import { useLibrarySync } from './useLibrarySync';
import { useRetainedRead } from './useRetainedRead';
import BatchComposer from './components/BatchComposer';
import type { SubmissionQueueEntry } from './submissionQueue';
import ContributionList from './components/ContributionList';
import ProblemContributionStatus, { getProblemContributionSummary } from './components/ProblemContributionStatus';
import { parseDifficultyRange, matchesDifficulty } from '../shared/difficulty';
import { validateDate } from '../shared/domain';
import { appearanceEqual } from '../shared/appearance';
import { getLocale, setLocale, t, useLocale } from './i18n';
import { useAppearance } from './useAppearance';

type Page = 'today' | 'archive' | 'history' | 'settings';
type Detail = { day: ProblemDay; problem: Problem };
type Composer = { instanceId: string; day?: ProblemDay; problem?: Problem };
type Notice = { text: string; kind: 'success' | 'error' | 'info' };
type PendingLeave = { run?: () => void; windowTransition?: boolean };
type ListPosition = { page: Page; key: string; offset: number; scrollY: number; returning: boolean };
const DEFAULT_SETTINGS: Settings = { clientId: '', language: 'cpp', uiLanguage: 'system', theme: 'system' };
function settingsEqual(left: Settings, right: Settings) {
  const template = (value: string | undefined) => value?.trim() ? value : undefined;
  return (['clientId', 'language', 'theme', 'forkRepository'] as const)
    .every(key => (left[key] ?? '') === (right[key] ?? ''))
    && (left.uiLanguage ?? 'system') === (right.uiLanguage ?? 'system')
    && appearanceEqual(left, right)
    && template(left.prTitleTemplate) === template(right.prTitleTemplate)
    && template(left.prBodyTemplate) === template(right.prBodyTemplate);
}
const NAV = [
  { id: 'today', label: '最新题目', icon: LayoutGrid },
  { id: 'archive', label: '历史题库', icon: CalendarDays },
  { id: 'history', label: '提交记录', icon: GitPullRequest },
] as const;
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function formatDate(date: string, options?: Intl.DateTimeFormatOptions) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(getLocale(), options ?? { month: 'long', day: 'numeric', weekday: 'long' });
}
function localDate() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function languageLabel(language: string) { return language === 'other' ? t('其他') : LANGUAGES.find((item) => item.id === language)?.label ?? language; }
function timeLabel(value: string) { return new Date(value).toLocaleString(getLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function problemTitle(problem: Problem) { return problem.sourceWarning ? problem.id.toUpperCase() : problem.label.replace(/^\*+|\*+$/g, '') || problem.id.toUpperCase(); }
function problemKind(problem: Problem): 'gym' | 'round' { return problem.kind ?? (problem.url.includes('/gym/') ? 'gym' : 'round'); }

export function AppLogo() {
  return <svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="3" y="3" width="42" height="42" rx="11" fill="currentColor" opacity=".1" /><path d="m18 16-8 8 8 8m12-16 8 8-8 8m-4-18-4 20" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function Button({ children, onClick, kind = 'secondary', disabled = false, className = '', type = 'button', title }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean; className?: string; type?: 'button' | 'submit'; title?: string;
}) { return <button type={type} className={`button button-${kind} ${className}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>; }

function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon ?? <BookOpen size={28} />}</span><h3>{title}</h3><p>{children}</p>{action}</div>;
}

function Rating({ rating, source = 'unknown' }: { rating: number | null; source?: Problem['ratingSource'] }) {
  const band = rating === null ? 'unknown' : rating < 1200 ? 'gray' : rating < 1400 ? 'green' : rating < 1600 ? 'cyan' : rating < 1900 ? 'blue' : rating < 2100 ? 'violet' : rating < 2400 ? 'orange' : 'red';
  return <span className={`rating rating-${band}`} title={rating === null ? t("仓库未标注难度") : t('难度 {{rating}}', { rating: `${source === 'estimated' ? '*' : ''}${rating}` })}><span className="rating-bars"><i /><i /><i /></span>{rating === null ? t("未标注") : `${source === 'estimated' ? '*' : ''}${rating}`}</span>;
}

function SourceWarning({ problem, warning }: { problem?: Problem; warning?: string }) {
  const message = warning || problem?.sourceWarning;
  return message ? <div className="alert alert-warning source-warning"><CircleHelp size={18} /><div><strong>{t("题号不一致")}</strong><p>{message}</p>{problem?.sourceWarning && <small>{t('原始标注：{{label}} · 按原题链接识别：{{id}}', { label: problem.label, id: problem.id.toUpperCase() })}</small>}</div></div> : null;
}

const ProblemCard = memo(function ProblemCard({ day, problem, index, compact = false, account, records, incomplete, onOpen, onDetail, onCompose }: {
  day: ProblemDay; problem: Problem; index: number; compact?: boolean; account?: string;
  records: RemotePullRequest[]; incomplete: boolean; onOpen: (url: string) => void;
  onDetail: (day: ProblemDay, problem: Problem) => void;
  onCompose: (day: ProblemDay, problem: Problem) => void;
}) {
    useLocale();
    const contributionState = account ? getProblemContributionSummary(records, problem.id, incomplete).state : 'unknown';
    return <article className={`problem-card contribution-${contributionState} ${compact ? 'problem-card-compact' : ''}`} data-problem-key={`${day.date}:${problem.id}`} data-contribution-state={contributionState}>
      <div className="problem-card-top"><span className="eyebrow">{t('题目 {{number}}', { number: String(index + 1).padStart(2, '0') })}</span><Rating rating={problem.rating} source={problem.ratingSource} /></div>
      <button className="problem-title-button" onClick={() => onDetail(day, problem)}><h3>{problemTitle(problem)}</h3><ArrowUpRight size={20} /></button>
      <p className="problem-id"><Braces size={14} />{problem.id.toUpperCase()}<span className={`problem-kind kind-${problemKind(problem)}`}>{problemKind(problem) === 'gym' ? 'Gym' : 'CF Round'}</span></p>

      {account && <div className="problem-card-contribution"><ProblemContributionStatus problemId={problem.id} records={records} incomplete={incomplete} compact onOpen={onOpen} /></div>}
      <div className="problem-card-footer">
        <button className="text-button" onClick={() => onDetail(day, problem)}>{t("查看题目")}<ArrowRight size={16} /></button>
        <div className="problem-card-actions">
          <button className="text-button" onClick={() => onCompose(day, problem)}><ListPlus size={14} />{t("加入提交列表")}</button>
        </div>
      </div>
    </article>;
  });

export default function App() {
  const locale = useLocale();
  const [page, setPage] = useState<Page>('today');
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [version, setVersion] = useState('');
  const [repository, setRepository] = useState(`${UPSTREAM.owner}/${UPSTREAM.repo}`);
  const [auth, setAuth] = useState<AuthState>({ user: null, configured: false, secureStorage: false });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  useAppearance(settings);
  const [settingsForm, setSettingsForm] = useState<Settings>(DEFAULT_SETTINGS);
  const [defaultClientId, setDefaultClientId] = useState('');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [oauthChange, setOAuthChange] = useState<{ previous: string; next: string } | null>(null);
  const oauthConfirmation = useRef<((confirmed: boolean) => void) | null>(null);
  const [forkSettingsBusy, setForkSettingsBusy] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
  const [openAdvanced, setOpenAdvanced] = useState(false);
  const [refreshingScope, setRefreshingScope] = useState('');
  const [search, setSearch] = useState('');
  const [minimumDifficulty, setMinimumDifficulty] = useState('');
  const [maximumDifficulty, setMaximumDifficulty] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [dateInput, setDateInput] = useState('');
  const [detailTarget, setDetail] = useState<Detail | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const detailRead = useRetainedRead<Detail>({
    key: detailTarget ? `${repository}:${detailTarget.day.date}:${detailTarget.problem.id}` : null,
    initial: detailTarget ?? undefined, reload: detailReload,
    load: async () => {
      const target = detailTarget!;
      const day = await api.getDay(target.day.date, true);
      const problem = day.problems.find(candidate => candidate.id === target.problem.id);
      if (!problem) throw Object.assign(new Error(t('仓库中已找不到这道题，请返回题库重新选择。')), { code: 'library_content_missing' });
      return { day, problem };
    },
  });
  const detail = detailRead.data ?? detailTarget;
  const detailLoading = detailRead.loading;
  const detailError = detailRead.error;
  const [composer, setComposer] = useState<Composer | null>(null);
  const [queueEntries, setQueueEntries] = useState<SubmissionQueueEntry[]>([]);
  const [queueNotes, setQueueNotes] = useState('');
  const [queueRequestId, setQueueRequestId] = useState(() => crypto.randomUUID());
  const [composerDirty, setComposerDirty] = useState(false);
  const composerBusyRef = useRef(false);
  const { statistics, items: history, indexedItems, statusIndex, loading: historyBusy, error: historyError, refresh: refreshHistory, loadMore: loadMoreHistory } = useContributions(auth, repository, composer ? `composer:${composer.instanceId}` : detail ? `detail:${detail.day.date}:${detail.problem.id}` : page === 'settings' ? null : page);
  const { progress: librarySync, refresh: refreshLibrary, busy: librarySyncBusy } = useLibrarySync();
  const { today, dayLoading, dayError, dayRetained, months, archiveError, archiveRetained, directoryLoading, archiveIndex, indexing, indexingMonth, indexingError, indexFailures, indexStopped, indexingCompleted, indexingTotal, archiveRefreshing, rateLimit, loadLatest, refreshArchive, indexArchive, stopIndexing } = useLibrary({ pageActive: detail ? null : page === 'today' || page === 'archive' ? page : null });
  const libraryRetryReady = useRateLimitReady(rateLimit, Boolean(auth.user));
  const [tab, setTab] = useState<'problem' | 'editorial' | 'reference'>('problem');
  const [resourcesReload, setResourcesReload] = useState(0);
  const [referenceTarget, setReference] = useState<ReferenceFile | null>(null);
  const [referenceReload, setReferenceReload] = useState(0);
  const [referenceLanguage, setReferenceLanguage] = useState('all');
  const resourcesRead = useRetainedRead<ProblemResources>({
    key: detail && !detailRead.missing && tab !== 'problem' ? `${repository}:${detail.day.date}:${detail.problem.id}` : null,
    reload: resourcesReload,
    load: () => api.getResources(detail!.day.date, detail!.problem.id, true),
    preview: async () => {
      const view = await api.getLocalLibraryView({ kind: 'resources', date: detail!.day.date, problemId: detail!.problem.id });
      return view?.kind === 'resources' ? view.resources : null;
    },
  });
  const resources = resourcesRead.data;
  const resourcesBusy = resourcesRead.loading;
  const resourcesError = resourcesRead.error;
  const reference = resources?.references.find(file => file.path === referenceTarget?.path) ?? null;
  const referenceRead = useRetainedRead<string>({
    key: detail && !detailRead.missing && tab === 'reference' && reference ? `${repository}:${reference.path}` : null,
    reload: referenceReload + resourcesReload,
    load: () => api.getReference(reference!.path, true),
    preview: async () => {
      const view = await api.getLocalLibraryView({ kind: 'reference', path: reference!.path });
      return view?.kind === 'reference' ? view.code : null;
    },
  });
  const referenceCode = referenceRead.data ?? '';
  const referenceBusy = referenceRead.loading;
  const referenceError = referenceRead.error;
  const [result, setResult] = useState<BatchSubmissionResult | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [deviceLogin, setDeviceLogin] = useState<DeviceLogin | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [tokenMode, setTokenMode] = useState(false);
  const [token, setToken] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [openingUrls, setOpeningUrls] = useState<ReadonlySet<string>>(new Set());
  const externalRequests = useRef(new Set<string>());
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const pageRefreshRun = useRef<{ scope: string; id: number } | null>(null);
  const pageRefreshGeneration = useRef(0);
  const dateTimer = useRef<number | undefined>(undefined);
  const dateValue = useRef(dateInput);
  const dateSubmittedValue = useRef('');
  const listPosition = useRef<ListPosition | null>(null);
  const listVisible = useRef(!detail);
  listVisible.current = !detail;
  const composerCloseRequest = useRef<((action: () => void) => void) | null>(null);
  const loginAttempt = useRef(0);
  const authGeneration = useRef(0);
  const settingsSaveBusy = useRef(false);
  const windowSaveCancelled = useRef(false);
  const forkSettingsBusyRef = useRef(false);
  const allowUnload = useRef(false);
  const dirtyRef = useRef(false);
  const queueDirtyRef = useRef(false);
  const advancedSettings = useRef<HTMLDetailsElement>(null);
  const systemLanguages = useRef<readonly string[]>(navigator.languages?.length ? navigator.languages : [navigator.language]);
  const settingsDirty = !settingsEqual(settings, settingsForm);
  const queueDirty = queueEntries.length > 0 || Boolean(queueNotes.trim()) || composerDirty;
  dirtyRef.current = settingsDirty;
  queueDirtyRef.current = queueDirty;
  const refreshScope = `${page}:${detail ? `${detail.day.date}:${detail.problem.id}` : 'list'}:${composer?.instanceId ?? ''}:${auth.user?.login ?? ''}`;
  const pageRefreshing = refreshingScope === refreshScope;

  const notify = (text: string, kind: Notice['kind'] = 'success') => setNotice({ text, kind });
  const openExternal = (url: string) => {
    if (externalRequests.current.has(url)) return;
    externalRequests.current.add(url); setOpeningUrls(new Set(externalRequests.current));
    void api.openExternal(url).catch((error: unknown) => notify(errorText(error), 'error')).finally(() => {
      externalRequests.current.delete(url); setOpeningUrls(new Set(externalRequests.current));
    });
  };

  async function refreshPage(target: Page) {
    if (pageRefreshRun.current?.scope === refreshScope) return;
    const id = ++pageRefreshGeneration.current;
    pageRefreshRun.current = { scope: refreshScope, id }; setRefreshingScope(refreshScope);
    try {
      await Promise.allSettled([
        target === 'today' ? loadLatest(true) : target === 'archive' ? refreshArchive() : refreshLibrary(),
        target === 'settings' ? Promise.resolve() : refreshHistory(),
      ]);
    } finally {
      if (pageRefreshRun.current?.id === id) { pageRefreshRun.current = null; setRefreshingScope(''); }
    }
  }

  function refreshDetail() {
    if (detailLoading) return;
    setDetailReload(value => value + 1);
    setResourcesReload(value => value + 1); setReferenceReload(value => value + 1);
    void refreshHistory();
  }

  async function bootstrap() {
    setBooting(true); setBootError('');
    try {
      const data = await api.bootstrap();
      systemLanguages.current = data.systemLanguages ?? systemLanguages.current;
      setLocale(data.settings.uiLanguage ?? 'system', systemLanguages.current);
      setAuth(data.auth); setSettings(data.settings); setSettingsForm(data.settings);
      setDefaultClientId(data.defaultClientId ?? '');
      setVersion(data.version); setRepository(data.repository);
    } catch (error) { setBootError(errorText(error)); }
    finally { setBooting(false); }
  }

  useEffect(() => { void bootstrap(); }, []);
  useEffect(() => () => { oauthConfirmation.current?.(false); oauthConfirmation.current = null; }, []);
  useEffect(() => {
    // Content pages synchronize as part of their reads. These pages have no
    // repository read of their own, so page entry explicitly checks for updates.
    if (api.isDesktop && !booting && !detail && (page === 'history' || page === 'settings')) void refreshLibrary();
  }, [page, Boolean(detail), booting, refreshLibrary]);
  useEffect(() => { document.documentElement.lang = locale; document.title = t('小羊肖恩的每日一题'); }, [locale]);
  useEffect(() => () => { window.clearTimeout(dateTimer.current); }, []);
  useEffect(() => {
    if (pageRefreshRun.current && pageRefreshRun.current.scope !== refreshScope) {
      ++pageRefreshGeneration.current; pageRefreshRun.current = null; setRefreshingScope('');
    }
  }, [refreshScope]);
  useEffect(() => api.onAuthChanged((next) => {
    ++authGeneration.current;
    setAuth(next);
    if (next.user) { ++loginAttempt.current; setLoginOpen(false); setDeviceLogin(null); setLoginBusy(false); setToken(''); notify(t('已登录 GitHub · {{login}}', { login: next.user.login })); }
    else if (next.message) { setLoginError(next.message); setLoginBusy(false); setDeviceLogin(null); }
  }), []);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), notice.kind === 'error' ? 9000 : 4500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (settingsSaveBusy.current) {
        windowSaveCancelled.current = true;
        event.preventDefault(); event.returnValue = '';
        if (api.isDesktop) {
          window.setTimeout(() => { void api.resolveWindowTransition(false).catch((error: unknown) => notify(errorText(error), 'error')); }, 0);
          notify(t('请先完成或取消设置保存，再关闭或刷新窗口。'), 'info');
        }
        return;
      }
      if (composerBusyRef.current) {
        event.preventDefault(); event.returnValue = '';
        if (api.isDesktop) {
          // Let Electron record the prevented close/reload before cancelling its intent.
          window.setTimeout(() => { void api.resolveWindowTransition(false).catch((error: unknown) => notify(errorText(error), 'error')); }, 0);
          notify(t("正在处理提交内容，请等待完成后再离开。"), 'info');
        }
        return;
      }
      if ((!dirtyRef.current && !queueDirtyRef.current) || allowUnload.current) return;
      event.preventDefault(); event.returnValue = '';
      if (api.isDesktop) setPendingLeave({ windowTransition: true });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
  useEffect(() => {
    if (settingsDirty || queueDirty) allowUnload.current = false;
  }, [settingsDirty, queueDirty]);
  useEffect(() => {
    if (page !== 'settings' || detail || !openAdvanced || !advancedSettings.current) return;
    advancedSettings.current.open = true;
    advancedSettings.current.scrollIntoView({ block: 'center' });
    setOpenAdvanced(false);
  }, [page, detail, openAdvanced]);

  function openResourceTab(next: 'problem' | 'editorial' | 'reference') {
    setTab(next); setResourcesReload(value => value + 1);
  }

  function requestLeave(run: () => void) {
    if (dirtyRef.current) setPendingLeave({ run });
    else run();
  }
  function invalidatePageRefresh() {
    ++pageRefreshGeneration.current; pageRefreshRun.current = null; setRefreshingScope('');
  }
  function invalidateDateRequest(clearLocation = true) {
    window.clearTimeout(dateTimer.current); dateTimer.current = undefined;
    archiveNavigation.cancel();
    if (clearLocation) { dateValue.current = ''; dateSubmittedValue.current = ''; setDateInput(''); }
  }
  function changeDate(value: string) {
    if (dateValue.current === value) return;
    invalidateDateRequest(false); dateValue.current = value; dateSubmittedValue.current = ''; setDateInput(value);
    listPosition.current = null;
    try { validateDate(value); } catch { return; }
    dateTimer.current = window.setTimeout(() => locateDate(value), 350);
  }
  function locateDate(value = dateValue.current, repeat = false) {
    window.clearTimeout(dateTimer.current); dateTimer.current = undefined;
    try { validateDate(value); } catch { return; }
    if (!repeat && dateSubmittedValue.current === value) return;
    dateSubmittedValue.current = value;
    archiveNavigation.jump('date', value);
  }
  function selectMonth(value: string) {
    invalidateDateRequest(); listPosition.current = null; archiveNavigation.jump('month', value);
  }
  function clearFilters() {
    setSearch(''); setMinimumDifficulty(''); setMaximumDifficulty(''); setKindFilter('all');
  }
  function returnToList() {
    invalidateDateRequest(false);
    if (listPosition.current) listPosition.current.returning = true;
    setDetail(null);
  }
  function navigate(next: Page) {
    invalidateDateRequest(!(next === page && detail));
    if (next === page && !detail) return;
    requestLeave(() => {
      if (next === page && detail) returnToList();
      else { listPosition.current = null; setPage(next); setDetail(null); }
    });
  }
  function showDetail(day: ProblemDay, problem: Problem) {
    invalidateDateRequest(false);
    requestLeave(() => {
      const key = `${day.date}:${problem.id}`;
      const card = [...document.querySelectorAll<HTMLElement>('[data-problem-key]')].find(element => element.dataset.problemKey === key);
      listPosition.current = { page, key, offset: card?.getBoundingClientRect().top ?? 0, scrollY: window.scrollY, returning: false };
      setDetail({ day, problem }); setTab('problem'); setReference(null); setReferenceLanguage('all');
      window.scrollTo({ top: 0, behavior: 'auto' });
    });
  }
  function openComposer(next: Omit<Composer, 'instanceId'>) { invalidateDateRequest(); requestLeave(() => { setComposerDirty(false); setComposer({ ...next, instanceId: crypto.randomUUID() }); }); }
  function closeComposer() { setComposer(null); setComposerDirty(false); composerBusyRef.current = false; }
  function beginCompose(day: ProblemDay, problem: Problem) { openComposer({ day, problem }); }
  async function copy(text: string) { try { await api.copyText(text); notify(t("已复制到剪贴板")); } catch { notify(t("复制失败，请手动选择并复制"), 'error'); } }
  function openLogin() { invalidateDateRequest(); setLoginError(''); setLoginOpen(true); }
  async function startLogin() {
    const attempt = ++loginAttempt.current;
    setLoginBusy(true); setLoginError(''); setDeviceLogin(null);
    try { const login = await api.beginLogin(); if (attempt === loginAttempt.current) setDeviceLogin(login); }
    catch (error) { if (attempt === loginAttempt.current) { setLoginError(errorText(error)); setLoginBusy(false); } }
  }
  async function tokenLogin() {
    if (loginBusy) return;
    const attempt = ++loginAttempt.current;
    setLoginBusy(true); setLoginError('');
    try { const next = await api.loginWithToken(token.trim()); if (attempt !== loginAttempt.current) return; setAuth(next); setToken(''); if (next.user) { setLoginOpen(false); notify(t('已登录 GitHub · {{login}}', { login: next.user.login })); } }
    catch (error) { if (attempt === loginAttempt.current) setLoginError(errorText(error)); }
    finally { if (attempt === loginAttempt.current) setLoginBusy(false); }
  }
  function switchLoginMode(useToken: boolean) { ++loginAttempt.current; void api.cancelLogin().catch(() => undefined); setDeviceLogin(null); setLoginBusy(false); setTokenMode(useToken); setToken(''); setLoginError(''); }
  function closeLogin() { switchLoginMode(false); setLoginOpen(false); }
  function showAdvancedSettings() {
    invalidateDateRequest(); closeLogin();
    const leave = () => { closeComposer(); requestLeave(() => { listPosition.current = null; setPage('settings'); setDetail(null); setOpenAdvanced(true); }); };
    if (composer) composerCloseRequest.current?.(leave);
    else leave();
  }
  function resolveOAuthChange(confirmed: boolean) {
    const resolve = oauthConfirmation.current;
    oauthConfirmation.current = null; setOAuthChange(null); resolve?.(confirmed);
  }
  async function saveSettings(): Promise<boolean> {
    if (settingsSaveBusy.current) return false;
    if (forkSettingsBusyRef.current) { notify(t("请等待 Fork 操作完成后再保存。"), 'info'); return false; }
    settingsSaveBusy.current = true;
    setSettingsSaving(true);
    try {
      if (settingsForm.clientId !== settings.clientId) {
        const confirmed = await new Promise<boolean>(resolve => {
          oauthConfirmation.current = resolve;
          setOAuthChange({ previous: settings.clientId, next: settingsForm.clientId });
        });
        if (!confirmed) return false;
      }
      if (settingsForm.forkRepository && settingsForm.forkRepository !== settings.forkRepository) await api.validateFork(settingsForm.forkRepository);
      const saved = await api.saveSettings(settingsForm);
      setLocale(saved.uiLanguage ?? 'system', systemLanguages.current);
      setSettings(saved); setSettingsForm(saved); dirtyRef.current = false;
      notify(t("设置已保存"));
      const generation = authGeneration.current;
      void api.bootstrap().then(boot => { if (generation === authGeneration.current) setAuth(current => ({ ...current, configured: boot.auth.configured })); }).catch(() => undefined);
      return true;
    }
    catch (error) { notify(errorText(error), 'error'); return false; }
    finally { settingsSaveBusy.current = false; setSettingsSaving(false); }
  }
  async function cancelLeave() {
    if (settingsSaving) return;
    if (pendingLeave?.windowTransition) {
      try { await api.resolveWindowTransition(false); }
      catch (error) { notify(errorText(error), 'error'); return; }
    }
    setPendingLeave(null);
  }
  async function completeLeave(save: boolean) {
    const pending = pendingLeave;
    if (!pending || settingsSaving) return;
    if (save) {
      windowSaveCancelled.current = false;
      const saved = await saveSettings();
      // A further native close/reload while saving is explicitly cancelled.
      // Its cancellation also consumes the previous native intent; do not replay it.
      if (pending.windowTransition && windowSaveCancelled.current) { setPendingLeave(null); return; }
      if (!saved) return;
    }
    if (!save) { setSettingsForm(settings); dirtyRef.current = false; }
    if (pending.windowTransition) {
      allowUnload.current = true;
      try { await api.resolveWindowTransition(true); }
      catch (error) { allowUnload.current = false; notify(errorText(error), 'error'); return; }
    }
    setPendingLeave(null); pending.run?.();
  }
  const todayDate = today?.date || localDate();
  const activeTitle = detail ? t("题目详情") : t(NAV.find((item) => item.id === page)?.label || '设置');
  const scopeDays = useMemo(() => months.flatMap(entry => archiveIndex[entry.month] || []), [months, archiveIndex]);
  const difficultyRange = useMemo(() => parseDifficultyRange(minimumDifficulty, maximumDifficulty), [minimumDifficulty, maximumDifficulty, locale]);
  const matchingDays = useMemo(() => scopeDays.map((day) => ({ ...day, problems: day.problems.filter((problem) => {
    const term = search.trim().toLowerCase();
    return (!term || `${problem.id} ${problem.label} ${problem.hint} ${day.date}`.toLowerCase().includes(term))
      && matchesDifficulty(problem.rating, difficultyRange)
      && (kindFilter === 'all' || problemKind(problem) === kindFilter);
  }) })).filter(day => day.problems.length > 0).sort((a, b) => b.date.localeCompare(a.date)), [scopeDays, search, difficultyRange, kindFilter]);
  const matchingMonths = useMemo(() => months.map(entry => ({
    month: entry.month, days: matchingDays.filter(day => day.date.startsWith(entry.month)),
    total: (archiveIndex[entry.month] || []).reduce((total, day) => total + day.problems.length, 0),
  })), [months, matchingDays, archiveIndex]);
  const failedMonths = useMemo(() => new Set(indexFailures.map(failure => failure.month)), [indexFailures]);
  const archiveNavigation = useArchiveNavigation({ active: page === 'archive' && !detail, months, index: archiveIndex, matches: matchingDays,
    loading: directoryLoading || indexing, failedMonths, directoryError: Boolean(archiveError), stopped: indexStopped });
  const { activeMonth, locatedDate } = archiveNavigation;
  useEffect(() => {
    archiveNavigation.cancel();
    window.clearTimeout(dateTimer.current); dateTimer.current = undefined;
    listPosition.current = null;
  }, [search, minimumDifficulty, maximumDifficulty, kindFilter, archiveNavigation.cancel]);
  useEffect(() => {
    const cancelDeferredNavigation = (userIntent = false) => {
      if (dateTimer.current !== undefined) {
        window.clearTimeout(dateTimer.current); dateTimer.current = undefined;
        dateSubmittedValue.current = dateValue.current;
      }
      if (listPosition.current?.returning || userIntent && listVisible.current) listPosition.current = null;
    };
    const onIntent = () => cancelDeferredNavigation(true);
    const onScroll = () => cancelDeferredNavigation(false);
    const onKey = (event: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)
        && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement)) onIntent();
    };
    window.addEventListener('wheel', onIntent, { passive: true });
    window.addEventListener('touchstart', onIntent, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', onIntent); window.removeEventListener('touchstart', onIntent);
      window.removeEventListener('scroll', onScroll); window.removeEventListener('keydown', onKey);
    };
  }, []);
  const visibleCount = matchingDays.reduce((total, day) => total + day.problems.length, 0);
  const allProblemCount = scopeDays.reduce((total, day) => total + day.problems.length, 0);
  const loadedMonths = months.filter(entry => Object.hasOwn(archiveIndex, entry.month)).length;
  const indexComplete = !indexing && !directoryLoading && !indexStopped && !indexingError && !archiveError && !indexFailures.length && loadedMonths === months.length;
  const checkingRetainedArchive = archiveRetained && directoryLoading;
  const archiveNeedsStatus = directoryLoading || indexing || indexStopped || Boolean(indexingError || archiveError) || indexFailures.length > 0;
  const hasFilters = Boolean(search.trim() || difficultyRange.active || kindFilter !== 'all');
  const archiveEmptyTitle = indexing ? t("正在读取全库题目…")
    : !months.length ? archiveError ? t("题库目录暂时无法读取") : directoryLoading ? t("正在读取题库目录…") : t("仓库中暂无历史题单")
    : hasFilters ? t("没有匹配的题目") : t("本次未读取到题目");
  const archiveEmptyDescription = indexing ? t("正在从仓库逐月读取题单。")
    : !months.length ? archiveError ? t("可点击刷新题库重试。") : directoryLoading ? t("正在获取月份目录…") : t("刷新题库可重新读取仓库目录。")
    : hasFilters ? t("试试其他关键词、难度范围或题目类型。") : t("可重新加载全库后继续检索。");
  const cardHandlers = useRef({ openExternal, showDetail, beginCompose });
  cardHandlers.current = { openExternal, showDetail, beginCompose };
  const problemCardProps = useMemo(() => ({ account: auth.user?.login, records: indexedItems, incomplete: !statusIndex.complete,
    onOpen: (url: string) => cardHandlers.current.openExternal(url),
    onDetail: (day: ProblemDay, problem: Problem) => cardHandlers.current.showDetail(day, problem),
    onCompose: (day: ProblemDay, problem: Problem) => cardHandlers.current.beginCompose(day, problem),
  }), [auth.user?.login, indexedItems, statusIndex.complete]);
  const referenceOptions = [...new Set(resources?.references.map((file) => file.language) ?? [])];
  const effectiveReferenceLanguage = referenceOptions.includes(referenceLanguage) ? referenceLanguage : 'all';
  const visibleReferences = resources?.references.filter((file) => effectiveReferenceLanguage === 'all' || file.language === effectiveReferenceLanguage) ?? [];
  useEffect(() => {
    if (resources && referenceLanguage !== 'all' && !resources.references.some(file => file.language === referenceLanguage)) setReferenceLanguage('all');
  }, [resources, referenceLanguage]);
  useEffect(() => {
    const position = listPosition.current;
    if (!position?.returning || detail || page !== position.page) return;
    if (page === 'archive' && (directoryLoading || indexing) && !archiveRetained) return;
    if (page === 'today' && dayLoading && !dayRetained) return;
    const card = [...document.querySelectorAll<HTMLElement>('[data-problem-key]')].find(element => element.dataset.problemKey === position.key);
    const daySection = card?.closest<HTMLElement>('.archive-day');
    daySection?.classList.add('archive-navigation-target');
    let second = 0;
    const frame = requestAnimationFrame(() => {
      if (listPosition.current !== position) return;
      position.returning = false;
      const restore = () => window.scrollTo({ top: card ? window.scrollY + card.getBoundingClientRect().top - position.offset : position.scrollY, behavior: 'instant' });
      restore();
      second = requestAnimationFrame(() => {
        if (listPosition.current !== position) return;
        restore(); listPosition.current = null; daySection?.classList.remove('archive-navigation-target');
      });
    });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(second); daySection?.classList.remove('archive-navigation-target'); };
  }, [page, detail, directoryLoading, indexing, dayLoading, today, archiveIndex, dayRetained, archiveRetained]);

  function ContributionIndexNotice() {
    if (!auth.user || statusIndex.complete) return null;
    return <div className="contribution-index-note" role="status">{statusIndex.loading ? <LoaderCircle size={15} className="spin" /> : <CircleHelp size={15} />}<div><span>{statusIndex.loading ? t('正在读取 PR 状态 · 已读取 {{loaded}} / {{total}} 个 PR', { loaded: statusIndex.loaded, total: statusIndex.total ?? '—' }) : t("状态未完整获取")}</span>{statusIndex.error && <small>{statusIndex.error}</small>}{statusIndex.truncated && <small>{t("GitHub 返回的记录或文件列表存在数量限制，未匹配到的题目仍可能有提交记录。")}</small>}</div>{!statusIndex.loading && <button className="text-button" onClick={() => void refreshHistory()}>{t("重新读取")}<RefreshCw size={13} /></button>}</div>;
  }

  function ResourceLoading() { return <div className="inline-loading"><LoaderCircle className="spin" size={19} />{t("正在读取题目资料…")}</div>; }

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('today')} aria-label={t("小羊肖恩的每日一题，返回首页")}><span className="brand-mark"><AppLogo /></span><span><strong>{t("小羊肖恩的每日一题")}</strong><small>Daily CF Problems</small></span></button>
      <div className="nav-caption">{t("题库导航")}</div>
      <nav aria-label={t("主导航")}>{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => navigate(id)} aria-current={page === id ? 'page' : undefined}><Icon size={19} /><span>{t(label)}</span>{page === id && <span className="nav-dot" />}</button>)}</nav>
      <div className="sidebar-bottom">
        <button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings2 size={19} /><span>{t("设置")}</span></button>
        <div className="repository-links">
          <button className="repository-link" aria-label={t("题库仓库")} title={t("题库仓库") + ' · ' + UPSTREAM.url} onClick={() => openExternal(UPSTREAM.url)}><Github size={17} /><span>{t("题库仓库")}</span><ArrowUpRight size={14} /></button>
          <button className="repository-link" aria-label={t("客户端源码")} title={t("客户端源码") + ' · ' + CLIENT_REPOSITORY.url} onClick={() => openExternal(CLIENT_REPOSITORY.url)}><Code2 size={17} /><span>{t("客户端源码")}</span><ArrowUpRight size={14} /></button>
        </div>
        <div className="sidebar-version"><span className="status-dot" /><span className="sidebar-version-name">{t("小羊肖恩的每日一题")}</span>{version && <span className="sidebar-version-number">v{version}</span>}</div>
      </div>
    </aside>

    <div className="workspace">
      <header className="topbar"><div className="breadcrumb"><span>{t("每日一题")}</span><ChevronRight size={14} /><strong>{activeTitle}</strong></div><div className="topbar-actions"><span className="repo-badge"><span className="status-dot" />Daily CF Problems</span><Button kind="primary" onClick={() => openComposer({})} disabled={booting} title={t("查看提交列表")}><ListPlus size={16} />{t("提交列表")}<span className="count-badge">{queueEntries.length}</span></Button>{auth.user ? <button className="account-button" onClick={() => navigate('settings')}><img src={auth.user.avatarUrl} alt="" /><span>{auth.user.login}</span><ChevronDown size={14} /></button> : <Button onClick={openLogin} disabled={!api.isDesktop || booting}><Github size={16} />{t("登录 GitHub")}</Button>}</div></header>
      {!api.isDesktop && <div className="preview-banner"><Code2 size={16} /><span>{t("浏览器预览模式 · 题库可以浏览；登录、代码导入与自动提交请使用桌面客户端。")}</span></div>}
      {repository !== 'Yawn-Sean/Daily_CF_Problems' && <div className="test-banner"><GitBranch size={16} /><span>{t('测试仓库模式 · 当前 PR 目标：{{repository}}。提交不会进入正式上游仓库。', { repository })}</span></div>}
      <main className="main-content">
        {bootError && <div className="alert alert-error"><WifiOff size={18} /><div><strong>{t("本地配置读取失败")}</strong><p>{bootError}</p></div><Button onClick={() => void bootstrap()}>{t("重试")}</Button></div>}
        {api.isDesktop && <LibrarySyncNotice progress={librarySync} onRefresh={detail ? refreshDetail : page === 'settings' ? () => void refreshPage('settings') : undefined} refreshing={detail ? detailLoading : pageRefreshing} />}

        {(detail || page === 'today' || page === 'archive') && <ContributionIndexNotice />}
        {detail ? <>
          <button className="back-link" onClick={returnToList}><ArrowLeft size={16} />{page === 'archive' ? t('返回历史题库') : t('返回题目列表')}</button>
          {detailRead.missing || !detailRead.data && detailError ? <div className="panel"><Empty icon={detailLoading ? <LoaderCircle className="spin" /> : <WifiOff />} title={detailLoading ? t("正在读取题目…") : t("题目读取失败")} action={<Button disabled={detailLoading} onClick={() => setDetailReload(value => value + 1)}>{t("重新加载")}</Button>}>{detailError}</Empty></div> : <>
          <RetainedContentNotice retained={detailRead.retained} loading={detailLoading} error={detailError} onRetry={refreshDetail} />
          <section className="detail-heading"><div><div className="eyebrow">{detail.day.date}</div><h1>{problemTitle(detail.problem)}</h1><div className="detail-meta"><span>{detail.problem.id.toUpperCase()}</span><span className={`problem-kind kind-${problemKind(detail.problem)}`}>{problemKind(detail.problem) === 'gym' ? 'Gym' : 'CF Round'}</span><Rating rating={detail.problem.rating} source={detail.problem.ratingSource} /><span><CalendarDays size={15} />{formatDate(detail.day.date)}</span></div></div><div className="detail-submit-actions"><Button kind="primary" onClick={() => beginCompose(detail.day, detail.problem)}><ListPlus size={17} />{t("加入提交列表")}</Button></div></section>
          <SourceWarning problem={detail.problem} />{auth.user && <section className="panel detail-contribution-panel" aria-label={t("这道题的提交记录")}><div><h2>{t("这道题的提交记录")}</h2><ProblemContributionStatus problemId={detail.problem.id} records={indexedItems} incomplete={!statusIndex.complete} onOpen={openExternal} /></div></section>}<div className="detail-layout"><section className="panel resource-panel"><div className="tabs" role="tablist" aria-label={t("题目资料")}><button role="tab" aria-selected={tab === 'problem'} className={tab === 'problem' ? 'active' : ''} onClick={() => openResourceTab('problem')}><BookOpen size={17} />{t("题目与提示")}</button><button role="tab" aria-selected={tab === 'editorial'} className={tab === 'editorial' ? 'active' : ''} onClick={() => openResourceTab('editorial')}><Sparkles size={17} />{t("题解")}</button><button role="tab" aria-selected={tab === 'reference'} className={tab === 'reference' ? 'active' : ''} onClick={() => openResourceTab('reference')}><Code2 size={17} />{t("参考代码")}{resources && <span>{resources.references.length}</span>}</button></div>
            <div className="resource-content" role="tabpanel">
              {tab !== 'problem' && <RetainedContentNotice retained={resourcesRead.retained} loading={resourcesBusy} error={resourcesError} onRetry={() => setResourcesReload(value => value + 1)} />}
              {tab === 'problem' && <><div className="problem-source-action"><Button onClick={() => openExternal(detail.problem.url)} disabled={openingUrls.has(detail.problem.url)}>{openingUrls.has(detail.problem.url) ? <LoaderCircle size={16} className="spin" /> : <ExternalLink size={16} />}{t("在浏览器中打开题目")}</Button></div><h3 className="section-subtitle">{t("解题提示")}</h3><details className="hint-disclosure"><summary><CircleHelp size={18} /><span>{t("查看提示")}</span><span className="hint-expand">{t("展开")}<ChevronDown size={16} /></span></summary><div className="hint-content"><Markdown content={detail.problem.hint || t("仓库尚未为这道题提供提示。")} /></div></details></>}
              {tab === 'editorial' && (resourcesBusy && !resources ? <ResourceLoading /> : resourcesError && !resources ? <Empty icon={<WifiOff />} title={t("题解暂时没有加载成功")} action={<Button onClick={() => { setResourcesReload((value) => value + 1); }}>{t("重新加载")}</Button>}>{resourcesError}</Empty> : resources?.editorial ? <><div className="resource-caption"><span>{t("仓库题解 ·")}{detail.day.date}</span>{resources.editorialUrl && <button className="text-button" onClick={() => openExternal(resources.editorialUrl!)}>{t("查看来源")}<ExternalLink size={14} /></button>}</div><Markdown content={resources.editorial} /></> : <Empty title={t("这道题暂未找到仓库题解")} action={resources?.editorialUrl ? <Button onClick={() => openExternal(resources.editorialUrl!)}>{t("打开题解链接")}<ExternalLink size={15} /></Button> : <Button onClick={() => openExternal(detail.day.sourceUrl)}>{t("查看仓库原文")}<ExternalLink size={15} /></Button>}>{t("可查看提示或参考代码。")}</Empty>)}
              {tab === 'reference' && (resourcesBusy && !resources ? <ResourceLoading /> : resourcesError && !resources ? <Empty icon={<WifiOff />} title={t("参考代码暂时无法加载")} action={<Button onClick={() => { setResourcesReload((value) => value + 1); }}>{t("重新加载")}</Button>}>{resourcesError}</Empty> : !resources?.references.length ? <Empty icon={<FileCode2 />} title={t("暂无参考代码")}>{t("仓库中未找到这道题的参考代码。")}</Empty> : <><div className="reference-filter"><span>{t('共 {{count}} 份参考代码', { count: resources.references.length })}</span><select aria-label={t("参考代码语言筛选")} value={effectiveReferenceLanguage} onChange={(event) => { setReferenceLanguage(event.target.value); setReference(null); }}><option value="all">{t("全部语言")}</option>{referenceOptions.map((language) => <option key={language} value={language}>{languageLabel(language)}</option>)}</select></div><div className="reference-layout"><div className="reference-list">{visibleReferences.map((file) => <button key={file.path} title={file.name} className={reference?.path === file.path ? 'active' : ''} onClick={() => { setReference(file); setReferenceReload(value => value + 1); }}><FileCode2 size={16} /><span>{file.name}<small>{languageLabel(file.language)}</small></span></button>)}</div><div className="reference-viewer">{!reference ? <Empty icon={<Code2 />} title={t("选择参考代码")}>{t("点击左侧文件查看代码。")}</Empty> : <><div className="code-toolbar"><span title={reference.name}>{reference.name}</span><div><button title={t("在 GitHub 查看")} aria-label={t("在 GitHub 查看参考代码")} onClick={() => openExternal(reference.url)}><ExternalLink size={15} /></button><button title={t("复制代码")} aria-label={t("复制参考代码")} onClick={() => void copy(referenceCode)} disabled={!referenceCode}><Copy size={15} /></button></div></div><RetainedContentNotice retained={referenceRead.retained} loading={referenceBusy} error={referenceError} onRetry={() => setReferenceReload(value => value + 1)} />{referenceBusy && referenceRead.data === undefined ? <ResourceLoading /> : referenceError && referenceRead.data === undefined ? <div className="inline-error">{referenceError}<button className="text-button" onClick={() => { setReferenceReload(value => value + 1); }}>{t("重新加载参考代码")}<RefreshCw size={14} /></button></div> : <CodeHighlight code={referenceCode} language={reference.language || reference.name.split('.').pop()} className="code-view" />}</>}</div></div></>)}
            </div>
          </section></div>
          </>}
        </> : page === 'today' ? <>
          <section className="today-heading"><div><h1>{t("最新题目")}</h1><p>{today ? `${today.date} · ${formatDate(today.date)}` : dayLoading ? t("正在读取最新题单…") : dayError ? t("最新题单读取失败") : t("仓库暂未提供题单")}</p></div><div className="today-heading-actions"><Button onClick={() => void refreshPage('today')} disabled={pageRefreshing || librarySyncBusy || !libraryRetryReady}><RefreshCw size={16} className={pageRefreshing ? 'spin' : ''} />{pageRefreshing ? t("刷新中…") : t("刷新")}</Button><Button onClick={() => navigate('archive')}><CalendarDays size={16} />{t("历史题库")}</Button></div></section>
          <div className="home-columns"><div><div className="section-heading"><div><h2>{t("题目列表")}<span className="count-badge">{today?.problems.length ?? '—'}</span></h2><p>{today ? t('仓库最新题单：{{date}}', { date: today.date }) : dayLoading ? t("正在加载") : dayError ? t("读取失败，请重新加载。") : t("暂无题目")}</p></div></div>
            <RetainedContentNotice retained={dayRetained} loading={dayLoading} error={dayError} onRetry={() => void refreshPage('today')} />
            {dayLoading && !today ? <div className="problem-grid"><div className="skeleton skeleton-card" /><div className="skeleton skeleton-card" /></div> : dayError && !today ? rateLimit ? <GitHubRateLimitNotice info={rateLimit} signedIn={Boolean(auth.user)} ready={libraryRetryReady} onLogin={api.isDesktop ? openLogin : undefined} onRetry={() => void refreshPage('today')} /> : <div className="panel"><Empty icon={<WifiOff />} title={t("题库加载失败")} action={<Button onClick={() => void refreshPage('today')} disabled={pageRefreshing || !libraryRetryReady}>{t("重新加载")}<RefreshCw size={15} /></Button>}>{dayError}</Empty></div> : today?.problems.length ? <><div className="problem-grid">{today.problems.map((problem, index) => <ProblemCard {...problemCardProps} key={problem.id} day={today} problem={problem} index={index} />)}</div></> : <div className="panel"><Empty title={t("这一天还没有题目")} action={<Button onClick={() => navigate('archive')}>{t("浏览历史题库")}</Button>}>{t("可在历史题库中选择其他日期。")}</Empty></div>}
            
          </div><aside className="home-aside"><section className="panel progress-card"><div className="mini-section-heading"><h3>{t("我的提交")}</h3><button className="icon-button" title={t("刷新 GitHub 提交统计")} aria-label={t("刷新 GitHub 提交统计")} onClick={() => void refreshHistory()} disabled={!auth.user || historyBusy}><RefreshCw size={15} className={historyBusy ? 'spin' : ''} /></button></div>{!auth.user ? <div className="contribution-connect"><Github size={24} /><p>{t('登录账号，查看你在仓库中的全部提交记录。')}</p><button className="text-button" onClick={openLogin} disabled={!api.isDesktop}>{t("登录 GitHub")}<ArrowUpRight size={13} /></button></div> : !statistics ? historyError ? <div className="contribution-fetch-error"><p>{historyError}</p><button className="text-button" onClick={() => void refreshHistory()}>{t("重新加载")}<RefreshCw size={13} /></button></div> : <div className="contribution-loading"><LoaderCircle size={17} className="spin" />{t("正在读取 GitHub…")}</div> : <><div className="progress-numbers"><div><strong>{statistics.totalCount}</strong><span>{t("PR 总数")}</span></div><div><strong>{statistics.openCount}</strong><span>{t("处理中")}</span></div><div><strong>{statistics.mergedCount}</strong><span>{t("已合并")}</span></div></div><p className="stats-source">{t("包含在 GitHub 手动创建的 PR")}</p>{statistics.incomplete && <p className="stats-warning">{t("GitHub 返回的数据暂不完整，刷新可重试。")}</p>}</>}<div className="progress-card-footer">{auth.user ? <button onClick={() => navigate('history')}>{t("查看全部提交")}<ArrowRight size={13} /></button> : <><ShieldCheck size={14} /><span>{t("直接读取 GitHub 记录")}</span></>}</div></section></aside></div>
          
        </> : page === 'archive' ? <>
          <div className="page-heading">
            <div><h1>{t("历史题库")}</h1><p>{t("按月份、日期和难度查找题目。支持补交历史题目。")}</p></div>
            <Button onClick={() => void refreshPage('archive')} disabled={pageRefreshing || archiveRefreshing || librarySyncBusy || !libraryRetryReady}>
              <RefreshCw size={16} className={pageRefreshing || archiveRefreshing ? 'spin' : ''} />
              {pageRefreshing || archiveRefreshing ? t("刷新中…") : t("刷新")}
            </Button>
          </div>
          <RetainedContentNotice retained={archiveRetained} loading={directoryLoading || indexing} error={archiveError || indexingError} onRetry={() => void refreshPage('archive')} />
          {rateLimit && <GitHubRateLimitNotice info={rateLimit} signedIn={Boolean(auth.user)} ready={libraryRetryReady} onLogin={api.isDesktop ? openLogin : undefined} onRetry={() => void refreshPage('archive')} />}
          <div id="archive-browser" className="archive-layout">
            <aside className="panel months-panel" aria-label={t("按月份快速跳转")}>
              <div className="mini-section-heading"><h3><CalendarDays size={16} />{t("快速跳转")}</h3><span>{t('{{count}} 个月', { count: months.length })}</span></div>
              {!months.length ? <p className="muted-note">{directoryLoading ? t("正在读取归档目录…") : archiveError ? t("目录未加载") : t("暂无月份")}</p> :
                <nav className="months-list" aria-label={t("月份目录")}>{matchingMonths.map((entry, index) => {
                  const loaded = Object.hasOwn(archiveIndex, entry.month);
                  const count = entry.days.reduce((sum, day) => sum + day.problems.length, 0);
                  const state = !loaded ? failedMonths.has(entry.month) ? t("读取失败") : indexingMonth === entry.month && indexing ? t("读取中") : t("待加载")
                    : hasFilters ? count ? `${count} / ${entry.total}` : t("无匹配") : t('{{count}} 道题', { count: entry.total });
                  return <div key={entry.month}>
                    {(index === 0 || matchingMonths[index - 1].month.slice(0, 4) !== entry.month.slice(0, 4)) && <div className="year-label">{entry.month.slice(0, 4)}</div>}
                    <button data-month-jump={entry.month} className={`${activeMonth === entry.month ? 'active' : ''} ${loaded && !count ? 'month-without-matches' : ''}`}
                      aria-current={activeMonth === entry.month ? 'location' : undefined} onClick={() => selectMonth(entry.month)}
                      title={t('跳转到 {{month}}', { month: entry.month })}>
                      <span>{formatDate(`${entry.month}-01`, { month: 'short' })}</span><small>{state}</small>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  </div>;
                })}</nav>
              }
              {archiveNavigation.notice && <div className="archive-navigation-note" role="status">
                {archiveNavigation.notice.waiting && <LoaderCircle size={14} className="spin" />}
                <span>{archiveNavigation.notice.text}</span>
                <button className="icon-button" aria-label={t("关闭提示")} onClick={archiveNavigation.cancel}><X size={14} /></button>
              </div>}
            </aside>
            <div className="archive-main">
              <section className="panel archive-toolbar">
                {!checkingRetainedArchive && !indexComplete && archiveNeedsStatus && <div className="index-panel">
                  <div>
                    <strong>{directoryLoading ? t("正在读取全部月份目录…") : indexing ? t('正在读取 {{month}} 的题目…', { month: indexingMonth }) : indexStopped ? t("全库加载已停止") : indexingError || indexFailures.length || archiveError ? t("全库加载未完成") : !months.length ? t("仓库中暂无历史题单") : t("正在准备全库检索…")}</strong>
                    <p>{archiveRetained ? indexing || directoryLoading ? t("正在读取新题单，完成后会替换下方内容。") : t("题库更新未完成，当前显示上次读取的内容。") : t('已读取 {{loaded}} / {{total}} 个月。下方仅显示本次已读取的题目。', { loaded: loadedMonths, total: indexingTotal || months.length })}</p>
                    {!rateLimit && indexingError && !indexFailures.length && <p className="index-error">{indexingError}</p>}
                    {!rateLimit && indexFailures.length > 0 && <ul className="index-failures">
                      {indexFailures.map(failure => <li key={failure.month}>{failure.month}：{failure.error}</li>)}
                    </ul>}
                  </div>
                  {indexing || directoryLoading ? <Button onClick={stopIndexing}><X size={13} />{t("停止加载")}</Button> : !directoryLoading &&
                    <Button onClick={() => void indexArchive()} disabled={archiveRefreshing || !libraryRetryReady}><RefreshCw size={14} />{t("重新加载全库")}</Button>}
                  {indexing && !directoryLoading && <progress value={indexingCompleted} max={indexingTotal || 1} aria-label={t("全库加载进度")} />}
                </div>}
                <div className="search-field">
                  <Search size={18} />
                  <input aria-label={t("搜索全库题目")} value={search} onChange={event => setSearch(event.target.value)} placeholder={t("搜索题号、标题、提示或日期…")} />
                  {search && <button aria-label={t("清空搜索")} onClick={() => setSearch('')}><X size={15} /></button>}
                </div>
                <div className="filter-row difficulty-range-row">
                  <div className="difficulty-range-inputs" role="group" aria-label={t("难度范围")}>
                    <label className="field"><span>{t("最低难度")}</span>
                      <input type="text" inputMode="numeric" value={minimumDifficulty} onChange={event => setMinimumDifficulty(event.target.value)} placeholder={t("不限")} aria-invalid={Boolean(difficultyRange.error)} aria-describedby={difficultyRange.error ? 'difficulty-range-error' : 'difficulty-range-help'} />
                    </label>
                    <span className="difficulty-range-separator" aria-hidden="true">—</span>
                    <label className="field"><span>{t("最高难度")}</span>
                      <input type="text" inputMode="numeric" value={maximumDifficulty} onChange={event => setMaximumDifficulty(event.target.value)} placeholder={t("不限")} aria-invalid={Boolean(difficultyRange.error)} aria-describedby={difficultyRange.error ? 'difficulty-range-error' : 'difficulty-range-help'} />
                    </label>
                    <button className="text-button" onClick={() => { setMinimumDifficulty(''); setMaximumDifficulty(''); }} disabled={!minimumDifficulty && !maximumDifficulty}>{t("清除难度范围")}</button>
                  </div>
                  
                </div>
                {difficultyRange.error ? <p id="difficulty-range-error" className="difficulty-range-error" role="alert">{difficultyRange.error}</p> :
                  <p id="difficulty-range-help" className="difficulty-range-help">{t("留空不限，范围包含上下边界。")}{difficultyRange.active && t("未标注难度的题目不参与范围筛选。")}</p>}
                <div className="metadata-filter-row">
                  <label><span>{t("题目类型")}</span><select aria-label={t("题目类型筛选")} value={kindFilter} onChange={event => setKindFilter(event.target.value)}>
                    <option value="all">{t("全部类型")}</option><option value="round">CF Round</option><option value="gym">Gym</option>
                  </select></label>
                  <button className="text-button clear-all-filters" disabled={!hasFilters} onClick={clearFilters}><X size={14} />{t("清除筛选")}</button>
                </div>
              </section>
              <div className="archive-results-heading">
                <h2>{hasFilters ? t("搜索结果") : t("全部题目")}<span>{difficultyRange.error ? t("难度范围无效") : t('{{visible}} / {{total}} 道题', { visible: visibleCount, total: allProblemCount })}</span></h2>
                <label className="date-jump"><span>{t("定位日期")}</span>
                  <input type="date" aria-label={t("选择题目日期")} value={dateInput} onInput={event => changeDate(event.currentTarget.value)} onChange={event => changeDate(event.target.value)} onBlur={() => locateDate()} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); locateDate(dateValue.current, true); event.currentTarget.blur(); } }} />
                </label>
              </div>
              {difficultyRange.error ? <div className="panel">
                <Empty icon={<CircleHelp />} title={t("请调整难度范围")}>{difficultyRange.error}</Empty>
              </div> : !matchingDays.length ? <div className="panel">
                <Empty icon={<Search />} title={archiveEmptyTitle}>{archiveEmptyDescription}</Empty>
              </div> : <div className="archive-days">
                {matchingMonths.filter(entry => entry.days.length > 0).map(entry => <section className="archive-month" data-archive-month={entry.month} key={entry.month}>
                  <h2 className="archive-month-heading">{formatDate(`${entry.month}-01`, { year: 'numeric', month: 'long' })}<span>{t('{{count}} 道题', { count: entry.days.reduce((sum, day) => sum + day.problems.length, 0) })}</span></h2>
                  {entry.days.map(day => <section className={`archive-day ${day.date === locatedDate ? 'archive-day-located' : ''}`} data-problem-date={day.date} key={day.date}>
                    <div className="archive-day-heading"><span>{day.date}</span><small>{formatDate(day.date, { weekday: 'long' })}</small><i /></div>
                    <div className="problem-grid">{day.problems.map((problem, index) =>
                      <ProblemCard {...problemCardProps} key={problem.id} day={day} problem={problem} index={index} compact />
                    )}</div>
                  </section>)}
                </section>)}
              </div>}
            </div>
          </div>
        </> : page === 'history' ? <>
          <div className="page-heading"><div><h1>{t("提交记录")}</h1><p>{t('此仓库中由你发起的 PR，包括手动提交。仓库：{{repository}}', { repository })}</p></div><Button onClick={() => void refreshPage('history')} disabled={pageRefreshing || librarySyncBusy || historyBusy}>{pageRefreshing || historyBusy ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{t("刷新")}</Button></div>
          {!auth.user ? <div className="panel"><Empty icon={<Github />} title={t("登录 GitHub，查看你的提交")} action={<Button kind="primary" onClick={openLogin} disabled={!api.isDesktop}><Github size={16} />{t("登录 GitHub")}</Button>}>{t("客户端会读取你在此仓库发起的 Pull Request，无论它们通过什么方式提交。")}</Empty></div> : <>
            {statistics && <div className="history-summary"><span>{t("全部")}<strong>{statistics.totalCount}</strong></span><span>{t("处理中")}<strong>{statistics.openCount}</strong></span><span>{t("已合并")}<strong>{statistics.mergedCount}</strong></span><span>{t("已关闭")}<strong>{statistics.closedCount}</strong></span><small>{t('读取于 {{time}}', { time: timeLabel(statistics.fetchedAt) })}</small></div>}
            {historyError && <div className="alert alert-error"><WifiOff size={17} /><div><strong>{t("GitHub 记录读取失败")}</strong><p>{historyError}</p></div><Button onClick={() => void refreshHistory()} disabled={historyBusy}>{t("重试")}</Button></div>}
            {statistics?.incomplete && <div className="alert alert-info"><CircleHelp size={16} /><span>{t("GitHub 返回了不完整的搜索结果，或统计期间记录发生变化。你可以刷新以重新读取。")}</span></div>}
            {!statistics && historyBusy ? <div className="panel"><div className="inline-loading"><LoaderCircle className="spin" size={19} />{t("正在从 GitHub 读取提交记录…")}</div></div> : statistics && !history.length ? <div className="panel"><Empty icon={<GitPullRequest />} title={t("还没有在这个仓库发起 PR")} action={<Button kind="primary" onClick={() => navigate('today')}>{t("浏览题目")}<ArrowRight size={16} /></Button>}>{t("选择题目并上传代码，加入提交列表后统一创建 PR。")}</Empty></div> : history.length > 0 && <ContributionList items={history} openExternal={openExternal} />}
            {statistics && <div className="history-pagination"><span>{t('已显示 {{shown}} / {{total}} 个 PR', { shown: history.length, total: statistics.totalCount })}{statistics.truncated && t(" · GitHub 搜索最多提供前 1000 条")}</span>{statistics.hasMore ? <Button onClick={() => void loadMoreHistory()} disabled={historyBusy}>{historyBusy ? <LoaderCircle size={15} className="spin" /> : <ChevronDown size={15} />}{t("加载更多")}</Button> : statistics.truncated && <Button onClick={() => openExternal(`https://github.com/${repository}/pulls?q=is%3Apr+author%3A${encodeURIComponent(auth.user!.login)}`)}>{t("在 GitHub 查看全部")}<ExternalLink size={14} /></Button>}</div>}
          </>}
        </> : <>
          <div className="page-heading"><div><h1>{t("设置")}</h1><p>{t("配置 GitHub、Fork 仓库、PR 模板和外观。")}</p></div><Button kind="primary" onClick={() => void saveSettings()} disabled={settingsSaving || forkSettingsBusy}>{settingsSaving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{t("保存设置")}</Button></div>
          <div className="settings-layout"><fieldset className="settings-main settings-form-fields" disabled={settingsSaving}><section className="panel settings-section"><h2><Github size={20} />{t("GitHub 账号")}</h2>{auth.user ? <div className="connected-account"><img src={auth.user.avatarUrl} alt="" /><div><strong>{auth.user.name || auth.user.login}</strong><p>@{auth.user.login} <span className="connected-label"><CheckCircle2 size={12} />{t("已登录")}</span></p></div><Button kind="ghost" onClick={() => setLogoutConfirm(true)}><LogOut size={15} />{t("退出登录")}</Button></div> : <div className="settings-account"><p>{t("登录后可选择 Fork 仓库、提交代码和查看 PR。")}</p><Button onClick={openLogin} disabled={!api.isDesktop}><Github size={16} />{t("登录 GitHub")}</Button></div>}<div className="settings-security"><ShieldCheck size={16} /><span>{auth.secureStorage ? t("登录凭据由操作系统安全存储保护。") : api.isDesktop ? t("当前无法保存登录状态，重启后需重新登录。") : t("浏览器预览不保存 GitHub 凭据。")}</span></div></section><ForkSettings auth={auth} repository={repository} value={settingsForm.forkRepository || ''} onBusyChange={busy => { forkSettingsBusyRef.current = busy; setForkSettingsBusy(busy); }} onChange={(forkRepository) => setSettingsForm((current) => ({ ...current, forkRepository }))} /><section className="panel settings-section"><h2><FileCode2 size={20} />{t("提交偏好")}</h2><div className="form-grid"><label className="field"><span>{t("默认编程语言")}</span><select value={settingsForm.language} onChange={(event) => setSettingsForm({ ...settingsForm, language: event.target.value as Language })}>{LANGUAGES.map((language) => <option key={language.id} value={language.id}>{languageLabel(language.id)}</option>)}</select><small>{t("每次提交时仍然可以单独调整。")}</small></label></div></section><TemplateSettings settings={settingsForm} onChange={(patch) => setSettingsForm((current) => ({ ...current, ...patch }))} input={{ date: today?.date || localDate(), problemId: today?.problems[0]?.id || 'cf1234a', language: settingsForm.language, author: 'example_author', code: '// template preview', notes: t("这里会显示你填写的补充说明。") }} login={auth.user?.login || 'your_handle'} problem={today?.problems[0]} /><AppearanceSettings settings={settingsForm} onChange={(patch) => setSettingsForm((current) => ({ ...current, ...patch }))} /><section className="panel settings-section"><details className="advanced-settings" ref={advancedSettings}><summary><Settings2 size={19} /><span>{t("高级设置 · GitHub OAuth")}</span><small className="oauth-caution-label"><TriangleAlert size={14} />{t("谨慎修改")}</small><ChevronDown size={16} /></summary><div className="alert alert-warning oauth-settings-warning" id="oauth-settings-warning"><TriangleAlert size={19} /><div><strong>{t("修改此项会影响 GitHub 授权登录")}</strong><p>{t("通常无需修改。错误或空的 Client ID 会使浏览器授权登录不可用；填写其他应用的 ID 会改变授权对象，请仅使用你信任的应用。")}</p><p>{t("已有登录不会因此自动退出，问题可能在下次登录时才出现。")}</p></div></div><p>{t("开发者或自行构建客户端时，可填写启用了 Device Flow 的 GitHub OAuth App Client ID。Client ID 是公开标识，不是 Client Secret。")}</p><label className="field"><span>OAuth Client ID</span><input aria-describedby="oauth-settings-warning" value={settingsForm.clientId} onChange={(event) => setSettingsForm({ ...settingsForm, clientId: event.target.value.trim() })} placeholder="Ov23… / Iv1…" autoComplete="off" /><small>{t("填写并保存后，可使用浏览器设备授权登录。也可直接使用个人访问令牌登录。")}</small></label><div className="oauth-default-control"><Button onClick={() => setSettingsForm(current => ({ ...current, clientId: defaultClientId }))} disabled={!defaultClientId || settingsForm.clientId === defaultClientId}><RefreshCw size={14} />{t("恢复默认")}</Button>{!defaultClientId && <small>{t("此版本未内置 OAuth Client ID，无法恢复默认。可手动填写，或使用个人访问令牌登录。")}</small>}</div><button className="text-button" onClick={() => openExternal('https://github.com/settings/developers')}>{t("管理 GitHub OAuth Apps")}<ExternalLink size={14} /></button></details></section><LocalDataSettings /><div className="settings-save-bar"><span>{settingsDirty ? t("有尚未保存的修改") : t("设置已保存")}</span><Button kind="primary" onClick={() => void saveSettings()} disabled={settingsSaving || forkSettingsBusy || !settingsDirty} title={t("保存当前设置")}>{settingsSaving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{t("保存设置")}</Button></div></fieldset><aside><section className="panel about-card"><span className="about-logo"><AppLogo /></span><h3>{t("小羊肖恩的每日一题")}</h3><p>{t("Codeforces 题库与代码提交客户端。")}</p><span className="version-label">Version {version || '—'}</span><hr /><p>{t("题目内容来自小羊肖恩的每日一题仓库。")}</p><Button onClick={() => openExternal(UPSTREAM.url)} title={UPSTREAM.url}><Github size={16} />{t("题库仓库")}<ArrowUpRight size={15} /></Button><Button onClick={() => openExternal(CLIENT_REPOSITORY.url)} title={CLIENT_REPOSITORY.url}><Code2 size={16} />{t("客户端源码")}<ArrowUpRight size={15} /></Button><small>{t("独立社区客户端")}<br />{t("未隶属于 GitHub 或 Codeforces")}</small></section></aside></div>
        </>}
      </main>
    </div>

    {composer && <BatchComposer key={composer.instanceId} closeRequestRef={composerCloseRequest} day={composer.day} problem={composer.problem} entries={queueEntries} onEntriesChange={setQueueEntries} notes={queueNotes} onNotesChange={setQueueNotes} requestId={queueRequestId} onResetRequestId={() => setQueueRequestId(crypto.randomUUID())} onEditingChange={setComposerDirty} onBusyChange={busy => { composerBusyRef.current = busy; }} records={indexedItems} statusIncomplete={!statusIndex.complete} settings={settings} auth={auth} repository={repository} onClose={closeComposer} onSettingsSaved={(saved) => { setSettings(saved); setSettingsForm(saved); }} onLogin={openLogin} onSubmitted={(submitted) => { setQueueEntries([]); setQueueNotes(''); setQueueRequestId(crypto.randomUUID()); closeComposer(); setResult(submitted); void refreshHistory(); }} renderMetadata={(problem) => <><SourceWarning problem={problem} /><div className="composer-problem-meta"><Rating rating={problem.rating} source={problem.ratingSource} /><span className={`problem-kind kind-${problemKind(problem)}`}>{problemKind(problem) === 'gym' ? 'Gym' : 'CF Round'}</span></div></>} />}

    {loginOpen && <Modal title={t("登录 GitHub")}  onClose={closeLogin}><div className="login-content"><span className="github-login-icon"><Github size={34} /></span>{!api.isDesktop ? <div className="alert alert-info">{t("登录功能仅在桌面客户端中提供。请启动桌面应用后再登录 GitHub。")}</div> : deviceLogin ? <><h3>{t("在浏览器中完成授权")}</h3><p>{t("打开 GitHub 设备授权页面，输入下面的代码。")}</p><DeviceCode code={deviceLogin.userCode} /><Button kind="primary" onClick={() => openExternal(deviceLogin.verificationUri)}>{t("打开 GitHub 授权页面")}<ExternalLink size={16} /></Button><p className="device-waiting"><LoaderCircle size={15} className="spin" />{t("等待 GitHub 授权完成")}</p><small>{t('代码有效至 {{time}}', { time: new Date(deviceLogin.expiresAt).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) })}</small></> : tokenMode ? <><h3>{t("使用个人访问令牌")}</h3><p>{t('在 GitHub 创建具有 {{scope}} 权限的经典令牌（Tokens classic），然后粘贴到下方。', { scope: 'public_repo' })}</p><label className="field token-field"><span>Personal Access Token</span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="ghp_…" autoComplete="off" spellCheck={false} onKeyDown={(event) => { if (event.key === 'Enter' && token.trim()) void tokenLogin(); }} /></label><Button kind="primary" onClick={() => void tokenLogin()} disabled={loginBusy || !token.trim()}>{loginBusy ? <LoaderCircle size={16} className="spin" /> : <Github size={16} />}{t("登录账号")}</Button><button className="text-button" onClick={() => openExternal('https://github.com/settings/tokens/new?scopes=public_repo&description=Daily%20CF%20Client')}>{t("前往 GitHub 创建令牌")}<ExternalLink size={14} /></button><button className="text-button muted" onClick={() => switchLoginMode(false)}>{t("返回其他登录方式")}</button></> : <><p>{t("授权后可提交代码并查看你的 PR。")}</p>{auth.configured ? <Button kind="primary" onClick={() => void startLogin()} disabled={loginBusy}>{loginBusy ? <LoaderCircle size={16} className="spin" /> : <Github size={16} />}{t("通过浏览器授权登录")}</Button> : <div className="oauth-not-configured"><CircleHelp size={18} /><div><strong>{t("此版本尚未配置 OAuth 应用")}</strong><p>{t("可使用个人访问令牌登录，或在高级设置中填写 OAuth Client ID。")}</p><button className="text-button" onClick={showAdvancedSettings}>{t("打开高级设置")}<ArrowRight size={14} /></button></div></div>}<button className="text-button" onClick={() => switchLoginMode(true)}>{t("使用个人访问令牌")}<ArrowRight size={14} /></button></>}{loginError && <div className="alert alert-error">{loginError}</div>}<div className="login-security"><ShieldCheck size={15} /><span>{auth.secureStorage ? t("登录凭据由操作系统加密保存。") : t("当前无法保存登录状态，重启后需重新登录。")}</span></div></div></Modal>}

    {result && <Modal title={result.reused ? t("提交完成") : t("PR 已创建")} onClose={() => setResult(null)}><div className="success-content"><span className="success-icon"><Check size={36} /></span><h3>{result.reused ? t("已确认 PR 创建成功") : t("已创建 PR")}</h3><p>{t('{{problems}} 道题目 · {{files}} 个文件', { problems: new Set(result.record.problems.map((file) => `${file.date}/${file.problemId}`)).size, files: result.record.problems.length })}</p><div className="success-pr"><GitPullRequest size={19} /><span>{result.record.title}<small>#{result.record.number} · {result.record.state === 'merged' ? t("已合并") : result.record.state === 'closed' ? t("已关闭") : t("等待仓库维护者审核")}</small></span></div><Button kind="primary" onClick={() => openExternal(result.record.url)}>{t("在 GitHub 查看 PR")}<ArrowUpRight size={17} /></Button><Button kind="ghost" onClick={() => { setResult(null); navigate('history'); }}>{t("查看提交记录")}</Button></div></Modal>}
    {logoutConfirm && <Modal title={t("退出 GitHub 账号？")} onClose={() => setLogoutConfirm(false)}><p className="confirm-description">{t("当前设备的登录凭据会被移除。你的 Pull Request 会继续保留在 GitHub，重新登录账号后可查看。")}</p><div className="confirm-actions"><Button onClick={() => setLogoutConfirm(false)}>{t("取消")}</Button><Button kind="danger" onClick={() => { void api.logout().then((next) => { setAuth(next); setLogoutConfirm(false); notify(t("已退出 GitHub")); }).catch((error: unknown) => notify(errorText(error), 'error')); }}>{t("退出登录")}</Button></div></Modal>}
    {oauthChange && <Modal title={t('确认更改 GitHub 登录配置？')} onClose={() => resolveOAuthChange(false)}>
      <div className="alert alert-warning oauth-settings-warning"><TriangleAlert size={19} /><div>
        <strong>{t('修改此项会影响 GitHub 授权登录')}</strong>
        <p>{oauthChange.next ? t('请确认新 ID 属于你信任的 OAuth 应用。填错后，下次浏览器授权登录可能失败；有效的新 ID 则会改用对应应用进行授权。') : t('保存空值后，本次运行将无法通过浏览器授权登录。')}</p>
        <p>{t('已有登录不会因此自动退出，问题可能在下次登录时才出现。')}</p>
      </div></div>
      <dl className="oauth-change-values"><dt>{t('当前 Client ID')}</dt><dd>{oauthChange.previous || t('未配置')}</dd><dt>{t('新的 Client ID')}</dt><dd>{oauthChange.next || t('未配置')}</dd></dl>
      <div className="confirm-actions"><Button onClick={() => resolveOAuthChange(false)}>{t('取消')}</Button><Button kind="primary" onClick={() => resolveOAuthChange(true)}>{pendingLeave ? t('确认更改并保存离开') : t('确认更改并保存')}</Button></div>
    </Modal>}
    {pendingLeave && !oauthChange && <Modal title={pendingLeave.windowTransition && queueDirty ? settingsDirty ? t("未保存的设置和提交内容") : t("提交内容尚未提交") : t("设置尚未保存")} onClose={() => void cancelLeave()}>
      <p className="confirm-description">{pendingLeave.windowTransition && queueDirty ? settingsDirty ? t("离开后，提交列表和未加入列表的编辑将被清除。是否先保存设置？") : t("提交内容仅保留在本次运行中，离开后会被清除。你的源文件不会受影响。") : pendingLeave.windowTransition ? t("离开前是否保存设置？") : t("保存设置后再离开，或放弃本次修改。")}</p>
      <div className="confirm-actions settings-leave-actions">
        <Button onClick={() => void cancelLeave()} disabled={settingsSaving}>{t("继续编辑")}</Button>
        <Button kind="danger" onClick={() => void completeLeave(false)} disabled={settingsSaving}>{pendingLeave.windowTransition && queueDirty ? t("丢弃并离开") : t("放弃修改")}</Button>
        {settingsDirty && <Button kind="primary" onClick={() => void completeLeave(true)} disabled={settingsSaving || forkSettingsBusy}>{settingsSaving && <LoaderCircle size={16} className="spin" />}{pendingLeave.windowTransition && queueDirty ? t("保存设置并离开") : t("保存并离开")}</Button>}
      </div>
    </Modal>}
    {notice && <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'success' ? <CheckCircle2 size={18} /> : notice.kind === 'error' ? <CircleHelp size={18} /> : <BookOpen size={18} />}<span>{notice.text}</span><button aria-label={t("关闭通知")} onClick={() => setNotice(null)}><X size={15} /></button></div>}
  </div>;
}
