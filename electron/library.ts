import { PARSER_VERSION, parseProblems, repositoryDatePath, validateDate } from '../shared/domain';
import { UPSTREAM, type ArchiveMonth, type ArchiveProgress, type ArchiveSnapshot, type ProblemDay, type ProblemResources, type ReferenceFile } from '../shared/types';
import { t } from '../shared/i18n';
import { rateLimitMessage, withRateLimit } from '../shared/rate-limit';
import { GitHubRateLimitGate, rateLimitResponseDetail } from './github-rate-limit';
import { MAX_LIBRARY_FILE_BYTES as MAX_CODE_BYTES, libraryMonth as monthValue, libraryProblemId as problemValue, referenceInfo } from '../shared/library-files';

const API = `https://api.github.com/repos/${UPSTREAM.owner}/${UPSTREAM.repo}`;
interface DirectoryEntry { name: string; path: string; type: string; size?: number; }
interface TreeResponse { truncated?: boolean; tree: { path: string; sha: string; type: string; mode?: string; size?: number }[]; }
export interface LibraryOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  concurrency?: number;
  onProgress?: (progress: ArchiveProgress) => void;
  rateLimitGate?: GitHubRateLimitGate;
}
export class LibraryError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = 'LibraryError';
  }
}

function pathParts(path: string): string { return path.split('/').map(encodeURIComponent).join('/'); }

/** Every public read fetches upstream again; only one operation shares its pinned commit. */
export class ProblemLibrary {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly options: LibraryOptions;
  private readonly rateLimitGate: GitHubRateLimitGate;

