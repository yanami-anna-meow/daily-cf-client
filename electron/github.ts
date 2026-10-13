import { t } from '../shared/i18n';
import { Buffer } from 'node:buffer';
import { importExtension, languageForExtension } from '../shared/file-formats';
import {
  submissionPath, normalizeProblemId, parseProblems, repositoryDatePath, validateDate, validateSubmission, PARSER_VERSION,
} from '../shared/domain';
import {
  UPSTREAM, type BatchSubmissionInput, type BatchSubmissionPreview, type BatchSubmissionResult, type ContributionPage, type ContributionProblem, type RemotePullRequest, type ForkInfo, type ProblemDay, type SubmissionInput, type SubmissionProgress,
  type User,
} from '../shared/types';
import { renderBatchPRTemplates } from '../shared/templates';
import { BatchSubmissionEngine } from './batch-submit';
import { ForkSyncService } from './fork-sync';
import { batchSubmissionInput } from './guards';
import { validateForkName } from '../shared/fork';
import { rateLimitMessage, withRateLimit } from '../shared/rate-limit';
import { GitHubRateLimitGate } from './github-rate-limit';

const API = 'https://api.github.com';
const UPSTREAM_PATH = `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}`;
const UPSTREAM_NAME = `${UPSTREAM.owner}/${UPSTREAM.repo}`.toLowerCase();
const segment = (value: string) => encodeURIComponent(value);
const contentPath = (value: string) => value.split('/').map(segment).join('/');
interface Repository {
  id?: number;
  name: string; full_name: string; default_branch: string; fork: boolean;
  owner: { login: string }; parent?: { full_name: string }; source?: { full_name: string };
  permissions?: { push?: boolean };
}
interface ContentFile { type: string; content: string; encoding: string; sha: string; size: number }
interface GitRef { ref?: string; object: { sha: string; type?: string } }
interface PullRequest {
  number: number; title: string; html_url: string; state: 'open' | 'closed'; merged_at: string | null;
  created_at: string; body: string | null; updated_at?: string; user?: { login: string };
  head: { ref: string; sha: string; user: { login: string } | null; repo: Repository | null };
  base: { ref: string; repo: Repository };
}
interface SearchIssue {
  number: number; title: string; body: string | null; repository_url: string;
  state: 'open' | 'closed'; created_at: string; updated_at: string; user: { login: string };
  pull_request?: { merged_at?: string | null };
}
interface SearchResults { total_count: number; incomplete_results: boolean; items: SearchIssue[] }

export class GitHubError extends Error {
  constructor(message: string, readonly status = 0) { super(message); this.name = 'GitHubError'; }
}
export interface GitHubClientOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  forkRepository?: string;
  prTitleTemplate?: string;
  prBodyTemplate?: string;
  rateLimitGate?: GitHubRateLimitGate;
}

