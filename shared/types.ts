declare const __DAILY_CF_REPOSITORY__: string;
const repository = typeof __DAILY_CF_REPOSITORY__ !== 'undefined' ? __DAILY_CF_REPOSITORY__ : 'Yawn-Sean/Daily_CF_Problems';
const [owner, repo] = repository.split('/');
export const UPSTREAM = { owner, repo, url: `https://github.com/${repository}` };
export const LANGUAGES = [
  { id: 'cpp', label: 'C++', extension: 'cpp' }, { id: 'c', label: 'C', extension: 'c' }, { id: 'py', label: 'Python', extension: 'py' },
  { id: 'java', label: 'Java', extension: 'java' }, { id: 'rs', label: 'Rust', extension: 'rs' },
  { id: 'go', label: 'Go', extension: 'go' }, { id: 'cs', label: 'C#', extension: 'cs' },
  { id: 'js', label: 'JavaScript', extension: 'js' }, { id: 'kt', label: 'Kotlin', extension: 'kt' },
  { id: 'other', label: '其他', extension: 'txt' }
] as const;
export type Language = typeof LANGUAGES[number]['id'];
export interface Problem { id: string; label: string; url: string; rating: number | null; ratingSource?: 'estimated' | 'official' | 'unknown'; kind?: 'gym' | 'round'; sourceWarning?: string; hint: string; editorialUrl?: string; }
export interface ProblemDay { date: string; problems: Problem[]; sourceUrl: string; fetchedAt: string; parserVersion?: number; }
export interface ArchiveMonth { month: string; days: number; }
export interface ArchiveSnapshot { branch: string; revision: string; months: ArchiveMonth[]; }
export interface ReferenceFile { name: string; path: string; url: string; language: string; }
export interface ProblemResources { editorial: string | null; editorialUrl: string | null; references: ReferenceFile[]; }
export type LocalLibraryViewRequest = { kind: 'day'; date?: string }
  | { kind: 'archive'; scope: 'month' | 'all'; month?: string }
  | { kind: 'resources'; date: string; problemId: string }
  | { kind: 'reference'; path: string };
export type LocalLibraryView = ({ kind: 'day'; day: ProblemDay }
  | { kind: 'archive'; snapshot: ArchiveSnapshot; month: string; days: ProblemDay[]; index?: Record<string, ProblemDay[]> }
  | { kind: 'resources'; resources: ProblemResources }
  | { kind: 'reference'; code: string }) & { revision: string };