  constructor(private readonly token?: string, options: LibraryOptions = {}) {
    this.options = options;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.rateLimitGate = options.rateLimitGate ?? new GitHubRateLimitGate({ now: this.now });
  }
  private async map<T, U>(values: T[], work: (value: T, index: number) => Promise<U>): Promise<U[]> {
    const result = new Array<U>(values.length);
    let next = 0;
    let stopped = false;
    const concurrency = Math.max(1, Math.min(6, this.options.concurrency ?? 4));
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (!stopped && next < values.length) {
        const index = next++;
        try { result[index] = await work(values[index], index); }
        catch (error) { stopped = true; throw error; }
      }
    }));
    return result;
  }
  private async request(url: string, maxBytes: number, missing = false): Promise<string | null> {
    const blocked = this.rateLimitGate.blocked(url);
    if (blocked) throw withRateLimit(new LibraryError(rateLimitMessage(blocked), 429), blocked);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 25_000);
    try {
      const headers: Record<string, string> = { 'User-Agent': 'Daily-CF-Client' };
      if (new URL(url).hostname === 'api.github.com') {
        headers.Accept = 'application/vnd.github+json';
        headers['X-GitHub-Api-Version'] = '2022-11-28';
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
      }
      // Fetch's no-store mode bypasses the browser HTTP cache for both API and
      // raw content without custom raw-origin headers that require preflight.
      const response = await this.fetcher(url, { headers, cache: 'no-store', signal: controller.signal, redirect: 'error' });
      const headerLimit = this.rateLimitGate.observe(url, response, '', Boolean(this.token));
      if (headerLimit) {
        try { await response.body?.cancel(); } catch { /* Keep the limit reported by the response headers. */ }
        throw withRateLimit(new LibraryError(rateLimitMessage(headerLimit), response.status), headerLimit);
      }
      const detail = response.status === 403 || response.status === 429 ? await rateLimitResponseDetail(response) : '';
      const limited = response.ok ? undefined : this.rateLimitGate.observe(url, response, detail, Boolean(this.token));
      if (limited) throw withRateLimit(new LibraryError(rateLimitMessage(limited), response.status), limited);
      if (response.status === 404 && missing) return null;
      if (!response.ok) {
        if (response.status === 401) throw new LibraryError(t('GitHub 登录已过期，请重新登录后重试。'), 401);
        if (response.status === 403) throw new LibraryError(t('GitHub 暂时拒绝读取，请检查账号授权或稍后重试。'), 403);
        if (response.status === 404) throw new LibraryError(t('未找到该题单或参考代码，文件可能已被移动，请刷新后重试。'), 404);
        throw new LibraryError(t('GitHub 读取失败（HTTP {{status}}），请稍后重试。', { status: response.status }), response.status);
      }
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes) throw new Error(t('文件过大，客户端只读取不超过 1 MB 的参考代码。'));
      if (!response.body) return '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new Error(t('文件过大，客户端只读取不超过 1 MB 的参考代码。'));
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      if (controller.signal.aborted) throw new LibraryError(t('读取 GitHub 超时，请检查网络连接后重试。'));
      if (error instanceof TypeError) throw new LibraryError(t('无法连接 GitHub，请检查网络或代理设置后重试。'));
      throw error;
    } finally { clearTimeout(timeout); }
  }
  private async api<T>(path: string, missing = false): Promise<T | null> {
    const body = await this.request(`${API}${path}`, 4 * MAX_CODE_BYTES, missing);
    if (body === null) return null;
    try { return JSON.parse(body) as T; } catch { throw new Error(t('GitHub 返回的数据格式异常，请稍后重试。')); }
  }
  private async defaultBranch(): Promise<string> {
    const repo = await this.api<{ default_branch: string }>('');
    if (!repo || typeof repo.default_branch !== 'string' || !repo.default_branch) throw new Error(t('无法识别上游仓库的默认分支。'));
    return repo.default_branch;
  }
  private async revision(branch: string): Promise<string> {
    const reference = await this.api<{ object?: { sha?: string } }>(`/git/ref/heads/${encodeURIComponent(branch)}`);
    const sha = reference?.object?.sha;
    if (typeof sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) throw new Error(t('无法确认题库当前版本，请刷新后重试。'));
    return sha;
  }
  private async directory(path: string, branch: string, missing = false): Promise<DirectoryEntry[]> {
    const entries = await this.api<DirectoryEntry[]>(`/contents/${pathParts(path)}?ref=${encodeURIComponent(branch)}`, missing);
    if (entries === null && missing) return [];
    if (!Array.isArray(entries)) throw new Error(t('GitHub 目录数据异常，请刷新后重试。'));
    if (entries.length < 1000) return entries;
    // Contents has a hard 1000-entry limit and no pagination. Resolve only this
    // directory through nonrecursive Git trees; never load the huge source tree.
    const treeAt = async (ref: string) => {
      const tree = await this.api<TreeResponse>(`/git/trees/${encodeURIComponent(ref)}`);
      if (!tree || tree.truncated || !Array.isArray(tree.tree) || tree.tree.some(entry =>
        typeof entry.path !== 'string' || entry.path.includes('/') || !entry.sha)) {
        throw new Error(t('GitHub 未完整返回目录，已停止使用不完整列表，请稍后刷新重试。'));
      }
      return tree.tree;
    };
    let tree = await treeAt(branch);
    for (const name of path.split('/')) {
      const entry = tree.find(item => item.path === name && item.type === 'tree');
      if (!entry) throw new Error(t('GitHub 目录结构已变化，请刷新后重试。'));
      tree = await treeAt(entry.sha);
    }
    return tree.map(entry => ({ name: entry.path, path: `${path}/${entry.path}`, size: entry.size,
      type: entry.type === 'tree' ? 'dir' : entry.mode === '120000' ? 'symlink' : entry.type === 'blob' ? 'file' : entry.type }));
  }
  private rawUrl(path: string, branch: string): string {
    return `https://raw.githubusercontent.com/${UPSTREAM.owner}/${UPSTREAM.repo}/${encodeURIComponent(branch)}/${pathParts(path)}`;
  }
  private browseUrl(path: string, branch: string): string { return `${UPSTREAM.url}/blob/${encodeURIComponent(branch)}/${pathParts(path)}`; }
  private async datesForMonth(month: string, branch: string): Promise<string[]> {
    const [year, mm] = month.split('-');
    const entries = await this.directory(`daily_problems/${year}/${mm}`, branch);
    const dates = entries.flatMap((entry) => {
      if (entry.type !== 'dir' || !/^\d{4}$/.test(entry.name) || !entry.name.startsWith(mm)) return [];
      try { return [validateDate(`${year}-${mm}-${entry.name.slice(2)}`)]; } catch { return []; }
    }).sort().reverse();
    return dates;
  }

  // The optional refresh arguments remain compatible with callers; all reads
  // are fresh, including calls that omit the argument or pass false.
  async getArchiveMonths(_refresh = false): Promise<ArchiveMonth[]> {
    return (await this.getArchiveSnapshot()).months;
  }

  async getArchiveSnapshot(): Promise<ArchiveSnapshot> {
    const branch = await this.defaultBranch();
    const revision = await this.revision(branch);
    const years = (await this.directory('daily_problems', revision))
      .filter((entry) => entry.type === 'dir' && /^\d{4}$/.test(entry.name) && Number(entry.name) >= 1).map((entry) => entry.name);
    const perYear = await this.map(years, async (year) => (await this.directory(`daily_problems/${year}`, revision))
      .filter((entry) => entry.type === 'dir' && /^(0[1-9]|1[0-2])$/.test(entry.name))
      .map((entry) => `${year}-${entry.name}`));
    // Counting day directories belongs to loading those months. No results
    // from an earlier operation are kept or used to populate these counts.
    const months = perYear.flat().sort().reverse().map((month) => ({ month, days: 0 }));
    return { branch, revision, months };
  }

  async getMonth(value: string, _refresh = false): Promise<ProblemDay[]> {
    const month = monthValue(value);
    const branch = await this.defaultBranch();
    const revision = await this.revision(branch);
    return this.getMonthFromSnapshot(month, { branch, revision, months: [] });
  }

  async getMonthFromSnapshot(value: string, snapshot: ArchiveSnapshot): Promise<ProblemDay[]> {
    const month = monthValue(value);
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.branch !== 'string' || !snapshot.branch ||
      snapshot.branch === '@' || /[\x00-\x20\x7f~^:?*\[\\]/.test(snapshot.branch) ||
      snapshot.branch.includes('..') || snapshot.branch.includes('@{') || snapshot.branch.endsWith('.') ||
      snapshot.branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')) || typeof snapshot.revision !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(snapshot.revision)) {
      throw new Error(t('无法确认题库当前版本，请刷新后重试。'));
    }
    // Only this explicit load uses the supplied immutable revision. Nothing is
    // stored by the library, and every new full load discovers a fresh snapshot.
    const { branch, revision } = snapshot;
    const dates = await this.datesForMonth(month, revision);
    let completed = 0;
    const result = await this.map(dates, async (date): Promise<ProblemDay | null> => {
      const path = `${repositoryDatePath(date)}/problems.md`;
      const markdown = await this.request(this.rawUrl(path, revision), MAX_CODE_BYTES, true);
      const day = markdown === null ? null : {
        date, parserVersion: PARSER_VERSION, problems: parseProblems(markdown, date),
        sourceUrl: this.browseUrl(path, branch), fetchedAt: new Date(this.now()).toISOString(),
      };
      completed++;
      this.options.onProgress?.({ completed, total: dates.length, month });
      return day;
    });
    return result.filter((day): day is ProblemDay => day !== null);
  }

  async getResources(value: string, id: string, _refresh = false): Promise<ProblemResources> {
    const date = validateDate(value);
    const problemId = problemValue(id);
    const branch = await this.defaultBranch();
    const revision = await this.revision(branch);
    const base = repositoryDatePath(date);
    const editorialPath = `${base}/solution/${problemId}.md`;
    const [editorial, files] = await Promise.all([
      this.request(this.rawUrl(editorialPath, revision), MAX_CODE_BYTES, true),
      this.directory(`${base}/personal_submission`, revision, true),
    ]);
    const references: ReferenceFile[] = files.flatMap((entry) => {
      if (entry.type !== 'file' || !entry.name.startsWith(`${problemId}_`) || (entry.size ?? 0) > MAX_CODE_BYTES) return [];
      const path = `${base}/personal_submission/${entry.name}`;
      if (entry.path !== path) return [];
      try {
        const info = referenceInfo(path);
        return [{ name: info.name, path, language: info.language, url: this.browseUrl(path, branch) }];
      } catch { return []; }
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { editorial, editorialUrl: editorial === null ? null : this.browseUrl(editorialPath, branch), references };
  }

  async getReference(path: string, _refresh = false): Promise<string> {
    referenceInfo(path);
    const branch = await this.defaultBranch();
    const revision = await this.revision(branch);
    const text = await this.request(this.rawUrl(path, revision), MAX_CODE_BYTES);
    if (text === null) throw new Error(t('参考代码不存在，请刷新后重试。'));
    if (text.includes('\0')) throw new Error(t('该文件不是可预览的文本代码。'));
    return text;
  }
}