/** All credentials and GitHub writes stay in the Electron main process. */
export class GitHubClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly rateLimitGate: GitHubRateLimitGate;
  private submitting = false;
  private batches?: BatchSubmissionEngine;
  private forkSync?: ForkSyncService;

  constructor(private readonly token?: string, private readonly options: GitHubClientOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.rateLimitGate = options.rateLimitGate ?? new GitHubRateLimitGate();
  }

  private syncService(): ForkSyncService {
    return this.forkSync ??= new ForkSyncService({
      request: <T>(path: string, method?: string, body?: unknown) => this.request<T>(path, method, body),
      error: (message, status) => new GitHubError(message, status),
    });
  }

  private batchEngine(): BatchSubmissionEngine {
    return this.batches ??= new BatchSubmissionEngine({
      request: <T>(path: string, method?: string, body?: unknown) => this.request<T>(path, method, body),
      optional: <T>(path: string) => this.optional<T>(path),
      getUser: () => this.getUser(), getUpstream: () => this.getUpstream(), dayAt: (date, ref) => this.dayAt(date, ref),
      resolveExistingFork: login => this.resolveExistingFork(login), ensureFork: login => this.ensureFork(login),
      inspectForkSync: (fork, upstream, baseSha) => this.syncService().inspect(upstream, fork, baseSha),
      syncFork: (fork, upstream, baseSha) => this.syncService().synchronize(upstream, fork, baseSha),
      assertForkCurrent: (fork, upstream, baseSha) => this.syncService().assertCurrent(upstream, fork, baseSha),
      renderBatch: (input, login, problems) => renderBatchPRTemplates(input, { login, problems }, {
        title: this.options.prTitleTemplate, body: this.options.prBodyTemplate,
      }),
      error: (message, status) => new GitHubError(message, status),
    });
  }

  async previewBatchSubmission(raw: BatchSubmissionInput): Promise<BatchSubmissionPreview> {
    return this.batchEngine().preview(batchSubmissionInput(raw));
  }

  async submitBatch(raw: BatchSubmissionInput, login: string, onProgress: (progress: SubmissionProgress) => void = () => {}): Promise<BatchSubmissionResult> {
    const input = batchSubmissionInput(raw);
    if (this.submitting) throw new GitHubError(t('已有提交正在进行，请等待完成后重试。'));
    this.submitting = true;
    try { return await this.batchEngine().submit(input, login, onProgress); }
    finally { this.submitting = false; }
  }

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//') || new URL(path, API).origin !== API) {
      throw new GitHubError(t('拒绝向非 GitHub API 地址发送请求。'));
    }
    const blocked = this.rateLimitGate.blocked(`${API}${path}`);
    if (blocked) throw withRateLimit(new GitHubError(rateLimitMessage(blocked), 429), blocked);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${API}${path}`, {
        method, signal: controller.signal, redirect: 'error', cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Daily-CF-Desktop/0.1', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const headerLimit = this.rateLimitGate.observe(`${API}${path}`, response, '', Boolean(this.token));
      if (headerLimit) {
        try { await response.body?.cancel(); } catch { /* Headers already provide the actionable failure. */ }
        throw withRateLimit(new GitHubError(rateLimitMessage(headerLimit), response.status), headerLimit);
      }
      const text = await response.text();
      let result: unknown;
      try { result = text ? JSON.parse(text) : undefined; } catch { result = undefined; }
      const detail = typeof result === 'object' && result && 'message' in result ? String(result.message) : '';
      const limited = response.ok ? undefined : this.rateLimitGate.observe(`${API}${path}`, response, detail, Boolean(this.token));
      if (limited) throw withRateLimit(new GitHubError(rateLimitMessage(limited), response.status), limited);
      if (!response.ok) {
        if (response.status === 401) throw new GitHubError(t('GitHub 登录已失效，请重新登录后重试。'), 401);
        if (response.status === 403) throw new GitHubError(t('GitHub 拒绝访问。请检查账号权限、Token 的 public_repo 权限及仓库访问限制。'), 403);
        if (response.status === 404) throw new GitHubError(t('GitHub 上未找到对应内容，或当前账号无权访问。'), 404);
        if (response.status === 409) throw new GitHubError(t('GitHub 内容发生并发变化，请重新预览后重试。'), 409);
        if (response.status === 422) throw new GitHubError(t('GitHub 未接受该操作：分支、文件或 Pull Request 的状态可能已经变化，请重试。'), 422);
        if (response.status >= 500) throw new GitHubError(t('GitHub 服务暂时不可用，请稍后重试。已完成的提交步骤会在重试时恢复。'), response.status);
        throw new GitHubError(t('GitHub 请求失败（HTTP {{status}}），请稍后重试。', { status: response.status }), response.status);
      }
      if (text && result === undefined) throw new GitHubError(t('GitHub 返回了无法识别的数据，请稍后重试。'));
      return result as T;
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError(controller.signal.aborted
        ? t('连接 GitHub 超时，请检查网络后重试。重试会恢复已完成的提交步骤。')
        : t('无法连接 GitHub，请检查网络或代理设置后重试。重试不会重复创建相同提交。'));
    } finally { clearTimeout(timer); }
  }

  private async optional<T>(path: string): Promise<T | null> {
    try { return await this.request<T>(path); }
    catch (error) { if (error instanceof GitHubError && error.status === 404) return null; throw error; }
  }

  private async getUpstream(): Promise<Repository> {
    const repository = await this.request<Repository>(UPSTREAM_PATH);
    if (repository.full_name.toLowerCase() !== UPSTREAM_NAME || !repository.default_branch) throw new GitHubError(t('上游仓库信息异常，已停止操作。'));
    return repository;
  }

  private async getFile(repositoryPath: string, path: string, ref?: string): Promise<ContentFile | null> {
    const result = await this.optional<ContentFile | ContentFile[]>(`${repositoryPath}/contents/${contentPath(path)}${ref ? `?ref=${segment(ref)}` : ''}`);
    if (result && (Array.isArray(result) || result.type !== 'file' || result.encoding !== 'base64' || typeof result.content !== 'string')) {
      throw new GitHubError(t('目标路径不是可读取的普通文件，已停止操作。'));
    }
    return result;
  }

  private decode(file: ContentFile): string { return Buffer.from(file.content, 'base64').toString('utf8'); }

  async getUser(): Promise<User> {
    if (!this.token) throw new GitHubError(t('请先登录 GitHub。'));
    const user = await this.request<{ login: string; name: string | null; avatar_url: string }>('/user');
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(user.login)) throw new GitHubError(t('GitHub 返回的账号名称无效。'));
    return { login: user.login, name: user.name, avatarUrl: user.avatar_url };
  }

  private async dayAt(date: string, ref?: string, repositorySnapshot?: Repository): Promise<ProblemDay> {
    validateDate(date);
    const path = `${repositoryDatePath(date)}/problems.md`;
    const file = await this.getFile(UPSTREAM_PATH, path, ref);
    if (!file) throw new GitHubError(t('{{date}} 没有题单，请选择其他日期。', { date }), 404);
    const problems = parseProblems(this.decode(file), date);
    if (!problems.length) throw new GitHubError(t('该日题目格式暂不受支持，请在 GitHub 查看原文。'));
    const upstream = repositorySnapshot ?? await this.getUpstream();
    return { date, problems, sourceUrl: `${UPSTREAM.url}/blob/${segment(upstream.default_branch)}/${path}`, fetchedAt: new Date().toISOString(), parserVersion: PARSER_VERSION };
  }

  async getDay(date?: string, _refresh = false): Promise<ProblemDay> {
    if (date) validateDate(date);
    const upstream = await this.getUpstream();
    const reference = await this.request<GitRef>(`${UPSTREAM_PATH}/git/ref/heads/${segment(upstream.default_branch)}`);
    const baseSha = reference?.object?.sha;
    if (typeof baseSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseSha)) throw new GitHubError(t('无法确认上游题单版本，请刷新后重试。'));
    if (date) return this.dayAt(date, baseSha, upstream);
    const readme = await this.getFile(UPSTREAM_PATH, 'README.md', baseSha);
    if (!readme) throw new GitHubError(t('无法读取仓库首页。'));
    const dates = [...this.decode(readme).matchAll(/daily_problems\/(\d{4})\/(\d{2})\/(\d{2})(\d{2})\//g)]
      .filter((match) => match[2] === match[3])
      .map((match) => `${match[1]}-${match[2]}-${match[4]}`).sort();
    if (!dates.length) throw new GitHubError(t('无法从仓库首页识别最新日期，请手动选择日期。'));
    return this.dayAt(validateDate(dates[dates.length - 1]), baseSha, upstream);
  }

  async inspectSubmissionFile(raw: SubmissionInput): Promise<{ path: string; exists: boolean }> {
    const input = validateSubmission(raw);
    const path = submissionPath(input);
    const upstream = await this.getUpstream();
    const reference = await this.request<GitRef>(`${UPSTREAM_PATH}/git/ref/heads/${segment(upstream.default_branch)}`);
    const baseSha = reference?.object?.sha;
    if (typeof baseSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseSha)) throw new GitHubError(t('无法确认上游题单版本，请刷新后重试。'));
    // This is a warning-only inspection of current upstream state. It does not
    // require a GitHub account or a fork, and never stores remote content.
    const file = await this.getFile(UPSTREAM_PATH, path, baseSha);
    return { path, exists: Boolean(file) };
  }

  private isFork(repository: Repository, login: string): boolean {
    return repository.owner.login.toLowerCase() === login.toLowerCase() && repository.fork &&
      [repository.parent?.full_name, repository.source?.full_name].some(name => name?.toLowerCase() === UPSTREAM_NAME) &&
      /^[\w.-]+$/.test(repository.name) && repository.full_name.toLowerCase() === `${login}/${repository.name}`.toLowerCase();
  }

  private checkFork(repository: Repository, login: string): void {
    if (!this.isFork(repository, login)) {
      throw new GitHubError(t('所选仓库不是 Daily_CF_Problems 的 Fork，或不属于当前账号。为保护已有仓库，已停止操作。'));
    }
  }

  private forkInfo(repository: Repository): ForkInfo {
    return { fullName: repository.full_name, url: `https://github.com/${repository.full_name}`, defaultBranch: repository.default_branch,
      ownedUpstream: repository.full_name.toLowerCase() === UPSTREAM_NAME };
  }

  private normalizeRepository(repository: string): string {
    let name = repository.trim();
    if (name.startsWith('https://')) {
      let url: URL;
      try { url = new URL(name); } catch { throw new GitHubError(t('请输入有效的 GitHub 仓库地址。')); }
      if (url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) throw new GitHubError(t('请输入 GitHub 个人仓库地址或“账号/仓库名”。'));
      name = url.pathname.replace(/^\//, '').replace(/\/$/, '');
    }
    name = name.replace(/\.git$/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(name) || ['.', '..'].includes(name.split('/')[1])) throw new GitHubError(t('仓库格式应为“账号/仓库名”。'));
    return name;
  }

  private async validateForkFor(repositoryName: string, login: string): Promise<Repository> {
    const name = this.normalizeRepository(repositoryName);
    const [owner, repository] = name.split('/');
    if (owner.toLowerCase() !== login.toLowerCase()) throw new GitHubError(t('只能绑定当前登录账号下的个人 Fork，不能绑定其他账号或组织的仓库。'));
    const result = await this.optional<Repository>(`/repos/${segment(owner)}/${segment(repository)}`);
    if (!result) throw new GitHubError(t('绑定的仓库不存在或当前账号无权访问，请检查仓库名称。'), 404);
    if (result.full_name.toLowerCase() !== name.toLowerCase() || !result.default_branch) throw new GitHubError(t('绑定的仓库名称或默认分支已发生变化，请重新选择并绑定 Fork。'));
    if (result.full_name.toLowerCase() === UPSTREAM_NAME && UPSTREAM.owner.toLowerCase() === login.toLowerCase() && result.owner.login.toLowerCase() === login.toLowerCase()) return result;
    this.checkFork(result, login);
    return result;
  }

  async validateFork(repository: string): Promise<ForkInfo> {
    const user = await this.getUser();
    return this.forkInfo(await this.validateForkFor(repository, user.login));
  }

  private async discoverForks(login: string): Promise<Repository[]> {
    const upstream = await this.getUpstream();
    if (upstream.owner.login.toLowerCase() === login.toLowerCase()) return [upstream];
    const found: Repository[] = [];
    let inspected = 0;
    for (let page = 1; page <= 10; page++) {
      const repositories = await this.request<Repository[]>(`/user/repos?affiliation=owner&per_page=100&page=${page}&sort=updated`);
      const candidates = repositories.filter(repository => repository.fork && repository.owner.login.toLowerCase() === login.toLowerCase() && /^[\w.-]+$/.test(repository.name));
      inspected += candidates.length;
      if (inspected > 200) throw new GitHubError(t('账号下的 Fork 数量较多，请通过“账号/仓库名”手动绑定，避免耗尽 GitHub 请求额度。'));
      for (let offset = 0; offset < candidates.length; offset += 4) {
        const checked = await Promise.all(candidates.slice(offset, offset + 4).map(repository =>
          this.optional<Repository>(`/repos/${segment(login)}/${segment(repository.name)}`)));
        for (const repository of checked) if (repository && this.isFork(repository, login)) found.push(repository);
      }
      if (repositories.length < 100) return found.sort((left, right) => left.full_name.localeCompare(right.full_name));
    }
    throw new GitHubError(t('账号下的仓库数量较多，请通过“账号/仓库名”手动绑定 Fork。'));
  }

  async getForks(): Promise<ForkInfo[]> {
    const user = await this.getUser();
    return (await this.discoverForks(user.login)).map(repository => this.forkInfo(repository));
  }

  private async resolveExistingFork(login: string): Promise<Repository> {
    if (!this.options.forkRepository?.trim()) throw new GitHubError(t('请先在设置中选择并绑定个人 Fork，再预览或提交。'), 400);
    return this.validateForkFor(this.options.forkRepository, login);
  }

  private async ensureFork(login: string): Promise<Repository> {
    return this.resolveExistingFork(login);
  }

  async createFork(rawName: string): Promise<ForkInfo> {
    const name = validateForkName(rawName);
    const user = await this.getUser();
    const login = user.login;
    const repositoryPath = `/repos/${segment(login)}/${segment(name)}`;
    const sameName = await this.optional<Repository>(repositoryPath);
    if (sameName) throw new GitHubError(t('仓库 {{repository}} 已存在，请更换新仓库名称；若要使用已有 Fork，请在列表中手动选择并绑定。', { repository: `${login}/${name}` }));
    let created: Repository;
    try {
      created = await this.request<Repository>(`${UPSTREAM_PATH}/forks`, 'POST', { name, default_branch_only: true });
    } catch (error) {
      // Only an unknown network outcome or a server error may hide a successful
      // creation. Never retry the POST or recover through another existing fork.
      if (error instanceof GitHubError && error.status === 422) {
        throw new GitHubError(t('GitHub 未接受创建 Fork 的请求。请检查新仓库名称；同一个账号不能为同一个项目创建第二个 Fork，可手动选择已有 Fork 或使用其他账号。'), 422);
      }
      if (!(error instanceof GitHubError) || (error.status !== 0 && !(error.status >= 500 && error.status < 600))) throw error;
      const recovered = await this.optional<Repository>(repositoryPath);
      if (!recovered) throw error;
      created = recovered;
    }
    // Keep semantic response validation outside the recovery catch. GitHub may
    // return an existing same-network fork instead of creating the requested name.
    const validateCreated = (repository: Repository, expectedId?: number) => {
      if (!repository || typeof repository.owner?.login !== 'string' || repository.owner.login.toLowerCase() !== login.toLowerCase()) {
        throw new GitHubError(t('GitHub 返回的 Fork 不属于当前账号，已停止操作；当前绑定保持不变。'));
      }
      if (typeof repository.name !== 'string' || typeof repository.full_name !== 'string') {
        throw new GitHubError(t('GitHub 返回的 Fork 仓库名称无效，已停止操作；当前绑定保持不变。'));
      }
      if (repository.name.toLowerCase() !== name.toLowerCase() || repository.full_name.toLowerCase() !== `${login}/${name}`.toLowerCase()) {
        throw new GitHubError(t('GitHub 返回已有 Fork {{repository}}，未创建新仓库。同账号对同一个项目只能保留一个 Fork，请手动选择已有 Fork 或使用其他账号。', { repository: repository.full_name || t('（名称未知）') }));
      }
      if (repository.fork !== true || ![repository.parent?.full_name, repository.source?.full_name].some(value =>
        typeof value === 'string' && value.toLowerCase() === UPSTREAM_NAME)) {
        throw new GitHubError(t('GitHub 返回的仓库不属于目标项目的 Fork 网络，已停止操作；当前绑定保持不变。'));
      }
      if (repository.permissions?.push === false) throw new GitHubError(t('当前账号没有该 Fork 的写入权限，请检查 GitHub 权限；当前绑定保持不变。'), 403);
      if ((repository.id !== undefined && (!Number.isSafeInteger(repository.id) || repository.id <= 0)) ||
        (expectedId !== undefined && repository.id !== expectedId)) {
        throw new GitHubError(t('Fork 仓库身份在创建期间发生变化，请刷新仓库列表后核对；当前绑定保持不变。'));
      }
    };
    validateCreated(created);
    let expectedId = created.id;
    for (let attempt = 0; attempt < 15; attempt++) {
      const repository = await this.optional<Repository>(repositoryPath);
      if (repository) {
        validateCreated(repository, expectedId);
        expectedId ??= repository.id;
        const branch = repository.default_branch;
        if (typeof branch !== 'string' || !branch || branch === '@' || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) ||
          branch.includes('..') || branch.includes('@{') || branch.endsWith('.') ||
          branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
          throw new GitHubError(t('GitHub 返回的 Fork 默认分支无效，请刷新仓库列表后核对；当前绑定保持不变。'));
        }
        try {
          const reference = await this.optional<GitRef>(`${repositoryPath}/git/ref/heads/${segment(branch)}`);
          if (reference) {
            if (!reference.object || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(reference.object.sha) ||
              (reference.object.type !== undefined && reference.object.type !== 'commit') ||
              (reference.ref !== undefined && reference.ref !== `refs/heads/${branch}`)) {
              throw new GitHubError(t('GitHub 返回的 Fork 默认分支引用无效，尚不能确认仓库已准备好；当前绑定保持不变。'));
            }
            return this.forkInfo(repository);
          }
        } catch (error) {
          if (!(error instanceof GitHubError && error.status === 409)) throw error;
        }
      }
      await this.sleep(2_000);
    }
    throw new GitHubError(t('GitHub 正在准备 Fork，通常需要数十秒。请稍后刷新 Fork 列表，选择并绑定已创建的仓库。'));
  }

  private async contributionFiles(number: number): Promise<Pick<RemotePullRequest, 'problems' | 'filesTruncated' | 'otherFiles' | 'date' | 'problemId' | 'path' | 'language'>> {
    const paths = new Set<string>();
    const problems: ContributionProblem[] = [];
    const otherFiles: { path: string; status: string }[] = [];
    let filesTruncated = false;
    for (let page = 1; page <= 30; page++) {
      const files = await this.request<{ filename: string; status?: string }[]>(`${UPSTREAM_PATH}/pulls/${number}/files?per_page=100&page=${page}`);
      if (!Array.isArray(files) || files.some(file => typeof file.filename !== 'string')) throw new GitHubError(t('GitHub 返回了无法识别的 PR 文件列表，请稍后重试。'));
      for (const file of files) {
        if (paths.has(file.filename)) { filesTruncated = true; continue; }
        paths.add(file.filename);
        const other = { path: file.filename, status: file.status ?? 'unknown' };
        if (file.status === 'removed') { otherFiles.push(other); continue; }
        // Associate submissions by repository path, independently of known languages.
        // Read the suffix separately: historical signatures may contain dots, and
        // extensions may contain dots or symbols (for example .d.ts and .c++).
        const path = /^daily_problems\/(\d{4})\/(\d{2})\/(\d{2})(\d{2})\/personal_submission\/(cf[0-9]+[A-Za-z][A-Za-z0-9]*)_([^/\\]+)$/i.exec(file.filename);
        const extension = path ? importExtension(path[6]) : '';
        const author = path && extension ? path[6].slice(0, -extension.length - 1) : '';
        if (!path || path[2] !== path[3] || !extension || !author) { otherFiles.push(other); continue; }
        try {
          const date = validateDate(`${path[1]}-${path[2]}-${path[4]}`);
          const problemId = normalizeProblemId(path[5]);
          const language = languageForExtension(extension);
          problems.push({ date, problemId, path: file.filename, ...(language !== 'other' ? { language } : {}) });
        } catch { otherFiles.push(other); }
      }
      if (files.length < 100) break;
      // GitHub exposes at most 3000 changed files. A full last page cannot establish
      // completeness, so explicitly report this boundary instead of guessing.
      if (page === 30) filesTruncated = true;
    }
    const identities = new Set(problems.map(problem => `${problem.date}/${problem.problemId}`));
    const legacy = !filesTruncated && identities.size === 1 ? { date: problems[0].date, problemId: problems[0].problemId } : {};
    const singleFile = !filesTruncated && problems.length === 1 ? { path: problems[0].path, language: problems[0].language } : {};
    return { problems, filesTruncated, otherFiles, ...legacy, ...singleFile };
  }

  /** Fetch the account's actual GitHub PRs, including submissions made outside this app. */
  async getContributions(page = 1): Promise<ContributionPage> {
    const pageSize = 50;
    if (!Number.isSafeInteger(page) || page < 1 || page > 20) throw new GitHubError(t('贡献记录页码须为 1 至 20；GitHub 搜索最多展示 1000 条记录。'));
    const user = await this.getUser();
    const query = `repo:${UPSTREAM.owner}/${UPSTREAM.repo} is:pr author:${user.login}`;
    const search = (suffix: string, perPage: number, targetPage: number) => this.request<SearchResults>(
      `/search/issues?q=${segment(`${query}${suffix}`)}&sort=created&order=desc&per_page=${perPage}&page=${targetPage}`,
    );
    const settled = await Promise.allSettled([search('', pageSize, page), search(' is:open', 1, 1), search(' is:merged', 1, 1)]);
    const responses = settled.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
    for (const result of responses) {
      if (!Number.isSafeInteger(result.total_count) || result.total_count < 0 || !Array.isArray(result.items)) throw new GitHubError(t('GitHub 返回了无法识别的贡献记录，请稍后重试。'));
    }
    const [all, open, merged] = responses;
    const valid = all.items.filter(issue => issue.pull_request && Number.isSafeInteger(issue.number) && issue.number > 0 &&
      issue.user?.login.toLowerCase() === user.login.toLowerCase() && issue.repository_url?.toLowerCase() === `${API}${UPSTREAM_PATH}`.toLowerCase());
    let incomplete = responses.some(result => result.incomplete_results) || valid.length !== all.items.length || open.total_count + merged.total_count > all.total_count;
    const items: RemotePullRequest[] = [];
    for (let offset = 0; offset < valid.length; offset += 4) {
      const batch = await Promise.all(valid.slice(offset, offset + 4).map(async issue => {
        let state: RemotePullRequest['state'] = issue.state;
        let updatedAt = issue.updated_at;
        if (issue.pull_request!.merged_at) state = 'merged';
        else if (issue.state === 'closed' && !Object.prototype.hasOwnProperty.call(issue.pull_request, 'merged_at')) {
          // The live search API normally includes merged_at. Older responses can omit
          // it; only the actual PR endpoint can distinguish closed from merged then.
          const detail = await this.request<PullRequest>(`${UPSTREAM_PATH}/pulls/${issue.number}`);
          if (detail.number !== issue.number || detail.base.repo.full_name.toLowerCase() !== UPSTREAM_NAME ||
            detail.user?.login.toLowerCase() !== user.login.toLowerCase()) throw new GitHubError(t('贡献记录的账号或仓库信息不匹配，请刷新后重试。'));
          state = detail.merged_at ? 'merged' : detail.state;
          updatedAt = detail.updated_at ?? updatedAt;
          if (detail.state !== issue.state) incomplete = true;
        }
        return {
          id: `${UPSTREAM_NAME}#${issue.number}`, number: issue.number, title: issue.title,
          url: `${UPSTREAM.url}/pull/${issue.number}`, state, createdAt: issue.created_at, updatedAt,
          ...await this.contributionFiles(issue.number),
        } satisfies RemotePullRequest;
      }));
      items.push(...batch);
    }
    return {
      items, totalCount: all.total_count, openCount: open.total_count, mergedCount: merged.total_count,
      closedCount: Math.max(0, all.total_count - open.total_count - merged.total_count),
      page, pageSize, hasMore: page * pageSize < Math.min(all.total_count, 1000), truncated: all.total_count > 1000,
      incomplete, login: user.login, repository: `${UPSTREAM.owner}/${UPSTREAM.repo}`, fetchedAt: new Date().toISOString(),
    };
  }

}