export interface ArchiveProgress { completed: number; total: number; month: string; }
export interface LibrarySyncProgress {
  phase: 'checking' | 'repairing' | 'downloading' | 'indexing' | 'ready' | 'error';
  completed: number;
  total?: number;
  unit: 'bytes' | 'objects';
  message?: string;
  revision?: string;
  updatedAt?: string;
}
export interface User { login: string; name: string | null; avatarUrl: string; }
export interface ThemeColors { primary: string; accent?: string; background: string; surface: string; text: string; }
export interface PaletteColors { light: ThemeColors; dark: ThemeColors; }
export interface ColorPalette extends PaletteColors { id: string; name: string; }
export interface Settings { clientId: string; language: Language; uiLanguage?: 'system' | 'zh-CN' | 'en'; theme: 'light' | 'dark' | 'system'; palettes?: ColorPalette[]; paletteId?: string; forkRepository?: string; prTitleTemplate?: string; prBodyTemplate?: string; }
export interface LocalPaths { configFile: string; dataDirectory: string; }
export interface ForkInfo { fullName: string; url: string; defaultBranch: string; ownedUpstream: boolean; }
export interface ForkSyncStatus { state: 'synced' | 'behind' | 'ahead' | 'diverged'; repository: string; branch: string; upstreamSha: string; forkSha: string; aheadBy: number; behindBy: number; }
export interface AuthState { user: User | null; configured: boolean; secureStorage: boolean; message?: string; }
export interface DeviceLogin { userCode: string; verificationUri: string; expiresAt: number; }
export interface SubmissionInput { date: string; problemId: string; language: Language; extension?: string; author: string; code: string; notes: string; }
export interface SubmissionPreview { path: string; title: string; branch: string; bytes: number; existing: boolean; body?: string; forkRepository?: string; sourceWarning?: string; forkSync?: ForkSyncStatus; }
export interface BatchSubmissionInput { items: SubmissionInput[]; notes: string; target?: { kind: 'new' }; requestId: string; overwrites?: { path: string; sha: string }[]; }
export interface BatchSubmissionFile { date: string; problemId: string; language: Language; extension?: string; author: string; path: string; bytes: number; existing: boolean; problem: Problem; previous?: { sha: string; code: string; bytes: number; truncated: boolean }; unchanged?: boolean; }
export interface BatchSubmissionPreview { items: BatchSubmissionFile[]; title: string; body: string; branch: string; bytes: number; forkRepository?: string; forkSync?: ForkSyncStatus; }
export type SubmissionStage = 'validating' | 'forking' | 'branching' | 'committing' | 'pull-request' | 'complete';
export interface SubmissionProgress { stage: SubmissionStage; message: string; }
export interface ContributionProblem { date: string; problemId: string; path: string; language?: Language; }
export interface RemotePullRequest {
  id: string; number: number; title: string; url: string; state: 'open' | 'closed' | 'merged';
  createdAt: string; updatedAt: string; problemId?: string; date?: string; language?: Language; path?: string;
  problems: ContributionProblem[]; filesTruncated: boolean;
  otherFiles?: { path: string; status: string }[];
}
export interface BatchSubmissionResult { record: RemotePullRequest; reused: boolean; }
export interface ContributionPage {
  items: RemotePullRequest[]; totalCount: number; openCount: number; mergedCount: number; closedCount: number;
  page: number; pageSize: number; hasMore: boolean; truncated: boolean; incomplete: boolean;
  login: string; repository: string; fetchedAt: string;
}
export interface BootState { auth: AuthState; settings: Settings; readonly defaultClientId: string; version: string; repository: string; systemLanguages?: string[]; }
export interface ApiResult<T> { ok: boolean; data?: T; error?: string; code?: 'submission_base_changed' | 'github_rate_limited' | 'library_content_missing'; rateLimit?: import('./rate-limit').RateLimitInfo; }
export interface ClientAPI {
  bootstrap(): Promise<BootState>;
  syncLibrary(): Promise<{ branch: string; revision: string }>;
  getLocalLibraryView(request: LocalLibraryViewRequest): Promise<LocalLibraryView | null>;
  onLibrarySync(callback: (progress: LibrarySyncProgress) => void): () => void;
  getDay(date?: string, refresh?: boolean): Promise<ProblemDay>;
  getArchiveMonths(refresh?: boolean): Promise<ArchiveMonth[]>;
  getMonth(month: string, refresh?: boolean): Promise<ProblemDay[]>;
  getArchiveSnapshot(): Promise<ArchiveSnapshot>;
  getMonthFromSnapshot(month: string, snapshot: ArchiveSnapshot): Promise<ProblemDay[]>;
  getResources(date: string, problemId: string, refresh?: boolean): Promise<ProblemResources>;
  getReference(path: string, refresh?: boolean): Promise<string>;
  saveSettings(settings: Settings): Promise<Settings>;
  getLocalPaths(): Promise<LocalPaths | null>;
  openLocalPath(target: 'config' | 'data'): Promise<void>;
  getForks(): Promise<ForkInfo[]>;
  validateFork(repository: string): Promise<ForkInfo>;
  createFork(name: string): Promise<ForkInfo>;
  beginLogin(): Promise<DeviceLogin>;
  cancelLogin(): Promise<void>;
  loginWithToken(token: string): Promise<AuthState>;
  logout(): Promise<AuthState>;
  inspectSubmissionFile(input: SubmissionInput): Promise<{ path: string; exists: boolean }>;
  previewBatchSubmission(input: BatchSubmissionInput): Promise<BatchSubmissionPreview>;
  submitBatch(input: BatchSubmissionInput): Promise<BatchSubmissionResult>;
  getContributions(page?: number): Promise<ContributionPage>;
  importCode(): Promise<{ name: string; code: string; extension: string; language?: Language } | null>;
  copyText(text: string): Promise<void>;
  resolveWindowTransition(proceed: boolean): Promise<void>;
  openExternal(url: string): Promise<void>;
  onAuthChanged(callback: (auth: AuthState) => void): () => void;
  onSubmissionProgress(callback: (progress: SubmissionProgress) => void): () => void;
  isDesktop: boolean;
}
declare global { interface Window { dailyCF?: ClientAPI; } }
